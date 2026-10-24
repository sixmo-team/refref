import { describe, expect, it } from "vitest";
import { onboardingSchema, paymentProviderSchema, productInfoSchema } from "../validations/onboarding";

describe("onboarding step and complete-form validation", () => {
  it("validates a product step independently and normalizes its website", () => {
    expect(productInfoSchema.parse({ productName: "Example", productUrl: "example.com" })).toEqual({ productName: "Example", productUrl: "https://example.com" });
  });

  it("requires an actual provider name for other in both the step and complete form", () => {
    const payment = { paymentProvider: "other", otherPaymentProvider: "  " };
    expect(paymentProviderSchema.safeParse(payment).success).toBe(false);
    expect(onboardingSchema.safeParse({ productName: "Example", productUrl: "https://example.com", appType: "saas", useCase: ["referrals"], ...payment }).success).toBe(false);
    expect(paymentProviderSchema.parse({ ...payment, otherPaymentProvider: "Local billing" })).toEqual({ paymentProvider: "other", otherPaymentProvider: "Local billing" });
  });
});
