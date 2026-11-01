import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import { createTRPCRouter, onboardingProcedure } from "@/server/api/trpc";
import {
  ownParticipant,
  participantBalances,
  requestParticipantPayout,
  schema,
  partnerParticipation,
  joinPartnerProgram,
  partnerCodeAvailability,
  createPartnerCode,
  setPartnerCodeActive,
  partnerCodeStats,
} from "@refref/coredb";
import {
  RewardCurrencies,
  currencySchema,
  minorAmountSchema,
  inputRefcodeSchema,
  payoutRecipientInputSchema,
} from "@refref/types";
import { TRPCError } from "@trpc/server";
import { generateRefcode, validateRefcode } from "@refref/utils";
const portalProcedure = onboardingProcedure
  .input(z.object({ userId: z.string().min(1) }))
  .use(async ({ ctx, input, next }) => {
    if (input.userId !== ctx.userId) throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });
const scope = z
  .object({ userId: z.string().min(1), productId: z.string().min(1) })
  .strict();
const programScope = z
  .object({ userId: z.string().min(1), programId: z.string().min(1).max(200) })
  .strict();
const newCodeInput = inputRefcodeSchema.refine(
  (code) => validateRefcode(code).isValid,
  "Этот текст промокода недопустим.",
);
export const participantPortalRouter = createTRPCRouter({
  participation: portalProcedure
    .input(programScope)
    .query(async ({ ctx, input }) => {
      const participation = await partnerParticipation(
        ctx.db,
        ctx.userId,
        input.programId,
      );
      return {
        ...participation,
        suggestedCode:
          participation.state === "join" && !participation.codes.length
            ? generateRefcode()
            : null,
      };
    }),
  join: portalProcedure
    .input(
      programScope
        .extend({
          termsId: z.string().min(1),
          acceptRules: z.literal(true),
          code: newCodeInput,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      joinPartnerProgram(ctx.db, ctx.userId, input),
    ),
  codeAvailability: portalProcedure
    .input(programScope.extend({ code: newCodeInput }).strict())
    .query(({ ctx, input }) =>
      partnerCodeAvailability(ctx.db, ctx.userId, input),
    ),
  createCode: portalProcedure
    .input(programScope.extend({ code: newCodeInput }).strict())
    .mutation(({ ctx, input }) => createPartnerCode(ctx.db, ctx.userId, input)),
  setCodeActive: portalProcedure
    .input(
      scope
        .extend({
          codeId: z.string().min(1),
          isActive: z.boolean(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      setPartnerCodeActive(ctx.db, ctx.userId, input),
    ),
  codeStats: portalProcedure
    .input(scope.extend({ from: z.date(), to: z.date() }).strict())
    .query(({ ctx, input }) => partnerCodeStats(ctx.db, ctx.userId, input)),
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
    const codes = await ctx.db
      .select({
        codeId: schema.refcode.id,
        code: schema.refcode.code,
        isActive: schema.refcode.isActive,
        programId: schema.program.id,
        programName: schema.program.name,
        programStatus: schema.program.status,
        selfServiceEnabled: sql<boolean>`COALESCE(${schema.program.config}#>'{selfService,enabled}'='true'::jsonb,false)`,
        currentTermsId: sql<
          string | null
        >`${schema.program.config}#>>'{selfService,termsId}'`,
      })
      .from(schema.refcode)
      .innerJoin(
        schema.program,
        eq(schema.program.id, schema.refcode.programId),
      )
      .where(
        and(
          eq(schema.refcode.participantId, owner.id),
          eq(schema.refcode.productId, input.productId),
          eq(schema.program.productId, input.productId),
        ),
      )
      .orderBy(schema.program.name, schema.refcode.id);
    const acceptedRules = await ctx.db
      .select({
        termsId: schema.programTerms.id,
        programId: schema.program.id,
        programName: schema.program.name,
        acceptedAt: schema.programAcceptance.createdAt,
      })
      .from(schema.programAcceptance)
      .innerJoin(
        schema.programTerms,
        eq(schema.programTerms.id, schema.programAcceptance.termsId),
      )
      .innerJoin(
        schema.program,
        eq(schema.program.id, schema.programAcceptance.programId),
      )
      .where(
        and(
          eq(schema.programAcceptance.userId, ctx.userId),
          eq(schema.programAcceptance.participantId, owner.id),
          eq(schema.programAcceptance.productId, input.productId),
        ),
      )
      .orderBy(
        desc(schema.programAcceptance.createdAt),
        schema.programAcceptance.id,
      );
    return {
      productId: input.productId,
      balances,
      codes,
      categories,
      acceptedRules,
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
          recipient: payoutRecipientInputSchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      requestParticipantPayout(ctx.db, ctx.userId, input),
    ),
});
