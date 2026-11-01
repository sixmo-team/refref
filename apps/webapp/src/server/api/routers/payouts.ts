import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import { createTRPCRouter, adminProcedure } from "@/server/api/trpc";
import {
  schema,
  claimPayout,
  completePayout,
  rejectPayout,
  ReferralError,
  ensureReferrerParticipant,
  firstParticipantCode,
} from "@refref/coredb";
import { validateProductScope } from "@refref/coredb/security";
import { currencySchema, minorAmountSchema } from "@refref/types";
import { generateRefcode } from "@refref/utils";

const ownershipProof = z
  .object({
    productId: z.string().min(1),
    ownerUserId: z.string().min(1),
    evidence: z.string().trim().min(1).max(500),
    externalOwnershipVerified: z.literal(true),
  })
  .strict();

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
    .input(ownershipProof.extend({ participantId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      return ctx.db.transaction(async (tx) => {
        const participant = await ensureReferrerParticipant(tx, {
          productId: input.productId,
          ownerUserId: input.ownerUserId,
          actorId: ctx.userId,
          evidence: input.evidence,
          participantId: input.participantId,
        });
        return { participantId: participant.id, verified: true };
      });
    }),
  enrollReferrer: adminProcedure
    .input(ownershipProof.extend({ programId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
        input.programId,
      );
      return ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select({ status: schema.program.status })
          .from(schema.program)
          .where(
            and(
              eq(schema.program.id, input.programId),
              eq(schema.program.productId, input.productId),
            ),
          )
          .for("share");
        if (program?.status !== "active")
          throw new ReferralError(
            "REFERRAL_CODE_INACTIVE",
            409,
            "Enroll referrers only after the program is active",
          );
        const participant = await ensureReferrerParticipant(tx, {
          productId: input.productId,
          ownerUserId: input.ownerUserId,
          actorId: ctx.userId,
          evidence: input.evidence,
        });
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = generateRefcode();
          if (!code) break;
          try {
            return await firstParticipantCode(tx, {
              productId: input.productId,
              programId: input.programId,
              participantId: participant.id,
              code,
            });
          } catch (error) {
            if (
              !(error instanceof ReferralError) ||
              error.code !== "REFERRAL_CODE_TAKEN"
            )
              throw error;
          }
        }
        throw new ReferralError(
          "REFERRAL_UNAVAILABLE",
          503,
          "Referral code generation unavailable",
        );
      });
    }),
});
