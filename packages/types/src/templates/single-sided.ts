import { rewardConfigSchema } from "../program-config";
import type { ProgramTemplateModule } from "../program-templates";
import { cashPurchaseRuleSpecs, referrerConfigFromForm } from "./shared";

export const singleSidedTemplate = {
  id: "single-sided",
  templateName: "Single-Sided Referral Program",
  description:
    "Reward only the referrer - perfect for affiliate-style programs where advocates earn for bringing new customers",
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
        description: "Configure referrer rewards",
      },
    ],
    meta: {
      rewardModel: "single-sided",
      recommendedFor: ["affiliate", "advocate", "influencer"],
    },
  },
  rewards: {
    schema: rewardConfigSchema.refine(
      (v) => !v.referee,
      "Single-Sided does not include a buyer discount",
    ),
    formSides: ["referrerReward"],
    requiresVerifiedPurchase: false,
    fromForm: referrerConfigFromForm,
    createRuleSpecs: cashPurchaseRuleSpecs,
  },
} satisfies ProgramTemplateModule;
