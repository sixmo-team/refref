import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  currencySchema,
  createTemplateRuleSpecs,
  rewardConfigFromForm,
  referralSnapshotV1Schema,
  minorToDecimal,
  decimalToMinor,
  percentOfMinor,
  buyerDiscountMinor,
  legacyRewardMinor,
  checkedMinor,
  programTemplateRewardStepSchemaV2,
} from "@refref/types";

const settings = {
  firstPaidOnly: true,
  referrer: {
    type: "cash" as const,
    valueType: "percentage" as const,
    value: 2.5,
    currency: "RUB" as const,
    basis: "payable_amount" as const,
  },
  referee: {
    type: "discount" as const,
    valueType: "percentage" as const,
    value: 50,
    currency: "RUB" as const,
  },
};
describe("first payment native contracts", () => {
  it("retains every existing currency and adds RUB", () => {
    for (const currency of ["USD", "EUR", "GBP", "RUB"])
      expect(currencySchema.parse(currency)).toBe(currency);
  });
  it("generates cash purchase rules without turning checkout discount into a signup coupon", () => {
    const specs = createTemplateRuleSpecs("double-sided", settings);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.config).toMatchObject({
      trigger: { event: "purchase" },
      conditions: { firstPaidOnly: true },
      reward: { unit: "percent", currency: "RUB", amount: 2.5 },
    });
    expect(() => createTemplateRuleSpecs("affiliate", settings)).toThrow();
    expect(() => createTemplateRuleSpecs("single-sided", settings)).toThrow();
  });
  it("ignores disabled-side remnants in the actual form validator and excludes them from configuration", () => {
    const values = {
      firstPaidOnly: true,
      referrerReward: {
        enabled: false,
        valueType: "fixed" as const,
        value: -1,
        currency: "RUB" as const,
        basis: "payable_amount" as const,
      },
      refereeReward: {
        enabled: false,
        valueType: "fixed" as const,
        value: -1,
        currency: "RUB" as const,
        minPurchaseAmount: 0,
        validityDays: 0,
      },
    };
    const parsed = programTemplateRewardStepSchemaV2.parse(values);
    expect(rewardConfigFromForm(parsed, "double-sided")).toEqual({
      firstPaidOnly: true,
    });
    expect(
      programTemplateRewardStepSchemaV2.safeParse({
        ...values,
        referrerReward: { ...values.referrerReward, enabled: true },
      }).success,
    ).toBe(false);
    expect(
      programTemplateRewardStepSchemaV2.safeParse({
        ...values,
        refereeReward: { ...values.refereeReward, enabled: true },
      }).success,
    ).toBe(false);
  });
  it.each([1.001, 100_000_000])(
    "rejects unsupported buyer minimum %s through the actual form-to-config path",
    (minPurchaseAmount) => {
      const parsed = programTemplateRewardStepSchemaV2.parse({
        firstPaidOnly: true,
        referrerReward: { enabled: true, ...settings.referrer },
        refereeReward: {
          enabled: true,
          ...settings.referee,
          minPurchaseAmount,
        },
      });
      expect(() => rewardConfigFromForm(parsed, "double-sided")).toThrow();
    },
  );
  it.each([
    { valueType: "fixed" as const, value: 0 },
    { valueType: "fixed" as const, value: 0.001 },
    { valueType: "percentage" as const, value: 100.000001 },
  ])(
    "keeps converter guards for enabled reward $valueType $value",
    (reward) => {
      const parsed = programTemplateRewardStepSchemaV2.parse({
        firstPaidOnly: true,
        referrerReward: { enabled: true, ...settings.referrer, ...reward },
        refereeReward: { enabled: true, ...settings.referee },
      });
      expect(() => rewardConfigFromForm(parsed, "double-sided")).toThrow();
    },
  );
  it("calculates version1 exact decimal half-up once at minor boundary", () => {
    expect(decimalToMinor("99999999.99")).toBe(9999999999);
    expect(minorToDecimal(101)).toBe("1.01");
    expect(percentOfMinor(1, "50")).toBe(1);
    expect(percentOfMinor(3, "50")).toBe(2);
    expect(percentOfMinor(101, "2.5")).toBe(3);
    expect(percentOfMinor(123456789, "0.000001")).toBe(1);
    expect(percentOfMinor(1, "0.000001")).toBe(0);
    expect(legacyRewardMinor(50, 0.025)).toBe(1);
    expect(legacyRewardMinor(1e-7, 10)).toBe(0);
    expect(() => decimalToMinor("0.001")).toThrow();
    expect(() => percentOfMinor(100, "1e2")).toThrow();
    expect(() => decimalToMinor("100000000.00")).toThrow();
    expect(() => decimalToMinor("-1.25")).toThrow();
    expect(() => checkedMinor(-125)).toThrow();
    expect(() => minorToDecimal(-125)).toThrow();
    expect(() => percentOfMinor(-125, "50")).toThrow();
  });
  it("keeps valid no-discount and minimum-unmet attribution independent of commission", () => {
    expect(buyerDiscountMinor({ kind: "none" }, 100)).toBe(0);
    expect(
      buyerDiscountMinor(
        { kind: "percent", percentDecimal: "50", minPurchaseAmountMinor: 101 },
        100,
      ),
    ).toBe(0);
    expect(
      buyerDiscountMinor(
        { kind: "percent", percentDecimal: "50", minPurchaseAmountMinor: null },
        101,
      ),
    ).toBe(51);
  });
  it("rejects unknown snapshot versions and mismatched pricing", () => {
    const valid = referralSnapshotV1Schema.parse({
      schemaVersion: 1,
      calculationVersion: 1,
      acceptedAt: new Date().toISOString(),
      offerVersion: "a".repeat(64),
      firstPaidOnly: true,
      attribution: {
        productId: randomUUID(),
        programId: randomUUID(),
        codeId: randomUUID(),
        codeValue: "abc1234",
        referrerParticipantId: randomUUID(),
      },
      pricing: {
        planCode: "test",
        priceVersion: "v1",
        currency: "RUB",
        baseAmountMinor: 101,
        discountAmountMinor: 51,
        payableAmountMinor: 50,
        buyerDiscountApplicable: true,
        buyerDiscountReason: null,
      },
      buyerDiscount: {
        kind: "percent",
        percentDecimal: "50",
        minPurchaseAmountMinor: null,
      },
      commission: {
        basis: "payable_amount",
        rules: createTemplateRuleSpecs("double-sided", settings).map(
          (rule) => ({
            ruleId: randomUUID(),
            priority: rule.priority,
            config: rule.config,
          }),
        ),
      },
    });
    expect(
      referralSnapshotV1Schema.safeParse({ ...valid, schemaVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      referralSnapshotV1Schema.safeParse({ ...valid, calculationVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      referralSnapshotV1Schema.safeParse({
        ...valid,
        pricing: { ...valid.pricing, baseAmountMinor: 102 },
      }).success,
    ).toBe(false);
    expect(
      referralSnapshotV1Schema.safeParse({
        ...valid,
        commission: { ...valid.commission, basis: null },
      }).success,
    ).toBe(false);
    expect(
      referralSnapshotV1Schema.safeParse({
        ...valid,
        commission: { basis: "payable_amount", rules: [] },
      }).success,
    ).toBe(false);
  });
});
