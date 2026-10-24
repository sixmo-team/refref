import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { db, schema } from "@/server/db";
import { eq, and, sql, desc, gte, lte, lt, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

const { program: programTable, participant, referral, product } = schema;
const dayMs = 86_400_000;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !value.startsWith("0000-") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const analyticsRouter = createTRPCRouter({
  getStats: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: programId }) => {
      // Verify program belongs to active product
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.id, programId),
            eq(programTable.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Program not found",
        });
      }

      // Get participant count for this product
      const [participantStats] = await ctx.db
        .select({
          total: count(),
        })
        .from(participant)
        .where(eq(participant.productId, program.productId));

      // Get referral count for this program
      const [referralStats] = await ctx.db
        .select({
          total: count(),
        })
        .from(referral)
        .innerJoin(participant, eq(participant.id, referral.referrerId))
        .where(and(eq(participant.productId, program.productId), eq(referral.programId, programId)));

      // Calculate trends (compare last 30 days vs previous 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      // Recent referrals (last 30 days)
      const [recentReferrals] = await ctx.db
        .select({ count: count() })
        .from(referral)
        .innerJoin(participant, eq(participant.id, referral.referrerId))
        .where(
          and(
            eq(participant.productId, program.productId),
            eq(referral.programId, programId),
            gte(referral.createdAt, thirtyDaysAgo),
          ),
        );

      // Previous referrals (30-60 days ago)
      const [previousReferrals] = await ctx.db
        .select({ count: count() })
        .from(referral)
        .innerJoin(participant, eq(participant.id, referral.referrerId))
        .where(
          and(
            eq(participant.productId, program.productId),
            eq(referral.programId, programId),
            gte(referral.createdAt, sixtyDaysAgo),
            lte(referral.createdAt, thirtyDaysAgo),
          ),
        );

      // Recent participants
      const [recentParticipants] = await ctx.db
        .select({ count: count() })
        .from(participant)
        .where(
          and(
            eq(participant.productId, program.productId),
            gte(participant.createdAt, thirtyDaysAgo),
          ),
        );

      // Previous participants
      const [previousParticipants] = await ctx.db
        .select({ count: count() })
        .from(participant)
        .where(
          and(
            eq(participant.productId, program.productId),
            gte(participant.createdAt, sixtyDaysAgo),
            lte(participant.createdAt, thirtyDaysAgo),
          ),
        );

      // Calculate trend percentages
      const referralTrend = previousReferrals?.count
        ? (((recentReferrals?.count || 0) - previousReferrals.count) /
            previousReferrals.count) *
          100
        : 0;

      const participantTrend = previousParticipants?.count
        ? (((recentParticipants?.count || 0) - previousParticipants.count) /
            previousParticipants.count) *
          100
        : 0;

      return {
        referrals: {
          total: referralStats?.total || 0,
          trend: referralTrend,
          trendDirection: referralTrend >= 0 ? "up" : ("down" as const),
        },
        participants: {
          total: participantStats?.total || 0,
          trend: participantTrend,
          trendDirection: participantTrend >= 0 ? "up" : ("down" as const),
        },
      };
    }),

  getTimeSeriesData: protectedProcedure
    .input(
      z.object({
        programId: z.string(),
        days: z.number().int().min(1).max(365).optional(),
        startDate: dateOnly.optional(),
        endDate: dateOnly.optional(),
      }).superRefine((input, ctx) => {
        if ((input.startDate === undefined) !== (input.endDate === undefined)) {
          ctx.addIssue({ code: "custom", message: "Supply both date boundaries" });
        }
        if (input.startDate && input.endDate) {
          const span = Date.parse(input.endDate) - Date.parse(input.startDate);
          if (!Number.isFinite(span) || span < 0 || span >= 365 * dayMs) {
            ctx.addIssue({ code: "custom", message: "Date range must contain 1 to 365 inclusive days" });
          }
        }
      }),
    )
    .query(async ({ ctx, input }) => {
      // Verify program belongs to active product
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.id, input.programId),
            eq(programTable.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Program not found",
        });
      }

      // Use date range if provided, otherwise fall back to days
      let startDate: Date;
      let endDate: Date;

      if (input.startDate && input.endDate) {
        startDate = new Date(`${input.startDate}T00:00:00.000Z`);
        endDate = new Date(`${input.endDate}T00:00:00.000Z`);
      } else {
        const days = input.days ?? 30;
        endDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
        startDate = new Date(endDate.getTime() - (days - 1) * dayMs);
      }

      // Get daily referral counts
      const dailyReferrals = await ctx.db
        .select({
          date: sql<string | null>`DATE(${referral.createdAt})`,
          count: count(),
        })
        .from(referral)
        .innerJoin(participant, eq(participant.id, referral.referrerId))
        .where(
          and(
            eq(participant.productId, program.productId),
            eq(referral.programId, input.programId),
            gte(referral.createdAt, startDate),
            lt(referral.createdAt, new Date(endDate.getTime() + dayMs)),
          ),
        )
        .groupBy(sql`DATE(${referral.createdAt})`)
        .orderBy(sql`DATE(${referral.createdAt})`);

      // Fill in missing dates with 0 counts
      const dateMap = new Map(
        dailyReferrals
          .filter((d) => d.date !== null)
          .map((d) => [d.date as string, d.count]),
      );

      const result: Array<{ date: string; referrals: number }> = [];
      const current = new Date(startDate);

      while (current <= endDate) {
        const dateStr = current.toISOString().split("T")[0];
        if (dateStr) {
          result.push({
            date: dateStr,
            referrals: dateMap.get(dateStr) || 0,
          });
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }

      return result;
    }),

  getTopParticipants: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: programId }) => {
      // Verify program belongs to active product
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.id, programId),
            eq(programTable.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Program not found",
        });
      }

      // Get top participants by referral count
      const topParticipants = await ctx.db
        .select({
          id: participant.id,
          name: participant.name,
          email: participant.email,
          referralCount: count(referral.id),
        })
        .from(participant)
        .leftJoin(referral, and(eq(referral.referrerId, participant.id), eq(referral.programId, programId)))
        .where(eq(participant.productId, program.productId))
        .groupBy(participant.id, participant.name, participant.email)
        .orderBy(desc(count(referral.id)))
        .limit(5);

      return topParticipants.map((p) => ({
        id: p.id,
        name: p.name || "Anonymous",
        email: p.email || "",
        referralCount: p.referralCount,
      }));
    }),
});
