import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { schema, assertLegacyTrackingAllowed } from "@refref/coredb";
const { participant, referral, refcode } = schema;
import { eq, and } from "drizzle-orm";
import {
  type EventMetadataV1Type,
  signupTrackingRequestSchema,
} from "@refref/types";
import { createEvent } from "../../../services/events.js";
import { normalizeCode } from "@refref/utils";

import { validateProductScope, SecurityError } from "@refref/coredb/security";
import {
  sendReferralError,
  requireReferralJson,
} from "../../../services/referral-http.js";
const signupRequestSchema = signupTrackingRequestSchema;

export default async function signupTrackRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/",
    {
      bodyLimit: 256 * 1024,
      onRequest: [fastify.authenticateApiKey, requireReferralJson],
      schema: {
        body: z.toJSONSchema(signupRequestSchema, {
          io: "input",
          target: "draft-7",
        }),
        response: {
          200: z.toJSONSchema(
            z
              .object({
                success: z.literal(true),
                message: z.string(),
                eventId: z.string(),
              })
              .strict(),
            { target: "draft-7" },
          ),
        },
      },
      validatorCompiler: () => (data) => {
        const result = signupRequestSchema.safeParse(data);
        return result.success
          ? { value: result.data }
          : { error: result.error };
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = signupRequestSchema.parse(request.body);
        await validateProductScope(
          request.db,
          request.organization?.id,
          body.productId,
          body.programId,
        );
        await assertLegacyTrackingAllowed(request.db, body.programId);

        // Use a transaction for the entire signup tracking
        const result = await request.db.transaction(async (tx) => {
          let participantId: string | undefined;
          let referralId: string | undefined;
          let referrerCode: typeof refcode.$inferSelect | undefined;
          if (body.payload.refcode) {
            [referrerCode] = await tx
              .select()
              .from(refcode)
              .where(
                and(
                  eq(refcode.isActive, true),
                  eq(refcode.code, normalizeCode(body.payload.refcode)),
                  eq(refcode.productId, body.productId),
                  body.programId
                    ? eq(refcode.programId, body.programId)
                    : undefined,
                ),
              )
              .limit(1);
            if (!referrerCode)
              throw new SecurityError(
                "Referral code does not match the product and program",
              );
            await validateProductScope(
              tx,
              request.organization?.id,
              body.productId,
              referrerCode.programId,
            );
            await assertLegacyTrackingAllowed(tx, referrerCode.programId);
            const [referrer] = await tx
              .select({ id: participant.id })
              .from(participant)
              .where(
                and(
                  eq(participant.id, referrerCode.participantId),
                  eq(participant.productId, body.productId),
                ),
              )
              .limit(1);
            if (!referrer)
              throw new SecurityError(
                "Referrer does not belong to your product",
              );
          }

          // Check if participant already exists
          const [existingParticipant] = await tx
            .select()
            .from(participant)
            .where(
              and(
                eq(participant.productId, body.productId),
                eq(participant.externalId, body.payload.userId),
              ),
            )
            .limit(1);

          if (existingParticipant) {
            participantId = existingParticipant.id;
          } else {
            // Create new participant within the transaction
            const [newParticipant] = await tx
              .insert(participant)
              .values({
                productId: body.productId,
                externalId: body.payload.userId,
                email: body.payload.email,
                name: body.payload.name,
              })
              .returning();

            participantId = newParticipant?.id;
          }

          // If refcode provided, find referrer and create referral
          if (body.payload.refcode && participantId) {
            // The referral code and all of its relationships were validated before writes.

            if (referrerCode) {
              const [newReferral] = await tx
                .insert(referral)
                .values({
                  referrerId: referrerCode.participantId,
                  programId: referrerCode.programId,
                  externalId: body.payload.userId,
                  email: body.payload.email,
                  name: body.payload.name,
                })
                .onConflictDoNothing()
                .returning();

              if (newReferral) {
                referralId = newReferral.id;
              }
            }
          }

          // Create event metadata
          const metadata: EventMetadataV1Type = {
            schemaVersion: 1,
            source: "api",
          };

          // Return the data needed to create the event
          return {
            participantId,
            referralId,
            metadata,
            programId: body.programId ?? referrerCode?.programId,
          };
        });

        // Create the event using our service (outside transaction)
        const newEvent = await createEvent(request.db, {
          productId: body.productId,
          programId: result.programId,
          eventType: "signup", // Hardcoded for this endpoint
          participantId: result.participantId,
          referralId: result.referralId,
          metadata: result.metadata,
        });

        return reply.send({
          success: true,
          message: "Signup tracked successfully.",
          eventId: newEvent.id,
        });
      } catch (error) {
        request.log.error({ error }, "Signup tracking failed");
        return sendReferralError(reply, error, 500);
      }
    },
  );
}
