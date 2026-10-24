import type { RewardConfigType } from "./program-config";
import type { ProgramTemplateRewardStepV2Type } from "./program-template-steps";
import { getProgramTemplateById } from "./program-templates";

export function getTemplateRewardModule(templateId: string) {
  const template = getProgramTemplateById(templateId);
  if (template?.status !== "available")
    throw new Error("Template is not available");
  return template.rewards;
}

// Unknown/legacy template IDs retain their existing native tracking behavior.
export function templateRequiresVerifiedPurchase(templateId: string): boolean {
  const template = getProgramTemplateById(templateId);
  return template?.status === "available"
    ? template.rewards.requiresVerifiedPurchase
    : false;
}

export function createTemplateRuleSpecs(
  templateId: string,
  input: RewardConfigType,
) {
  const module = getTemplateRewardModule(templateId);
  return module.createRuleSpecs(module.schema.parse(input));
}
export function rewardConfigFromForm(
  value: ProgramTemplateRewardStepV2Type,
  templateId: string,
): RewardConfigType {
  const module = getTemplateRewardModule(templateId);
  const config = module.fromForm(value);
  module.createRuleSpecs(module.schema.parse(config));
  return config;
}
export const RewardCurrencyLabels = {
  USD: "US Dollar ($)",
  EUR: "Euro (€)",
  GBP: "British Pound (£)",
  RUB: "Российский рубль (₽)",
} as const;
export const RewardCurrencySymbols = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  RUB: "₽",
} as const;
