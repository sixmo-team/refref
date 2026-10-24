import { z } from "zod";
import { currencySchema } from "./program-config";

const referrerRewardFormSchema = z.object({
  enabled: z.literal(true),
  valueType: z.enum(["fixed", "percentage"]),
  value: z.number().nonnegative(),
  currency: currencySchema,
  basis: z.enum(["base_amount", "payable_amount"]).optional(),
});
const refereeRewardFormSchema = z.object({
  enabled: z.literal(true),
  valueType: z.enum(["fixed", "percentage"]),
  value: z.number().nonnegative(),
  currency: currencySchema.optional(),
  minPurchaseAmount: z.number().positive().optional(),
  validityDays: z.number().int().positive().optional(),
});
export const programTemplateRewardStepSchemaV2 = z.object({
  firstPaidOnly: z.boolean().optional(),
  referrerReward: z.discriminatedUnion("enabled", [
    referrerRewardFormSchema,
    referrerRewardFormSchema.extend({
      enabled: z.literal(false),
      value: z.number(),
    }),
  ]),
  refereeReward: z.discriminatedUnion("enabled", [
    refereeRewardFormSchema,
    refereeRewardFormSchema.extend({
      enabled: z.literal(false),
      value: z.number(),
      minPurchaseAmount: z.number().optional(),
      validityDays: z.number().optional(),
    }),
  ]),
});

export type ProgramTemplateRewardStepV2Type = z.infer<
  typeof programTemplateRewardStepSchemaV2
>;

// Keep old schema for backward compatibility
/** @deprecated Use programTemplateRewardStepSchemaV2 instead */
export const programTemplateRewardStepSchema = z.object({
  type: z.literal("cash"),
  defaultCurrency: z.string().min(1),
  rewardType: z.enum(["percentage", "fixed"]),
  revenueSharePercentage: z.number().min(0).max(50),
  revenueSharePeriodType: z.literal("lifetime"),
  cap: z.number().min(0),
  newUserRewardType: z.enum(["percentage", "fixed"]),
  newUserRewardMonths: z.number().min(1),
  newUserRewardValue: z.number().min(0),
});

/** @deprecated Use ProgramTemplateRewardStepV2Type instead */
export type ProgramTemplateRewardStepType = z.infer<
  typeof programTemplateRewardStepSchema
>;
