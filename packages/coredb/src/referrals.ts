import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, desc, sql } from "drizzle-orm";
import type { DBType } from "./index.js";
import * as s from "./schema.js";
import { processEventRewards } from "./reward-engine.js";
import {
  referralCodeResolutionSchema,
  minorPurchaseRequestSchema,
  minorPurchaseResponseSchema,
  decimalToMinor,
  templateRequiresVerifiedPurchase,
  type MinorPurchaseRequest,
  type ReferralCodeResolution,
  type RewardConfigType,
} from "@refref/types";
export class ReferralError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function referralTermsFingerprint(settings: RewardConfigType): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(sorted(settings)))
    .digest("hex");
}
export async function resolveReferralCode(
  db: DBType,
  input: {
    productId: string;
    programId: string;
    customerExternalId: string;
    code: string;
  },
): Promise<ReferralCodeResolution> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ code: s.refcode, owner: s.participant, program: s.program })
      .from(s.refcode)
      .innerJoin(s.participant, eq(s.refcode.participantId, s.participant.id))
      .innerJoin(s.program, eq(s.refcode.programId, s.program.id))
      .where(
        and(
          eq(s.refcode.code, input.code),
          eq(s.refcode.productId, input.productId),
          eq(s.refcode.programId, input.programId),
          eq(s.participant.productId, input.productId),
          eq(s.program.productId, input.productId),
        ),
      )
      .limit(1)
      // Financial writers lock the program before changing either terms or rules.
      .for("share", { of: s.program });
    if (!row)
      throw new ReferralError(
        "REFERRAL_CODE_NOT_FOUND",
        404,
        "Referral code not found",
      );
    const { program, owner, code } = row;
    const now = Date.now();
    if (
      !code.isActive ||
      program.status !== "active" ||
      (program.startDate && program.startDate.getTime() > now) ||
      (program.endDate && program.endDate.getTime() < now)
    )
      throw new ReferralError(
        "REFERRAL_CODE_INACTIVE",
        422,
        "Referral code is inactive",
      );
    const config = program.config;
    const terms = config?.rewardConfig;
    if (
      !terms ||
      (terms.referrer && !terms.referrer.basis) ||
      !config?.serverTracking ||
      config.serverTracking.termsFingerprint !==
        referralTermsFingerprint(terms) ||
      !owner.ownerUserId ||
      !owner.ownershipVerifiedBy ||
      !owner.ownershipVerifiedAt ||
      !owner.ownershipEvidence ||
      !owner.payoutRecipient
    )
      throw new ReferralError(
        "REFERRAL_CONDITIONS_NOT_MET",
        422,
        "Approved terms and verified ownership required",
      );
    if (owner.externalId === input.customerExternalId)
      throw new ReferralError(
        "REFERRAL_SELF_REFERRAL",
        409,
        "Self-referral is not eligible",
      );
    const [buyer] = await tx
      .select()
      .from(s.participant)
      .where(
        and(
          eq(s.participant.productId, input.productId),
          eq(s.participant.externalId, input.customerExternalId),
        ),
      )
      .limit(1);
    if (terms.firstPaidOnly && buyer?.firstPurchaseEventId)
      throw new ReferralError(
        "REFERRAL_NOT_FIRST_PAYMENT",
        409,
        "First purchase already claimed",
      );
    const rules = await tx
      .select()
      .from(s.rewardRule)
      .where(
        and(
          eq(s.rewardRule.programId, input.programId),
          eq(s.rewardRule.isActive, true),
        ),
      )
      .orderBy(desc(s.rewardRule.priority), s.rewardRule.id);
    const discount = terms.referee;
    const currency = terms.referrer?.currency ?? discount?.currency;
    if (!currency || (discount && discount.currency !== currency))
      throw new ReferralError(
        "REFERRAL_CONDITIONS_NOT_MET",
        422,
        "An enabled financial side and matching currencies are required",
      );
    if (
      discount?.validityDays &&
      (!program.startDate ||
        now > program.startDate.getTime() + discount.validityDays * 86400000)
    )
      throw new ReferralError(
        "REFERRAL_CODE_INACTIVE",
        422,
        "Discount validity has ended or is not configured",
      );
    const resolution = referralCodeResolutionSchema.safeParse({
      codeId: code.id,
      canonicalCode: code.code,
      productId: input.productId,
      programId: input.programId,
      referrerParticipantId: owner.id,
      firstPaidOnly: terms.firstPaidOnly ?? false,
      currency,
      calculationVersion: 1,
      buyerDiscount: !discount
        ? { kind: "none" }
        : {
            kind: discount.valueType === "percentage" ? "percent" : "fixed",
            ...(discount.valueType === "percentage"
              ? { percentDecimal: String(discount.value) }
              : { amountMinor: decimalToMinor(String(discount.value)) }),
            minPurchaseAmountMinor:
              discount.minPurchaseAmount === undefined
                ? null
                : decimalToMinor(String(discount.minPurchaseAmount)),
          },
      commission: {
        basis: terms.referrer?.basis ?? null,
        rules: rules
          .filter(
            (r) =>
              r.config.participantType === "referrer" &&
              r.config.reward.type === "cash" &&
              r.config.trigger.event === "purchase",
          )
          .map((r) => ({
            ruleId: r.id,
            priority: r.priority ?? 0,
            config: r.config,
          })),
      },
    });
    if (
      !resolution.success ||
      resolution.data.commission.rules.some(
        (r) => r.config.reward.currency !== currency,
      )
    )
      throw new ReferralError(
        "REFERRAL_CONDITIONS_NOT_MET",
        422,
        "Approved cash commission conditions are invalid",
      );
    return resolution.data;
  });
}

export async function recordMinorPurchase(
  db: DBType,
  raw: MinorPurchaseRequest,
) {
  const input = minorPurchaseRequestSchema.parse(raw);
  const { payload } = input;
  const snapshot = payload.referralSnapshot;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`purchase:${input.productId}:${payload.orderId}`},0))`,
    );
    const [definition] = await tx
      .select()
      .from(s.eventDefinition)
      .where(eq(s.eventDefinition.type, "purchase"));
    if (!definition)
      throw new ReferralError(
        "REFERRAL_UNAVAILABLE",
        503,
        "Purchase definition is not configured",
      );
    await tx
      .insert(s.participant)
      .values({
        productId: input.productId,
        externalId: payload.userId,
        ...payload.customer,
      })
      .onConflictDoNothing({
        target: [s.participant.productId, s.participant.externalId],
      });
    const [buyer] = await tx
      .select()
      .from(s.participant)
      .where(
        and(
          eq(s.participant.productId, input.productId),
          eq(s.participant.externalId, payload.userId),
        ),
      )
      .for("no key update");
    if (!buyer) throw new Error("Purchase participant missing");
    const metadata = {
      schemaVersion: 2 as const,
      source: "api" as const,
      orderId: payload.orderId,
      orderAmountMinor: payload.orderAmountMinor,
      currency: payload.currency,
      referralSnapshot: snapshot,
    };
    const [previous] = await tx
      .select()
      .from(s.event)
      .where(
        and(
          eq(s.event.productId, input.productId),
          eq(s.event.eventDefinitionId, definition.id),
          eq(s.event.businessKey, payload.orderId),
        ),
      );
    if (
      previous &&
      (previous.programId !== input.programId ||
        previous.participantId !== buyer.id ||
        !isDeepStrictEqual(previous.metadata, metadata) ||
        previous.occurredAt?.toISOString() !==
          new Date(input.timestamp).toISOString())
    )
      throw new ReferralError(
        "PURCHASE_CONFLICT",
        409,
        "Order retry conflicts with original purchase",
      );
    if (
      snapshot.firstPaidOnly &&
      buyer.firstPurchaseEventId &&
      buyer.firstPurchaseEventId !== previous?.id
    )
      throw new ReferralError(
        "REFERRAL_NOT_FIRST_PAYMENT",
        409,
        "First purchase already claimed",
      );
    if (
      snapshot.firstPaidOnly &&
      previous &&
      buyer.firstPurchaseEventId !== previous.id
    )
      throw new ReferralError(
        "PURCHASE_CONFLICT",
        409,
        "Stored first-purchase claim is inconsistent",
      );
    const [code] = await tx
      .select()
      .from(s.refcode)
      .where(
        and(
          eq(s.refcode.id, snapshot.attribution.codeId),
          eq(s.refcode.code, snapshot.attribution.codeValue),
          eq(s.refcode.productId, input.productId),
          eq(s.refcode.programId, input.programId),
          eq(
            s.refcode.participantId,
            snapshot.attribution.referrerParticipantId,
          ),
        ),
      );
    const [owner] = await tx
      .select()
      .from(s.participant)
      .where(
        and(
          eq(s.participant.id, snapshot.attribution.referrerParticipantId),
          eq(s.participant.productId, input.productId),
        ),
      );
    if (!code || !owner)
      throw new ReferralError(
        "PURCHASE_CONFLICT",
        409,
        "Accepted attribution no longer matches its scope",
      );
    if (
      owner.id === buyer.id ||
      (owner.ownerUserId && owner.ownerUserId === buyer.ownerUserId)
    )
      throw new ReferralError(
        "REFERRAL_SELF_REFERRAL",
        409,
        "Self-referral is not eligible",
      );
    for (const spec of snapshot.commission.rules) {
      const [rule] = await tx
        .select({ id: s.rewardRule.id })
        .from(s.rewardRule)
        .where(
          and(
            eq(s.rewardRule.id, spec.ruleId),
            eq(s.rewardRule.programId, input.programId),
          ),
        );
      if (!rule)
        throw new ReferralError(
          "PURCHASE_CONFLICT",
          409,
          "Accepted rule does not match program",
        );
    }
    await tx
      .update(s.participant)
      .set({ ...payload.customer, updatedAt: new Date() })
      .where(eq(s.participant.id, buyer.id));
    let event = previous;
    if (!event) {
      const [attribution] = await tx
        .insert(s.referral)
        .values({
          productId: input.productId,
          programId: input.programId,
          externalId: payload.userId,
          referrerId: owner.id,
          refcodeId: code.id,
          appliedCode: snapshot.attribution.codeValue,
        })
        .returning();
      if (!attribution) throw new Error("Attribution missing");
      [event] = await tx
        .insert(s.event)
        .values({
          productId: input.productId,
          programId: input.programId,
          participantId: buyer.id,
          referralId: attribution.id,
          eventDefinitionId: definition.id,
          businessKey: payload.orderId,
          metadata,
          occurredAt: new Date(input.timestamp),
          status: "pending",
        })
        .returning();
      if (!event) throw new Error("Purchase event missing");
      if (snapshot.firstPaidOnly) {
        const [claimed] = await tx
          .update(s.participant)
          .set({ firstPurchaseEventId: event.id })
          .where(
            and(
              eq(s.participant.id, buyer.id),
              sql`${s.participant.firstPurchaseEventId} IS NULL`,
            ),
          )
          .returning({ id: s.participant.id });
        if (!claimed)
          throw new ReferralError(
            "REFERRAL_NOT_FIRST_PAYMENT",
            409,
            "First purchase already claimed",
          );
      }
    }
    const rewards = await processEventRewards(tx, event.id, snapshot);
    if (rewards.length !== snapshot.commission.rules.length)
      throw new ReferralError(
        "PURCHASE_CONFLICT",
        409,
        "Frozen reward result is incomplete",
      );
    const [attribution] = await tx
      .select()
      .from(s.referral)
      .where(eq(s.referral.id, event.referralId!));
    if (
      attribution?.refcodeId !== code.id ||
      attribution.referrerId !== owner.id ||
      attribution.programId !== input.programId ||
      attribution.productId !== input.productId
    )
      throw new ReferralError(
        "PURCHASE_CONFLICT",
        409,
        "Purchase attribution differs",
      );
    return minorPurchaseResponseSchema.parse({
      success: true,
      message: "Purchase tracked successfully.",
      eventId: event.id,
      productId: input.productId,
      programId: input.programId,
      orderId: payload.orderId,
      codeId: attribution.refcodeId,
      customerExternalId: payload.userId,
      participantId: buyer.id,
      referralId: event.referralId,
      referrerParticipantId: owner.id,
      rewardIds: rewards.map((r) => r.id),
      rewards: rewards.map((r) => {
        const spec = snapshot.commission.rules.find(
          (spec) => spec.ruleId === r.rewardRuleId,
        );
        if (
          !spec ||
          r.participantId !== owner.id ||
          r.currency !== payload.currency ||
          r.rewardType !== "cash" ||
          r.amount === null
        )
          throw new ReferralError(
            "PURCHASE_CONFLICT",
            409,
            "Unexpected frozen reward result",
          );
        return {
          id: r.id,
          ruleId: r.rewardRuleId,
          participantId: r.participantId,
          type: "cash",
          amountMinor: decimalToMinor(r.amount),
          currency: r.currency,
          config: spec.config,
        };
      }),
      duplicate: !!previous,
    });
  });
}

export async function assertLegacyTrackingAllowed(
  db: Pick<DBType, "select">,
  programId?: string | null,
) {
  if (!programId) return;
  const [program] = await db
    .select()
    .from(s.program)
    .where(eq(s.program.id, programId));
  if (
    program?.status === "pending_approval" ||
    program?.config?.serverTracking ||
    program?.config?.rewardConfig?.firstPaidOnly ||
    (program?.config?.rewardConfig &&
      templateRequiresVerifiedPurchase(program.programTemplateId))
  )
    throw new ReferralError(
      "FORBIDDEN",
      403,
      "Verified server purchase contract required",
    );
}
