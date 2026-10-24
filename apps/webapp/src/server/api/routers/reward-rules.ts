import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  adminProcedure,
} from "@/server/api/trpc";
import { db, schema } from "@/server/db";
const { rewardRule, program: programTable } = schema;
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { rewardRuleConfigV1Schema } from "@refref/types";
import { assertLegacyTrackingAllowed } from "@refref/coredb";

export const rewardRulesRouter = createTRPCRouter({
  // Create a new reward rule
  create: adminProcedure
    .input(
      z.object({
        programId: z.string(),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        type: z.string(),
        config: rewardRuleConfigV1Schema,
        priority: z.number().int().min(0).default(0),
        isActive: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select()
          .from(programTable)
          .where(
            and(
              eq(programTable.id, input.programId),
              eq(programTable.productId, ctx.activeProductId),
            ),
          )
          .for("update");
        if (!program)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Program not found or does not belong to your product",
          });
        await assertLegacyTrackingAllowed(tx, program.id);
        const [newRule] = await tx
          .insert(rewardRule)
          .values({
            programId: input.programId,
            name: input.name,
            description: input.description,
            type: input.type,
            config: input.config,
            priority: input.priority,
            isActive: input.isActive,
          })
          .returning();
        return newRule;
      }),
    ),

  // Get all reward rules for a program
  getByProgram: protectedProcedure
    .input(
      z
        .object({
          programId: z.string().min(1),
          scope: z
            .object({
              userId: z.string().min(1),
              organizationId: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const { programId, scope } = input;
      if (
        scope.userId !== ctx.userId ||
        scope.organizationId !== ctx.activeOrganizationId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
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

      const rules = await ctx.db
        .select()
        .from(rewardRule)
        .where(eq(rewardRule.programId, programId))
        .orderBy(desc(rewardRule.priority), asc(rewardRule.createdAt));

      return rules;
    }),

  // Get a single reward rule by ID
  getById: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: ruleId }) => {
      const [rule] = await ctx.db
        .select({
          rule: rewardRule,
          program: programTable,
        })
        .from(rewardRule)
        .innerJoin(programTable, eq(rewardRule.programId, programTable.id))
        .where(eq(rewardRule.id, ruleId))
        .limit(1);

      if (!rule) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Reward rule not found",
        });
      }

      // Verify program belongs to active product
      if (rule.program.productId !== ctx.activeProductId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Reward rule does not belong to your product",
        });
      }

      return rule.rule;
    }),

  // Update a reward rule
  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        config: rewardRuleConfigV1Schema.optional(),
        priority: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const { id, ...updateData } = input;
        const [existingRule] = await tx
          .select({ rule: rewardRule, program: programTable })
          .from(rewardRule)
          .innerJoin(programTable, eq(rewardRule.programId, programTable.id))
          .where(eq(rewardRule.id, id))
          // Lock only the program here: all writers take it before any rule lock.
          .for("update", { of: programTable });
        if (!existingRule)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Reward rule not found",
          });
        if (existingRule.program.productId !== ctx.activeProductId)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Reward rule does not belong to your product",
          });
        await assertLegacyTrackingAllowed(tx, existingRule.program.id);
        const [updatedRule] = await tx
          .update(rewardRule)
          .set({ ...updateData, updatedAt: new Date() })
          .where(eq(rewardRule.id, id))
          .returning();
        return updatedRule;
      }),
    ),

  // Toggle rule active status
  toggleActive: adminProcedure
    .input(z.string())
    .mutation(async ({ ctx, input: ruleId }) =>
      ctx.db.transaction(async (tx) => {
        const [existingRule] = await tx
          .select({ rule: rewardRule, program: programTable })
          .from(rewardRule)
          .innerJoin(programTable, eq(rewardRule.programId, programTable.id))
          .where(eq(rewardRule.id, ruleId))
          .for("update", { of: programTable });
        if (!existingRule)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Reward rule not found",
          });
        if (existingRule.program.productId !== ctx.activeProductId)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Reward rule does not belong to your product",
          });
        await assertLegacyTrackingAllowed(tx, existingRule.program.id);
        const [updatedRule] = await tx
          .update(rewardRule)
          .set({
            isActive: sql`NOT coalesce(${rewardRule.isActive}, false)`,
            updatedAt: new Date(),
          })
          .where(eq(rewardRule.id, ruleId))
          .returning();
        return updatedRule;
      }),
    ),

  // Delete a reward rule
  delete: adminProcedure
    .input(z.string())
    .mutation(async ({ ctx, input: ruleId }) =>
      ctx.db.transaction(async (tx) => {
        const [existingRule] = await tx
          .select({ rule: rewardRule, program: programTable })
          .from(rewardRule)
          .innerJoin(programTable, eq(rewardRule.programId, programTable.id))
          .where(eq(rewardRule.id, ruleId))
          .for("update", { of: programTable });
        if (!existingRule)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Reward rule not found",
          });
        if (existingRule.program.productId !== ctx.activeProductId)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Reward rule does not belong to your product",
          });
        await assertLegacyTrackingAllowed(tx, existingRule.program.id);
        await tx
          .update(rewardRule)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(rewardRule.id, ruleId));
        return { id: ruleId };
      }),
    ),

  // Reorder rules by priority
  reorderPriorities: adminProcedure
    .input(
      z.object({
        programId: z.string(),
        ruleOrders: z.array(
          z.object({
            ruleId: z.string(),
            priority: z.number().int().min(0),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select()
          .from(programTable)
          .where(
            and(
              eq(programTable.id, input.programId),
              eq(programTable.productId, ctx.activeProductId),
            ),
          )
          .for("update");
        if (!program)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Program not found or does not belong to your product",
          });
        await assertLegacyTrackingAllowed(tx, program.id);
        const updates = await Promise.all(
          input.ruleOrders.map(({ ruleId, priority }) =>
            tx
              .update(rewardRule)
              .set({ priority, updatedAt: new Date() })
              .where(
                and(
                  eq(rewardRule.id, ruleId),
                  eq(rewardRule.programId, input.programId),
                ),
              )
              .returning(),
          ),
        );
        return updates.flat();
      }),
    ),
});
