import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import { createTRPCRouter, onboardingProcedure } from "@/server/api/trpc";
import {
  ownParticipant,
  participantBalances,
  requestParticipantPayout,
  schema,
} from "@refref/coredb";
import {
  RewardCurrencies,
  currencySchema,
  minorAmountSchema,
} from "@refref/types";
import { TRPCError } from "@trpc/server";
const portalProcedure = onboardingProcedure
  .input(z.object({ userId: z.string().min(1) }))
  .use(({ ctx, input, next }) => {
    if (input.userId !== ctx.userId) throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });
const scope = z
  .object({ userId: z.string().min(1), productId: z.string().min(1) })
  .strict();
export const participantPortalRouter = createTRPCRouter({
  memberships: portalProcedure.query(async ({ ctx }) =>
    ctx.db
      .select({
        productId: schema.participant.productId,
        productName: schema.product.name,
      })
      .from(schema.participant)
      .innerJoin(
        schema.product,
        eq(schema.product.id, schema.participant.productId),
      )
      .where(
        and(
          eq(schema.participant.ownerUserId, ctx.userId),
          sql`${schema.participant.ownershipVerifiedAt} IS NOT NULL`,
        ),
      ),
  ),
  summary: portalProcedure.input(scope).query(async ({ ctx, input }) => {
    const owner = await ownParticipant(ctx.db, ctx.userId, input.productId);
    const balances = await participantBalances(
      ctx.db,
      input.productId,
      owner.id,
      RewardCurrencies,
    );
    const categories = await ctx.db
      .select({
        currency: schema.reward.currency,
        rewardType: schema.reward.rewardType,
        status: schema.reward.status,
        count: sql<number>`count(*)::integer`,
        amount: sql<string>`COALESCE(sum(${schema.reward.amount}),0)::text`,
      })
      .from(schema.reward)
      .innerJoin(schema.program, eq(schema.program.id, schema.reward.programId))
      .where(
        and(
          eq(schema.reward.participantId, owner.id),
          eq(schema.program.productId, input.productId),
        ),
      )
      .groupBy(
        schema.reward.currency,
        schema.reward.rewardType,
        schema.reward.status,
      );
    return {
      productId: input.productId,
      balances,
      categories,
      recipient: owner.payoutRecipient,
    };
  }),
  history: portalProcedure
    .input(
      scope.extend({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const owner = await ownParticipant(ctx.db, ctx.userId, input.productId);
      const rewards = await ctx.db
        .select({
          id: schema.reward.id,
          amount: schema.reward.amount,
          currency: schema.reward.currency,
          status: schema.reward.status,
          rewardType: schema.reward.rewardType,
          createdAt: schema.reward.createdAt,
          eventId: schema.reward.eventId,
        })
        .from(schema.reward)
        .innerJoin(
          schema.program,
          eq(schema.program.id, schema.reward.programId),
        )
        .where(
          and(
            eq(schema.reward.participantId, owner.id),
            eq(schema.program.productId, input.productId),
          ),
        )
        .orderBy(desc(schema.reward.createdAt), schema.reward.id)
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const payouts = await ctx.db
        .select()
        .from(schema.payout)
        .where(
          and(
            eq(schema.payout.productId, input.productId),
            eq(schema.payout.participantId, owner.id),
          ),
        )
        .orderBy(desc(schema.payout.createdAt), schema.payout.id)
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      return { rewards, payouts, page: input.page, pageSize: input.pageSize };
    }),
  requestPayout: portalProcedure
    .input(
      scope
        .extend({
          amountMinor: minorAmountSchema.positive(),
          currency: currencySchema,
          idempotencyKey: z.string().min(1).max(200),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      requestParticipantPayout(ctx.db, ctx.userId, input),
    ),
});
