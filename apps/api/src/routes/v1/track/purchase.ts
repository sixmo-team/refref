import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  schema,
  recordMinorPurchase,
  assertLegacyTrackingAllowed,
  ReferralError,
} from "@refref/coredb";
import { and, eq } from "drizzle-orm";
import {
  legacyPurchaseRequestSchema,
  minorPurchaseRequestSchema,
  minorPurchaseResponseSchema,
  type EventMetadataV1Type,
} from "@refref/types";
import { createEvent } from "../../../services/events.js";
import { validateProductScope } from "@refref/coredb/security";
import {
  authorizeReferralScope,
  sendReferralError,
  requireReferralJson,
} from "../../../services/referral-http.js";
const purchaseRequestSchema = z.union([
  minorPurchaseRequestSchema,
  legacyPurchaseRequestSchema,
]);
export default async function purchaseTrackRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/",
    {
      bodyLimit: 256 * 1024,
      onRequest: [fastify.authenticateApiKey, requireReferralJson],
      schema: {
        body: z.toJSONSchema(purchaseRequestSchema, {
          io: "input",
          target: "draft-7",
        }),
        response: {
          200: z.toJSONSchema(
            z.union([
              minorPurchaseResponseSchema,
              z
                .object({
                  success: z.literal(true),
                  message: z.string(),
                  eventId: z.string(),
                })
                .strict(),
            ]),
            { target: "draft-7" },
          ),
        },
      },
      validatorCompiler: () => (data) => {
        const result = purchaseRequestSchema.safeParse(data);
        return result.success
          ? { value: result.data }
          : { error: result.error };
      },
    },
    async (request, reply) => {
      let unexpectedStatusCode: 500 | 503 = 500;
      try {
        const body = purchaseRequestSchema.parse(request.body);
        if ("orderAmountMinor" in body.payload) {
          unexpectedStatusCode = 503;
          const minor = minorPurchaseRequestSchema.parse(body);
          await authorizeReferralScope(
            request,
            minor.productId,
            minor.programId,
            "purchase",
          );
          return reply.send(await recordMinorPurchase(request.db, minor));
        }
        if (request.apiKey?.metadata?.referralScope)
          throw new ReferralError(
            "FORBIDDEN",
            403,
            "Dedicated referral keys require the minor purchase contract",
          );
        const legacy = legacyPurchaseRequestSchema.parse(body);
        await validateProductScope(
          request.db,
          request.organization?.id,
          legacy.productId,
          legacy.programId,
        );
        await assertLegacyTrackingAllowed(request.db, legacy.programId);
        const { participant, referral } = schema;
        const result = await request.db.transaction(async (tx) => {
          const [buyer] = await tx
            .select()
            .from(participant)
            .where(
              and(
                eq(participant.productId, legacy.productId),
                eq(participant.externalId, legacy.payload.userId),
              ),
            )
            .limit(1);
          const [attribution] = buyer
            ? await tx
                .select({ referral })
                .from(referral)
                .innerJoin(participant, eq(participant.id, referral.referrerId))
                .where(
                  and(
                    eq(referral.externalId, legacy.payload.userId),
                    eq(participant.productId, legacy.productId),
                    legacy.programId
                      ? eq(referral.programId, legacy.programId)
                      : undefined,
                  ),
                )
                .limit(1)
            : [];
          const metadata: EventMetadataV1Type = {
            schemaVersion: 1,
            source: "api",
            orderAmount: legacy.payload.orderAmount,
            orderId: legacy.payload.orderId,
            productIds: legacy.payload.productIds,
            customData: {
              userId: legacy.payload.userId,
              currency: legacy.payload.currency,
            },
          };
          return {
            participantId: buyer?.id,
            referralId: attribution?.referral.id,
            metadata,
          };
        });
        const event = await createEvent(request.db, {
          attributionFromExternalId: true,
          productId: legacy.productId,
          programId: legacy.programId,
          eventType: "purchase",
          ...result,
        });
        return reply.send({
          success: true,
          message: "Purchase tracked successfully.",
          eventId: event.id,
        });
      } catch (error) {
        request.log.error({ error }, "Purchase tracking failed");
        return sendReferralError(reply, error, unexpectedStatusCode);
      }
    },
  );
}
