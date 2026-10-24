import { z } from "zod";
import { currencySchema } from "./program-config";
import {
  buyerDiscountMinor,
  decimalToMinor,
  percentOfMinor,
} from "./referral-money";

export const referralIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const minorAmountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const canonicalRefcodeSchema = z.string().regex(/^[a-z0-9]{7}$/);
export const inputRefcodeSchema = z
  .string()
  .max(64)
  .regex(/^\s*[A-Za-z0-9]{7}\s*$/)
  .trim()
  .toLowerCase()
  .pipe(canonicalRefcodeSchema);
const percentSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/)
  .refine((v) => Number(v) <= 100);
const nativeAmountSchema = z
  .number()
  .nonnegative()
  .refine((v) => {
    try {
      percentOfMinor(0, String(v));
      return true;
    } catch {
      return false;
    }
  });
export const frozenCommissionRuleConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    trigger: z.object({ event: z.literal("purchase") }).strict(),
    participantType: z.literal("referrer"),
    conditions: z.object({ firstPaidOnly: z.boolean() }).strict().optional(),
    reward: z
      .object({
        type: z.literal("cash"),
        amount: z.number().nonnegative(),
        unit: z.enum(["fixed", "percent"]),
        currency: currencySchema,
        minPurchaseAmount: z.number().nonnegative().optional(),
        validityDays: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      if (v.reward.unit === "fixed") decimalToMinor(String(v.reward.amount));
      else nativeAmountSchema.parse(v.reward.amount);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid exact native amount" });
    }
  });
export const buyerDiscountSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("fixed"),
      amountMinor: minorAmountSchema,
      minPurchaseAmountMinor: minorAmountSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("percent"),
      percentDecimal: percentSchema,
      minPurchaseAmountMinor: minorAmountSchema.nullable(),
    })
    .strict(),
]);
export const frozenCommissionSchema = z
  .object({
    basis: z.enum(["base_amount", "payable_amount"]).nullable(),
    rules: z
      .array(
        z
          .object({
            ruleId: referralIdSchema,
            priority: z.number().int(),
            config: frozenCommissionRuleConfigSchema,
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .refine(
    (v) => (v.basis === null) === (v.rules.length === 0),
    "Commission basis is required exactly when cash rules are present",
  )
  .refine(
    (v) => new Set(v.rules.map((r) => r.ruleId)).size === v.rules.length,
    "Duplicate rule",
  );
export const referralCodeResolutionSchema = z
  .object({
    codeId: referralIdSchema,
    canonicalCode: canonicalRefcodeSchema,
    productId: referralIdSchema,
    programId: referralIdSchema,
    referrerParticipantId: referralIdSchema,
    referrerDisplayName: z.string().max(100).optional(),
    firstPaidOnly: z.boolean(),
    currency: currencySchema,
    buyerDiscount: buyerDiscountSpecSchema,
    commission: frozenCommissionSchema,
    calculationVersion: z.literal(1),
  })
  .strict()
  .refine(
    (v) =>
      v.commission.rules.every(
        (r) =>
          r.config.reward.currency === v.currency &&
          (r.config.conditions?.firstPaidOnly ?? false) === v.firstPaidOnly,
      ),
    "Frozen first-paid rule conditions must match policy",
  );
export const resolveReferralRequestSchema = z
  .object({
    productId: referralIdSchema,
    programId: referralIdSchema,
    customerExternalId: referralIdSchema,
    code: inputRefcodeSchema,
  })
  .strict();
export const referralSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    calculationVersion: z.literal(1),
    acceptedAt: z.string().datetime(),
    offerVersion: z.string().regex(/^[a-f0-9]{64}$/),
    attribution: z
      .object({
        productId: referralIdSchema,
        programId: referralIdSchema,
        codeId: referralIdSchema,
        codeValue: canonicalRefcodeSchema,
        referrerParticipantId: referralIdSchema,
      })
      .strict(),
    firstPaidOnly: z.boolean(),
    pricing: z
      .object({
        planCode: z.string().min(1).max(100),
        priceVersion: z.string().min(1).max(200),
        currency: currencySchema,
        baseAmountMinor: minorAmountSchema,
        discountAmountMinor: minorAmountSchema,
        payableAmountMinor: minorAmountSchema.positive(),
        buyerDiscountApplicable: z.boolean(),
        buyerDiscountReason: z.string().max(200).nullable(),
      })
      .strict(),
    buyerDiscount: buyerDiscountSpecSchema,
    commission: frozenCommissionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    const p = v.pricing;
    if (
      p.baseAmountMinor - p.discountAmountMinor !== p.payableAmountMinor ||
      buyerDiscountMinor(v.buyerDiscount, p.baseAmountMinor) !==
        p.discountAmountMinor
    )
      ctx.addIssue({
        code: "custom",
        message: "Pricing differs from accepted discount",
      });
    if (
      v.commission.rules.some(
        (r) =>
          r.config.reward.currency !== p.currency ||
          (r.config.conditions?.firstPaidOnly ?? false) !== v.firstPaidOnly,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Frozen rule conditions/currency differ",
      });
  });
export type ReferralSnapshotV1 = z.infer<typeof referralSnapshotV1Schema>;
export type ReferralCodeResolution = z.infer<
  typeof referralCodeResolutionSchema
>;
export const purchaseEventMetadataV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    source: z.literal("api"),
    orderId: referralIdSchema,
    orderAmountMinor: minorAmountSchema.positive(),
    currency: currencySchema,
    referralSnapshot: referralSnapshotV1Schema,
  })
  .strict()
  .refine(
    (v) =>
      v.orderAmountMinor === v.referralSnapshot.pricing.payableAmountMinor &&
      v.currency === v.referralSnapshot.pricing.currency,
    "Purchase differs from frozen pricing",
  );
export type PurchaseEventMetadataV2 = z.infer<
  typeof purchaseEventMetadataV2Schema
>;
export const minorPurchaseRequestSchema = z
  .object({
    timestamp: z.string().datetime(),
    productId: referralIdSchema,
    programId: referralIdSchema,
    payload: z
      .object({
        userId: referralIdSchema,
        orderId: referralIdSchema,
        orderAmountMinor: minorAmountSchema.positive(),
        currency: currencySchema,
        customer: z
          .object({
            name: z.string().trim().min(1).max(200),
            email: z.string().email().max(320),
          })
          .strict(),
        referralSnapshot: referralSnapshotV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const s = v.payload.referralSnapshot;
    if (
      s.attribution.productId !== v.productId ||
      s.attribution.programId !== v.programId ||
      s.pricing.currency !== v.payload.currency ||
      s.pricing.payableAmountMinor !== v.payload.orderAmountMinor ||
      Date.parse(s.acceptedAt) > Date.parse(v.timestamp)
    )
      ctx.addIssue({
        code: "custom",
        message: "Purchase scope/amount/time differs from frozen terms",
      });
  });
export type MinorPurchaseRequest = z.infer<typeof minorPurchaseRequestSchema>;
export const minorPurchaseResponseSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    eventId: referralIdSchema,
    productId: referralIdSchema,
    programId: referralIdSchema,
    orderId: referralIdSchema,
    codeId: referralIdSchema,
    customerExternalId: referralIdSchema,
    participantId: referralIdSchema,
    referralId: referralIdSchema,
    referrerParticipantId: referralIdSchema,
    rewardIds: z.array(referralIdSchema).max(32),
    rewards: z
      .array(
        z
          .object({
            id: referralIdSchema,
            ruleId: referralIdSchema,
            participantId: referralIdSchema,
            type: z.literal("cash"),
            amountMinor: minorAmountSchema,
            currency: currencySchema,
            config: frozenCommissionRuleConfigSchema,
          })
          .strict(),
      )
      .max(32),
    duplicate: z.boolean(),
  })
  .strict();
export type MinorPurchaseResponse = z.infer<typeof minorPurchaseResponseSchema>;
export const legacyPurchaseRequestSchema = z.object({
  timestamp: z.string().datetime(),
  productId: z.string().min(1),
  programId: z.string().optional(),
  payload: z.object({
    userId: z.string().min(1),
    orderAmount: z.number().positive(),
    orderId: z.string().min(1).max(200),
    productIds: z.array(z.string()).optional(),
    currency: z.string().default("USD"),
    orderAmountMinor: z.never().optional(),
    referralSnapshot: z.never().optional(),
  }),
});
export const signupTrackingRequestSchema = z.object({
  timestamp: z.string().datetime(),
  productId: z.string().min(1),
  programId: z.string().optional(),
  payload: z.object({
    userId: z.string().min(1),
    name: z.string().max(200).optional(),
    email: z.string().email().max(320).optional(),
    refcode: z.string().optional(),
  }),
});
