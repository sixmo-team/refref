import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import { createTRPCRouter, adminProcedure } from "@/server/api/trpc";
import {
  schema,
  claimPayout,
  completePayout,
  rejectPayout,
  ReferralError,
} from "@refref/coredb";
import { validateProductScope } from "@refref/coredb/security";
import { currencySchema, minorAmountSchema } from "@refref/types";
const scopedPayout = z
  .object({ productId: z.string().min(1), payoutId: z.string().min(1) })
  .strict();
export const payoutsRouter = createTRPCRouter({
  list: adminProcedure
    .input(
      z
        .object({
          userId: z.string().min(1),
          organizationId: z.string().min(1),
          productId: z.string().min(1),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(100).default(20),
          status: z
            .enum(["requested", "processing", "completed", "rejected"])
            .optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      if (
        input.userId !== ctx.userId ||
        input.organizationId !== ctx.activeOrganizationId
      )
        throw new ReferralError("FORBIDDEN", 403, "Session scope differs");
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      const where = and(
        eq(schema.payout.productId, input.productId),
        input.status ? eq(schema.payout.status, input.status) : undefined,
      );
      const [count] = await ctx.db
        .select({ total: sql<number>`count(*)::integer` })
        .from(schema.payout)
        .where(where);
      const data = await ctx.db
        .select()
        .from(schema.payout)
        .where(where)
        .orderBy(desc(schema.payout.createdAt), schema.payout.id)
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      return { data, total: count?.total ?? 0 };
    }),
  claim: adminProcedure.input(scopedPayout).mutation(async ({ ctx, input }) => {
    await validateProductScope(
      ctx.db,
      ctx.activeOrganizationId,
      input.productId,
    );
    return claimPayout(
      ctx.db,
      ctx.userId,
      input.productId,
      input.payoutId,
      process.env.PAYOUT_MANUAL_EXECUTION_NAMESPACE ?? "",
    );
  }),
  confirmPaid: adminProcedure
    .input(
      scopedPayout
        .extend({
          externalReference: z.string().trim().min(1).max(200),
          amountMinor: minorAmountSchema.positive(),
          currency: currencySchema,
          completedAt: z.string().datetime(),
          idempotencyKey: z.string().min(1).max(200),
          paymentAndNoRefundVerified: z.literal(true),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      return completePayout(ctx.db, ctx.userId, input);
    }),
  reject: adminProcedure
    .input(
      scopedPayout
        .extend({
          reason: z.string().trim().min(1).max(500),
          transferNotExecutedVerified: z.boolean(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      return rejectPayout(ctx.db, ctx.userId, input);
    }),
  verifyOwnership: adminProcedure
    .input(
      z
        .object({
          productId: z.string().min(1),
          participantId: z.string().min(1),
          ownerUserId: z.string().min(1),
          evidence: z.string().trim().min(1).max(500),
          externalOwnershipVerified: z.literal(true),
          recipient: z
            .object({
              name: z.string().trim().min(1).max(200),
              details: z.string().trim().min(1).max(1000),
            })
            .strict(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      return ctx.db.transaction(async (tx) => {
        const [participant] = await tx
          .select()
          .from(schema.participant)
          .where(
            and(
              eq(schema.participant.id, input.participantId),
              eq(schema.participant.productId, input.productId),
            ),
          )
          .for("update");
        const [owner] = await tx
          .select({
            verified: schema.user.emailVerified,
            role: schema.user.role,
          })
          .from(schema.user)
          .where(eq(schema.user.id, input.ownerUserId));
        if (
          !participant ||
          !owner?.verified ||
          owner.role === "service" ||
          !participant.externalId
        )
          throw new ReferralError(
            "FORBIDDEN",
            403,
            "Existing externally identified participant and verified RefRef person account required",
          );
        if (participant.ownerUserId) {
          if (
            participant.ownerUserId === input.ownerUserId &&
            participant.ownershipEvidence === input.evidence &&
            participant.payoutRecipient?.name === input.recipient.name &&
            participant.payoutRecipient?.details === input.recipient.details
          )
            return { participantId: participant.id, verified: true };
          throw new ReferralError(
            "OWNERSHIP_CONFLICT",
            409,
            "Verified financial ownership cannot be reassigned through this API",
          );
        }
        await tx
          .update(schema.participant)
          .set({
            ownerUserId: input.ownerUserId,
            ownershipVerifiedBy: ctx.userId,
            ownershipVerifiedAt: new Date(),
            ownershipEvidence: input.evidence,
            payoutRecipient: {
              ...input.recipient,
              verifiedBy: ctx.userId,
              verifiedAt: new Date().toISOString(),
            },
          })
          .where(eq(schema.participant.id, participant.id));
        return { participantId: participant.id, verified: true };
      });
    }),
});
