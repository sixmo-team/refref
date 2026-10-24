import type { z } from "zod";
import type { RewardConfigType } from "../program-config";
import type { ProgramTemplateRewardStepV2Type } from "../program-template-steps";
import type { RewardRuleConfigV1Type } from "../reward-config";
import { decimalToMinor, percentOfMinor } from "../referral-money";

export interface TemplateRuleSpec {
  name: string;
  type: string;
  config: RewardRuleConfigV1Type;
  priority: number;
}

export interface TemplateRewardModule {
  schema: z.ZodType<RewardConfigType>;
  formSides: ReadonlyArray<"referrerReward" | "refereeReward">;
  requiresVerifiedPurchase: boolean;
  fromForm(value: ProgramTemplateRewardStepV2Type): RewardConfigType;
  createRuleSpecs(settings: RewardConfigType): TemplateRuleSpec[];
}

export function referrerConfigFromForm(
  value: ProgramTemplateRewardStepV2Type,
): RewardConfigType {
  return {
    ...(value.firstPaidOnly !== undefined
      ? { firstPaidOnly: value.firstPaidOnly }
      : {}),
    ...(value.referrerReward.enabled
      ? {
          referrer: {
            type: "cash",
            valueType: value.referrerReward.valueType,
            value: value.referrerReward.value,
            currency: value.referrerReward.currency,
            ...(value.referrerReward.basis
              ? { basis: value.referrerReward.basis }
              : {}),
          },
        }
      : {}),
  };
}

// Both native templates pay cash on purchase; checkout discounts are not signup coupons.
export function cashPurchaseRuleSpecs(
  settings: RewardConfigType,
): TemplateRuleSpec[] {
  for (const side of [settings.referrer, settings.referee]) {
    if (!side) continue;
    if (side.valueType === "fixed") decimalToMinor(String(side.value));
    else percentOfMinor(0, String(side.value));
  }
  if (settings.referee?.minPurchaseAmount !== undefined)
    decimalToMinor(String(settings.referee.minPurchaseAmount));
  if (!settings.referrer) return [];
  const r = settings.referrer;
  return [
    {
      name: "Referrer Cash Reward",
      type: "referrer_purchase_reward",
      priority: 100,
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        ...(settings.firstPaidOnly !== undefined
          ? { conditions: { firstPaidOnly: settings.firstPaidOnly } }
          : {}),
        reward: {
          type: "cash",
          amount: r.value,
          unit: r.valueType === "percentage" ? "percent" : "fixed",
          currency: r.currency,
        },
      },
    },
  ];
}
