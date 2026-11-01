import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { schema } from "@refref/coredb";
const { participant, refcode, referral } = schema;
import { createId } from "@refref/id";
import {
  widgetInitRequestSchema,
  type WidgetInitResponseType,
} from "@refref/types";
import { createEvent } from "../../../services/events.js";
import { generateRefcode, normalizeCode } from "@refref/utils";

import { validateEventScope, SecurityError } from "@refref/coredb/security";
export default async function widgetInitRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/widget/init
   * Initialize widget session with JWT authentication
   */
  fastify.post(
    "/init",
    {
      preHandler: [fastify.authenticateJWT],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Parse and validate request body
        const body = widgetInitRequestSchema.parse(request.body);
        const { productId, refcode: refcodeParam } = body;

        // Verify user is authenticated
        if (!request.user) {
          return reply.code(401).send({
            error: "Unauthorized",
            message: "Authentication required",
          });
        }

        // Verify productId matches JWT
        if (request.user.productId !== productId) {
          return reply.code(403).send({
            error: "Forbidden",
            message: "Product ID mismatch",
          });
        }

        // Ensure there is an active program for this product
        const activeProgram = await request.db.query.program.findFirst({
          where: (program, { eq, and }) =>
            and(eq(program.productId, productId), eq(program.status, "active")),
          orderBy: (program, { asc }) => [asc(program.createdAt)],
        });

        if (!activeProgram) {
          return reply.code(400).send({
            error: "Bad Request",
            message: "No active program found for this product",
          });
        }
        const referrerCode = refcodeParam
          ? await request.db.query.refcode.findFirst({
              where: (code, { eq, and }) =>
                and(
                  eq(code.code, normalizeCode(refcodeParam)),
                  eq(code.isActive, true),
                  eq(code.productId, productId),
                  eq(code.programId, activeProgram.id),
                ),
            })
          : undefined;
        if (refcodeParam && !referrerCode) {
          return reply.code(403).send({
            error: "Forbidden",
            message: "Referral code does not match the product and program",
          });
        }
        if (referrerCode) {
          await validateEventScope(request.db, {
            productId,
            programId: activeProgram.id,
            participantId: referrerCode.participantId,
          });
        }

        // Check if participant already exists
        const existingParticipant =
          await request.db.query.participant.findFirst({
            where: (participant, { eq, and }) =>
              and(
                eq(participant.productId, productId),
                eq(participant.externalId, request.user!.sub),
              ),
          });

        // Upsert participant
        const [participantRecord] = await request.db
          .insert(participant)
          .values({
            externalId: request.user.sub,
            productId,
            email: request.user.email,
            name: request.user.name,
          })
          .onConflictDoUpdate({
            target: [participant.productId, participant.externalId],
            set: {
              email: request.user.email,
              name: request.user.name,
            },
          })
          .returning();

        if (!participantRecord) {
          return reply.code(500).send({
            error: "Internal Server Error",
            message: "Failed to create or find participant",
          });
        }

        // Auto-attribution: Create referral if refcode provided and participant is new
        let referralRecordId: string | null = null;
        if (
          refcodeParam &&
          !existingParticipant &&
          !activeProgram.config?.serverTracking &&
          !activeProgram.config?.rewardConfig?.firstPaidOnly
        ) {
          try {
            if (referrerCode) {
              // Create referral record linking the new participant (referee) to the referrer
              const referralId = createId("referral");
              const [newReferral] = await request.db
                .insert(referral)
                .values({
                  id: referralId,
                  referrerId: referrerCode.participantId,
                  programId: activeProgram.id,
                  externalId: request.user.sub,
                  email: request.user.email,
                  name: request.user.name,
                })
                .onConflictDoNothing() // Prevent duplicate referrals
                .returning();

              if (newReferral) {
                referralRecordId = newReferral.id;
                request.log.info("Auto-attribution successful");

                // Create signup event for reward processing
                try {
                  await createEvent(request.db, {
                    productId,
                    programId: activeProgram.id,
                    eventType: "signup",
                    participantId: participantRecord.id,
                    referralId: referralRecordId,
                    metadata: {
                      schemaVersion: 1,
                      source: "auto",
                      reason: "Widget initialization with referral code",
                    },
                  });
                  request.log.info(
                    "Created signup event for referral attribution",
                  );
                } catch (eventError) {
                  request.log.error(
                    { error: eventError },
                    "Failed to create signup event",
                  );
                  // Don't fail widget init if event creation fails
                }
              }
            } else {
              request.log.warn("Referral code not found");
            }
          } catch (error) {
            // Log but don't fail widget init on attribution errors
            request.log.error({ error }, "Auto-attribution failed");
          }
        }

        // Get or create refcode (global code by default)
        // If multiple refcodes exist, get the most recent one
        let refcodeRecord = await request.db.query.refcode.findFirst({
          where: (refcode, { eq, and }) =>
            and(
              eq(refcode.participantId, participantRecord.id),
              eq(refcode.programId, activeProgram.id),
            ),
          orderBy: (refcode, { desc }) => [desc(refcode.createdAt)],
        });

        if (!refcodeRecord) {
          // Generate global code with profanity filtering (up to 5 attempts)
          let currentCode = generateRefcode(5);

          if (!currentCode) {
            return reply.code(500).send({
              error: "Internal Server Error",
              message:
                "Failed to generate unique refcode after multiple attempts",
            });
          }

          // Try to insert the refcode
          let insertRetries = 3;
          while (insertRetries > 0 && !refcodeRecord) {
            try {
              const [newRefcode] = await request.db
                .insert(refcode)
                .values({
                  id: createId("refcode"),
                  code: currentCode,
                  participantId: participantRecord.id,
                  programId: activeProgram.id,
                  productId: productId,
                })
                .onConflictDoNothing()
                .returning();

              refcodeRecord = newRefcode;

              if (!refcodeRecord) {
                insertRetries--;
                request.log.warn(
                  "Refcode collision on insert, retrying with new code",
                );

                // Generate a new code for next retry
                const newCode = generateRefcode(5);
                if (!newCode) {
                  break;
                }
                // Actually use the new code in the next iteration
                currentCode = newCode;
              }
            } catch (error) {
              insertRetries--;
              request.log.error({ error }, "Error inserting refcode");
              if (insertRetries === 0) {
                throw error;
              }
            }
          }
        }

        if (!refcodeRecord) {
          return reply.code(500).send({
            error: "Internal Server Error",
            message: "Failed to create or find refcode",
          });
        }

        // Get program widget config
        const programData = await request.db.query.program.findFirst({
          where: (program, { eq }) => eq(program.id, activeProgram.id),
        });

        const widgetData = programData?.config?.widgetConfig;

        // Get REFERRAL_HOST_URL from environment
        const referralHostUrl =
          process.env.REFERRAL_HOST_URL || "http://localhost:3002";

        if (!widgetData) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Widget configuration not found for this program.",
          });
        }

        // Build referral URL (all refcodes now use the direct /:code pattern)
        const referralUrl = `${referralHostUrl}/${refcodeRecord.code}`;

        // Return the widget configuration
        const response: WidgetInitResponseType = {
          ...widgetData,
          referralLink: referralUrl,
        };

        return reply.send(response);
      } catch (error) {
        if (error instanceof SecurityError) {
          return reply
            .code(error.statusCode)
            .send({ error: "Forbidden", message: error.message });
        }
        request.log.error({ error }, "Error in widget init");

        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Bad Request",
            message: "Invalid request body",
            details: error.issues,
          });
        }

        return reply.code(500).send({
          error: "Internal Server Error",
          message: "An unexpected error occurred",
        });
      }
    },
  );
}
