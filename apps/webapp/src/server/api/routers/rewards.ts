import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  adminProcedure,
} from "@/server/api/trpc";
import { schema } from "@/server/db";
const {
  reward: rewardTable,
  participant,
  participantProfileColumns,
  program: programTable,
  rewardRule,
  event: eventTable,
  eventDefinition,
} = schema;
import { and, eq, ilike, sql, desc, asc, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  updateRewardApproval,
  markLegacyRewardDisbursed,
} from "@refref/coredb";
import { validateProductScope } from "@refref/coredb/security";

export const rewardsRouter = createTRPCRouter({
  /**
   * Fetch paginated, filtered, and sorted rewards.
   * Input: page, pageSize, filter (search), sort (field, direction)
   * Output: { data: Reward[], total: number }
   */
  getAll: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1),
        pageSize: z.number().int().min(1).max(100),
        scope: z
          .object({
            organizationId: z.string().min(1),
            productId: z.string().min(1),
            userId: z.string().min(1),
          })
          .strict(),
        filters: z
          .array(
            z.object({
              id: z.string(),
              value: z.union([z.string(), z.array(z.string())]),
              variant: z.string(),
              operator: z.string(),
            }),
          )
          .optional(),
        sort: z
          .object({
            field: z.enum([
              "rewardType",
              "amount",
              "currency",
              "status",
              "createdAt",
              "disbursedAt",
            ]), // Add more sortable fields as needed
            direction: z.enum(["asc", "desc"]),
          })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, filters, sort } = input;
      if (
        input.scope.organizationId !== ctx.activeOrganizationId ||
        input.scope.userId !== ctx.userId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.scope.productId,
      );

      // Build where clause for all filters
      const whereConditions = [];

      if (filters && filters.length > 0) {
        filters.forEach((filter) => {
          // Filter by rewardType
          if (
            filter.id === "rewardType" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              ilike(rewardTable.rewardType, `%${filter.value}%`),
            );
          }
          // Filter by status
          if (
            filter.id === "status" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              ilike(rewardTable.status, `%${filter.value}%`),
            );
          }
          // Filter by currency
          if (
            filter.id === "currency" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              ilike(rewardTable.currency, `%${filter.value}%`),
            );
          }
        });
      }

      // Use the same authorized product predicate for both count and rows.
      // Join with program to check product ownership
      const productFilter = sql`${rewardTable.programId} IN (
        SELECT id FROM ${programTable} 
        WHERE ${programTable.productId} = ${input.scope.productId}
      )`;
      whereConditions.push(productFilter);

      const where =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

      // Map sort field to column
      const sortFieldMap = {
        rewardType: rewardTable.rewardType,
        amount: rewardTable.amount,
        currency: rewardTable.currency,
        status: rewardTable.status,
        createdAt: rewardTable.createdAt,
        disbursedAt: rewardTable.disbursedAt,
      };

      const orderByColumn = sort
        ? sortFieldMap[sort.field]
        : rewardTable.createdAt;
      const orderByDirection = sort?.direction ?? "desc";

      // Get total count
      const [totalResult] = await ctx.db
        .select({ count: count() })
        .from(rewardTable)
        .where(where);

      const total = totalResult?.count ?? 0;

      // Get paginated data with related information
      const rewards = await ctx.db
        .select({
          reward: rewardTable,
          participant: {
            ...participantProfileColumns,
            ownerUserId: participant.ownerUserId,
          },
          program: programTable,
          rewardRule: rewardRule,
          event: eventTable,
          eventDefinition: eventDefinition,
        })
        .from(rewardTable)
        .leftJoin(participant, eq(rewardTable.participantId, participant.id))
        .leftJoin(programTable, eq(rewardTable.programId, programTable.id))
        .leftJoin(rewardRule, eq(rewardTable.rewardRuleId, rewardRule.id))
        .leftJoin(eventTable, eq(rewardTable.eventId, eventTable.id))
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .where(where)
        .orderBy(
          orderByDirection === "desc"
            ? desc(orderByColumn)
            : asc(orderByColumn),
          asc(rewardTable.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      // Format the response
      const data = rewards.map((row) => ({
        id: row.reward.id,
        productId: row.program?.productId ?? "",
        eventId: row.reward.eventId,
        payoutManaged:
          row.reward.rewardType === "cash" &&
          (!!row.participant?.ownerUserId ||
            !!row.program?.config?.serverTracking ||
            !!row.program?.config?.rewardConfig?.firstPaidOnly),
        eventType: row.eventDefinition?.type,
        participantId: row.reward.participantId,
        participantEmail: row.participant?.email,
        participantExternalId: row.participant?.externalId,
        participantName: row.participant?.name,
        programId: row.reward.programId,
        programName: row.program?.name,
        rewardType: row.reward.rewardType,
        amount: row.reward.amount,
        currency: row.reward.currency,
        status: row.reward.status,
        disbursedAt: row.reward.disbursedAt,
        createdAt: row.reward.createdAt,
        updatedAt: row.reward.updatedAt,
        metadata: row.reward.metadata,
        ruleName: row.rewardRule?.name,
      }));

      return { data, total };
    }),

  updateApprovalStatus: adminProcedure
    .input(
      z
        .object({
          productId: z.string().min(1),
          rewardId: z.string(),
          status: z.enum(["approved", "rejected", "pending_disbursal"]),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      const reward = await updateRewardApproval(
        ctx.db,
        input.productId,
        input.rewardId,
        input.status,
      );
      return {
        success: true,
        rewardId: reward.id,
        status: reward.status,
        reward,
      };
    }),

  markAsDisbursed: adminProcedure
    .input(
      z.object({ productId: z.string().min(1), rewardId: z.string() }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      const reward = await markLegacyRewardDisbursed(
        ctx.db,
        input.productId,
        input.rewardId,
      );
      return {
        success: true,
        rewardId: reward.id,
        status: reward.status,
        disbursedAt: reward.disbursedAt,
        reward,
      };
    }),

  // Get reward by ID
  getById: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: rewardId }) => {
      const [rewardData] = await ctx.db
        .select({
          reward: rewardTable,
          participant: participantProfileColumns,
          program: programTable,
          rewardRule: rewardRule,
          event: eventTable,
        })
        .from(rewardTable)
        .leftJoin(participant, eq(rewardTable.participantId, participant.id))
        .leftJoin(programTable, eq(rewardTable.programId, programTable.id))
        .leftJoin(rewardRule, eq(rewardTable.rewardRuleId, rewardRule.id))
        .leftJoin(eventTable, eq(rewardTable.eventId, eventTable.id))
        .where(eq(rewardTable.id, rewardId))
        .limit(1);

      if (!rewardData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Reward not found",
        });
      }

      // Verify reward belongs to user's product
      if (rewardData.program?.productId !== ctx.activeProductId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Reward does not belong to your product",
        });
      }

      return {
        ...rewardData.reward,
        participant: rewardData.participant,
        program: rewardData.program,
        rewardRule: rewardData.rewardRule,
        event: rewardData.event,
      };
    }),

  // Get rewards by participant
  getByParticipant: protectedProcedure
    .input(
      z.object({
        participantId: z.string(),
        page: z.number().min(1).default(1),
        pageSize: z.number().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { participantId, page, pageSize } = input;

      // Verify participant belongs to user's product
      const [participantRecord] = await ctx.db
        .select()
        .from(participant)
        .where(
          and(
            eq(participant.id, participantId),
            eq(participant.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!participantRecord) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Participant not found or does not belong to your product",
        });
      }

      // Get total count
      const [totalResult] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(rewardTable)
        .where(eq(rewardTable.participantId, participantId));

      const total = totalResult?.count ?? 0;

      // Get paginated rewards
      const rewards = await ctx.db
        .select({
          reward: rewardTable,
          program: programTable,
          rewardRule: rewardRule,
          event: eventTable,
        })
        .from(rewardTable)
        .leftJoin(programTable, eq(rewardTable.programId, programTable.id))
        .leftJoin(rewardRule, eq(rewardTable.rewardRuleId, rewardRule.id))
        .leftJoin(eventTable, eq(rewardTable.eventId, eventTable.id))
        .where(eq(rewardTable.participantId, participantId))
        .orderBy(desc(rewardTable.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        data: rewards.map((row) => ({
          ...row.reward,
          program: row.program,
          rewardRule: row.rewardRule,
          event: row.event,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }),

  // Get reward statistics for a program
  getStatsByProgram: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: programId }) => {
      // Authorize through the identified program's actual product.
      const [program] = await ctx.db
        .select({ id: programTable.id })
        .from(programTable)
        .innerJoin(
          schema.product,
          eq(schema.product.id, programTable.productId),
        )
        .where(
          and(
            eq(programTable.id, programId),
            eq(schema.product.orgId, ctx.activeOrganizationId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Program not found or does not belong to your product",
        });
      }

      const groups = await ctx.db
        .select({
          currency: rewardTable.currency,
          type: rewardTable.rewardType,
          status: rewardTable.status,
          count: sql<number>`count(*)::integer`,
          amount: sql<string>`COALESCE(sum(${rewardTable.amount}),0)::text`,
        })
        .from(rewardTable)
        .where(eq(rewardTable.programId, programId))
        .groupBy(
          rewardTable.currency,
          rewardTable.rewardType,
          rewardTable.status,
        );
      return {
        groups,
        summary: {
          totalRewards: groups.reduce((sum, row) => sum + row.count, 0),
        },
      };
    }),
});
