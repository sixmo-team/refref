import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  adminProcedure,
} from "@/server/api/trpc";
import { db, schema } from "@/server/db";
const {
  product,
  program: programTable,
  participant,
  referral,
  orgUser,
  programUser,
  user,
} = schema;
import {
  eq,
  and,
  inArray,
  asc,
  sql,
  count,
  getTableColumns,
} from "drizzle-orm";
import assert from "assert";
import { getSetupProgress, type SetupProgress } from "@/lib/program";
import {
  programConfigV1Schema,
  type ProgramConfigV1Type,
  configuredProgramTemplateSchema,
  type ConfiguredProgramTemplateType,
  WidgetConfigType,
  widgetConfigSchema,
  defaultWidgetConfig,
  getAllProgramTemplates,
  getProgramTemplateById,
  createTemplateRuleSpecs,
  frozenCommissionRuleConfigSchema,
  currencySchema,
} from "@refref/types";
import { TRPCError } from "@trpc/server";
import {
  generateWidgetConfigFromTemplate,
  mergeWidgetConfig,
} from "@/lib/template-config-generator";
import { safeError } from "@refref/utils";
import { isDeepStrictEqual } from "node:util";
import { referralTermsFingerprint } from "@refref/coredb";
import { validateProductScope } from "@refref/coredb/security";

/**
 * Transforms input and template data into the final program config.
 * @param config - The validated user input.
 * @returns The final config object conforming to ProgramConfigV1Type.
 */
function transformInputToProgramConfig(
  config: ConfiguredProgramTemplateType,
): ProgramConfigV1Type {
  // Initialize the program config
  const finalConfig: ProgramConfigV1Type = {
    schemaVersion: 1,
    widgetConfig: defaultWidgetConfig,
    actions: undefined, // Legacy field, no longer used
    notification: {}, // Placeholder
  };

  // Validate the final config against the Zod schema
  const validationResult = programConfigV1Schema.safeParse(finalConfig);
  if (!validationResult.success) {
    console.error("Program config validation failed");
    // Throw an error or handle invalid config state appropriately
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to generate valid program configuration.",
      cause: validationResult.error,
    });
  }

  // Return the validated config data
  return validationResult.data;
}

const identityScopeSchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1),
  })
  .strict();
const programReadInputSchema = z
  .object({
    id: z.string().min(1),
    scope: identityScopeSchema,
  })
  .strict();

export const programRouter = createTRPCRouter({
  create: protectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1, "Name is required")
          .max(100, "Name is too long"),
        description: z.string().max(255, "Description is too long").optional(),
        templateId: z.string().min(1, "Template is required"),
        productId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      // Get the selected template from constants
      const selectedTemplate = getProgramTemplateById(input.templateId);

      if (!selectedTemplate || selectedTemplate.status !== "available") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });
      }

      // Check if a program with this template already exists for this product
      const [existingProgram] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.productId, input.productId),
            eq(programTable.programTemplateId, input.templateId),
          ),
        )
        .limit(1);

      if (existingProgram) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A program with the "${selectedTemplate.templateName}" template already exists in this product. Each template can only be used once per product.`,
        });
      }

      // Create a new program with initial pending state and template config
      const [program] = await ctx.db
        .insert(programTable)
        .values({
          name: input.name,
          productId: input.productId,
          programTemplateId: input.templateId,
          status: "pending_setup", // Initial status
          config: undefined,
        })
        .returning();

      assert(program, "Program not created");

      // Sync all org members to the new program
      try {
        // Get all org members
        const orgMembers = await ctx.db
          .select({
            userId: orgUser.userId,
            role: orgUser.role,
            email: user.email,
            name: user.name,
          })
          .from(orgUser)
          .innerJoin(user, eq(orgUser.userId, user.id))
          .where(eq(orgUser.orgId, ctx.activeOrganizationId));

        // Filter out service accounts and add members to programUser
        const membersToAdd = orgMembers.filter(
          (member) =>
            !member.email?.includes("service-account") &&
            !member.name?.includes("Service Account"),
        );

        if (membersToAdd.length > 0) {
          await ctx.db.insert(programUser).values(
            membersToAdd.map((member) => ({
              programId: program.id,
              userId: member.userId,
              role: member.role,
            })),
          );

          ctx.logger?.info("Synced org members to new program", {
            programId: program.id,
            memberCount: membersToAdd.length,
          });
        }
      } catch (error) {
        ctx.logger?.error(
          "Failed to sync org members to new program",
          safeError(error),
        );
        // Don't fail program creation if sync fails
      }

      return {
        ...program,
        setup: getSetupProgress(program.config),
      };
    }),

  saveTemplateConfiguration: adminProcedure
    .input(
      z.object({
        id: z.string(), // ID of the program to configure
        templateConfig: configuredProgramTemplateSchema,
        brandConfig: z
          .object({
            primaryColor: z
              .string()
              .regex(/^#[0-9A-Fa-f]{6}$/, "Invalid hex color"),
            landingPageUrl: z.string().url({
              message: "Please enter a valid URL",
            }),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, templateConfig, brandConfig } = input;

      // Get required modules from the already imported schema
      const { eventDefinition, rewardRule } = schema;

      // Read terms only after taking the same program lock used by approval and rule writers.
      const result = await ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select(getTableColumns(programTable))
          .from(programTable)
          .innerJoin(product, eq(product.id, programTable.productId))
          .where(
            and(
              eq(programTable.id, id),
              eq(product.orgId, ctx.activeOrganizationId),
            ),
          )
          .for("update", { of: programTable });
        if (!program)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Program does not belong to your organization",
          });
        const programTemplate = getProgramTemplateById(
          program.programTemplateId,
        );
        if (!programTemplate || programTemplate.status !== "available")
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Template not found",
          });
        const rewardConfig =
          templateConfig.rewardConfig ?? program.config?.rewardConfig;
        if (rewardConfig) {
          const specs = createTemplateRuleSpecs(
            program.programTemplateId,
            rewardConfig,
          );
          await tx
            .insert(eventDefinition)
            .values([
              {
                type: "signup",
                name: "User Signup",
                config: { schemaVersion: 1 },
              },
              {
                type: "purchase",
                name: "Purchase",
                config: { schemaVersion: 1 },
              },
            ])
            .onConflictDoNothing();
          const existing = await tx
            .select()
            .from(rewardRule)
            .where(
              and(
                eq(rewardRule.programId, id),
                eq(rewardRule.isActive, true),
                inArray(rewardRule.type, [
                  "referrer_purchase_reward",
                  "referee_signup_discount",
                ]),
              ),
            );
          const retainedTypes = new Set<string>();
          for (const rule of existing) {
            const matches = specs.some(
              (spec) =>
                spec.type === rule.type &&
                isDeepStrictEqual(spec.config, rule.config),
            );
            if (!matches || retainedTypes.has(rule.type)) {
              await tx
                .update(rewardRule)
                .set({ isActive: false, updatedAt: new Date() })
                .where(eq(rewardRule.id, rule.id));
            } else retainedTypes.add(rule.type);
          }
          for (const spec of specs) {
            if (!retainedTypes.has(spec.type)) {
              await tx
                .insert(rewardRule)
                .values({ ...spec, programId: id, isActive: true });
            }
          }
        }

        // 2. Generate widget config from brand and reward settings
        let widgetConfig: WidgetConfigType;

        if (brandConfig && rewardConfig) {
          // Get product details for product name
          const [productData] = await tx
            .select()
            .from(product)
            .where(eq(product.id, program.productId))
            .limit(1);

          const productName = productData?.name || "Our Platform";

          // Parse product metadata if available
          let productMetadata = undefined;
          if (productData?.metadata) {
            try {
              productMetadata = JSON.parse(productData.metadata);
            } catch (e) {
              // If metadata is not valid JSON, ignore it
              console.warn("Failed to parse product metadata");
            }
          }

          // Generate widget config from template settings with enhanced logic
          widgetConfig = generateWidgetConfigFromTemplate(
            brandConfig,
            rewardConfig,
            productName,
            productMetadata,
          );

          // Add product logo and URL if available
          if (productData?.logo) {
            widgetConfig.logoUrl = productData.logo;
          }

          // Use product URL as landing page if brand config doesn't specify one
          if (!brandConfig?.landingPageUrl && productData?.url) {
            widgetConfig.referralLink = productData.url; // This will be replaced with actual referral link later
          }

          // Set the referral link (will be populated later by the system)
          widgetConfig.referralLink = "";
        } else {
          // Use existing config or default
          widgetConfig = program.config?.widgetConfig || defaultWidgetConfig;
        }

        // 3. Create the final program config
        const finalProgramConfig: ProgramConfigV1Type = {
          schemaVersion: 1,
          rewardConfig,
          serverTracking:
            rewardConfig &&
            program.config?.serverTracking?.termsFingerprint ===
              referralTermsFingerprint(rewardConfig)
              ? program.config.serverTracking
              : undefined,
          widgetConfig,
          brandConfig: brandConfig ?? program.config?.brandConfig,
          actions: undefined,
          notification: undefined,
          templateConfig: programTemplate.config,
        };

        // 4. Update the program record within the transaction
        const [updatedProgram] = await tx
          .update(programTable)
          .set({
            config: finalProgramConfig,
            status:
              program.status === "pending_approval" ||
              rewardConfig?.firstPaidOnly ||
              programTemplate.rewards.requiresVerifiedPurchase ||
              program.config?.serverTracking
                ? finalProgramConfig.serverTracking
                  ? program.status
                  : "pending_approval"
                : program.status === "pending_setup"
                  ? "active"
                  : program.status,
          })
          .where(eq(programTable.id, input.id))
          .returning({ id: programTable.id });

        return { id };
      });

      return result;
    }),

  // Add a new procedure to list available templates
  listTemplates: protectedProcedure.query(async () => {
    return getAllProgramTemplates();
  }),

  getById: protectedProcedure
    .input(programReadInputSchema)
    .query(async ({ ctx, input }) => {
      if (
        input.scope.userId !== ctx.userId ||
        input.scope.organizationId !== ctx.activeOrganizationId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      const program = await ctx.db.query.program.findFirst({
        where: eq(programTable.id, input.id),
      });

      if (!program) {
        throw new Error("Program not found");
      }

      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        program.productId,
      );

      return {
        ...program,
        termsFingerprint: program.config?.rewardConfig
          ? referralTermsFingerprint(program.config.rewardConfig)
          : null,
        setup: getSetupProgress(program.config),
      };
    }),

  getSetupProgress: protectedProcedure
    .input(programReadInputSchema)
    .query(async ({ ctx, input }) => {
      if (
        input.scope.userId !== ctx.userId ||
        input.scope.organizationId !== ctx.activeOrganizationId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(eq(programTable.id, input.id))
        .limit(1);

      if (!program) {
        throw new Error("Program not found");
      }

      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        program.productId,
      );

      return getSetupProgress(program.config);
    }),

  updateConfig: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        config: programConfigV1Schema,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select(getTableColumns(programTable))
          .from(programTable)
          .innerJoin(product, eq(product.id, programTable.productId))
          .where(
            and(
              eq(programTable.id, input.id),
              eq(product.orgId, ctx.activeOrganizationId),
            ),
          )
          .for("update", { of: programTable });
        if (!program)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Program does not belong to your organization",
          });
        if (
          !isDeepStrictEqual(
            input.config.serverTracking,
            program.config?.serverTracking,
          ) ||
          !isDeepStrictEqual(
            input.config.rewardConfig,
            program.config?.rewardConfig,
          )
        )
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Use reward settings and explicit server-tracking approval",
          });
        const [updatedProgram] = await tx
          .update(programTable)
          .set({ config: input.config })
          .where(eq(programTable.id, program.id))
          .returning();
        assert(updatedProgram, "Program not updated");
        return {
          ...updatedProgram,
          setup: getSetupProgress(updatedProgram.config),
        };
      }),
    ),

  updateName: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z
          .string()
          .min(1, "Name is required")
          .max(100, "Name is too long"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Find the program
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(eq(programTable.id, input.id))
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Program not found",
        });
      }

      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        program.productId,
      );

      // Update the program name
      const [updatedProgram] = await ctx.db
        .update(programTable)
        .set({
          name: input.name,
        })
        .where(eq(programTable.id, input.id))
        .returning();

      assert(updatedProgram, "Program not updated");
      return {
        ...updatedProgram,
        setup: getSetupProgress(updatedProgram.config),
      };
    }),

  /* Deprecated - use new reward configuration through saveTemplateConfiguration
  updateRewardConfig: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        reward: z.any(), // Legacy schema removed
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(eq(programTable.id, input.id))
        .limit(1);

      if (!program) {
        throw new Error("Program not found");
      }

      // Verify program belongs to active organization through product
      const [productRecord] = await ctx.db
        .select()
        .from(product)
        .where(
          and(
            eq(product.id, program.productId),
            eq(product.id, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!productRecord) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Program does not belong to your organization",
        });
      }

      // Get current config
      const currentConfig = program.config as ProgramConfigV1Type;
      
      // Update the referral action's reward configuration
      const updatedActions = currentConfig.actions?.map(action => {
        if (action.actionId === "referral") {
          return {
            ...action,
            reward: {
              ...input.reward,
            },
          };
        }
        return action;
      });

      // Create updated config
      const updatedConfig: ProgramConfigV1Type = {
        ...currentConfig,
        actions: updatedActions,
      };

      const [updatedProgram] = await ctx.db
        .update(programTable)
        .set({
          config: updatedConfig,
        })
        .where(eq(programTable.id, input.id))
        .returning();

      assert(updatedProgram, "Program not updated");
      return {
        ...updatedProgram,
        setup: getSetupProgress(updatedProgram.config),
      };
    }),
  */

  getAll: protectedProcedure
    .input(
      z
        .object({
          scope: identityScopeSchema
            .extend({ productId: z.string().min(1) })
            .strict(),
        })
        .strict()
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const productId =
        input === undefined ? ctx.activeProductId : input.scope.productId;
      if (input !== undefined) {
        if (
          input.scope.userId !== ctx.userId ||
          input.scope.organizationId !== ctx.activeOrganizationId
        )
          throw new TRPCError({ code: "FORBIDDEN" });
        await validateProductScope(ctx.db, ctx.activeOrganizationId, productId);
      }
      // Get all programs through products belonging to the active organization
      const programs = await ctx.db
        .select()
        .from(programTable)
        .innerJoin(product, eq(product.id, programTable.productId))
        .where(eq(product.id, productId))
        .orderBy(asc(programTable.createdAt));

      // Get participant and referral counts for each program
      const programsWithCounts = await Promise.all(
        programs.map(async ({ program }) => {
          // Get participant count for this product
          const [participantCount] = await ctx.db
            .select({ count: count() })
            .from(participant)
            .where(eq(participant.productId, program.productId));

          // Get referral count through participants in this product
          const [referralCount] = await ctx.db
            .select({ count: count() })
            .from(referral)
            .innerJoin(participant, eq(participant.id, referral.referrerId))
            .where(eq(participant.productId, program.productId));

          return {
            ...program,
            setup: getSetupProgress(program.config),
            participantCount: participantCount?.count || 0,
            referralCount: referralCount?.count || 0,
          };
        }),
      );

      return programsWithCounts;
    }),

  approveServerTracking: adminProcedure
    .input(
      z
        .object({
          productId: z.string().min(1),
          programId: z.string().min(1),
          termsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          calculationVersion: z.literal(1),
          edgeExamplesApproved: z.literal(true),
          ownershipPolicyVerified: z.literal(true),
          startDate: z.string().datetime().optional(),
          endDate: z.string().datetime().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
        input.programId,
      );
      return ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select()
          .from(programTable)
          .where(
            and(
              eq(programTable.id, input.programId),
              eq(programTable.productId, input.productId),
            ),
          )
          .for("update");
        const terms = program?.config?.rewardConfig;
        if (
          !program?.config ||
          !terms ||
          (!terms.referrer && !terms.referee) ||
          (terms.referrer && !terms.referrer.basis) ||
          referralTermsFingerprint(terms) !== input.termsFingerprint
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Explicit terms/basis and matching reviewed fingerprint required",
          });
        const currency = currencySchema.safeParse(
          terms.referrer?.currency ?? terms.referee?.currency,
        );
        if (
          !currency.success ||
          (terms.referee && terms.referee.currency !== currency.data)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Explicit matching financial currencies are required",
          });
        createTemplateRuleSpecs(program.programTemplateId, terms).forEach(
          (spec) => frozenCommissionRuleConfigSchema.parse(spec.config),
        );
        const startDate = input.startDate
          ? new Date(input.startDate)
          : program.startDate;
        const endDate = input.endDate
          ? new Date(input.endDate)
          : program.endDate;
        if (
          (terms.referee?.validityDays && !startDate) ||
          (startDate && endDate && endDate <= startDate)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Explicit valid program dates are required for time-limited terms",
          });
        const [approved] = await tx
          .update(programTable)
          .set({
            status: "active",
            startDate,
            endDate,
            config: {
              ...program.config,
              serverTracking: {
                calculationVersion: 1,
                approvedBy: ctx.userId,
                approvedAt: new Date().toISOString(),
                termsFingerprint: input.termsFingerprint,
                ownershipVerified: true,
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(programTable.id, program.id))
          .returning();
        return approved;
      });
    }),

  /**
   * Remove an unused program or archive referenced history in its organization.
   */
  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [program] = await tx
          .select({ id: programTable.id })
          .from(programTable)
          .innerJoin(product, eq(product.id, programTable.productId))
          .where(
            and(
              eq(programTable.id, input.id),
              eq(product.orgId, ctx.activeOrganizationId),
            ),
          )
          .for("update", { of: programTable });
        if (!program)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Program does not belong to your organization",
          });

        const [history] = await tx
          .select({
            referenced: sql<boolean>`
              EXISTS (SELECT 1 FROM ${schema.event}
                WHERE ${schema.event.programId} = ${program.id})
              OR EXISTS (SELECT 1 FROM ${schema.refcode}
                WHERE ${schema.refcode.programId} = ${program.id})
              OR EXISTS (SELECT 1 FROM ${referral}
                WHERE ${referral.programId} = ${program.id})
              OR EXISTS (SELECT 1 FROM ${schema.reward}
                WHERE ${schema.reward.programId} = ${program.id})
            `,
          })
          .from(programTable)
          .where(eq(programTable.id, program.id));
        if (history?.referenced)
          await tx
            .update(programTable)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(programTable.id, program.id));
        else
          await tx.delete(programTable).where(eq(programTable.id, program.id));
        return { id: program.id };
      }),
    ),
});
