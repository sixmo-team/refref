import { rewardConfigSchema } from "../program-config";
import type { ProgramTemplateModule } from "../program-templates";
import { cashPurchaseRuleSpecs, referrerConfigFromForm } from "./shared";

export const doubleSidedTemplate = {
  id: "double-sided",
  templateName: "Double-Sided Referral Program",
  description:
    "Reward both referrer and referee - classic referral program where both parties benefit",
  status: "available",
  config: {
    schemaVersion: 1,
    steps: [
      {
        key: "brand",
        title: "Brand",
        description: "Set your brand color",
      },
      {
        key: "reward",
        title: "Rewards",
        description: "Configure reward structure",
      },
    ],
    meta: {},
  },
  rewards: {
    schema: rewardConfigSchema,
    formSides: ["referrerReward", "refereeReward"],
    requiresVerifiedPurchase: true,
    fromForm(value) {
      return {
        ...referrerConfigFromForm(value),
        ...(value.refereeReward.enabled
          ? {
              referee: {
                type: "discount",
                valueType: value.refereeReward.valueType,
                value: value.refereeReward.value,
                currency: value.refereeReward.currency,
                minPurchaseAmount: value.refereeReward.minPurchaseAmount,
                validityDays: value.refereeReward.validityDays,
              },
            }
          : {}),
      };
    },
    createRuleSpecs: cashPurchaseRuleSpecs,
  },
} satisfies ProgramTemplateModule;
