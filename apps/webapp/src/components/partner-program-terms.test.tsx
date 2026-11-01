import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FrozenCommission, RewardConfigType } from "@refref/types";
import { PartnerProgramTerms } from "./partner-program-terms";

describe("partner financial consent", () => {
  it("does not turn discount-only cash metadata into commission eligibility, while retaining buyer restrictions", () => {
    const terms: RewardConfigType = {
      firstPaidOnly: true,
      referrer: {
        type: "cash",
        valueType: "fixed",
        value: 0.25,
        currency: "RUB",
      },
      referee: {
        type: "discount",
        valueType: "percentage",
        value: 10,
        currency: "RUB",
        minPurchaseAmount: 617,
        validityDays: 73,
      },
    };
    const commission: FrozenCommission = {
      basis: "payable_amount",
      rules: [
        {
          ruleId: "custom-cash-rule",
          priority: 0,
          config: {
            schemaVersion: 1,
            trigger: { event: "purchase" },
            participantType: "referrer",
            conditions: { firstPaidOnly: true },
            reward: {
              type: "cash",
              amount: 0.25,
              unit: "fixed",
              currency: "RUB",
              minPurchaseAmount: 98765,
              validityDays: 421,
            },
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <PartnerProgramTerms terms={terms} commission={commission} />,
    );
    expect(html).not.toContain("98765");
    expect(html).not.toContain("421");
    expect(html).toContain("617");
    expect(html).toContain("73");
  });
});
