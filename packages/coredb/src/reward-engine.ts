import { and, eq, desc, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { randomInt } from "node:crypto";
import type { DBType } from "./index.js";
import * as s from "./schema.js";
import { validateEventScope } from "./security.js";
import {
  rewardRuleConfigV1Schema,
  currencySchema,
  eventMetadataSchema,
  decimalToMinor,
  minorToDecimal,
  percentOfMinor,
  legacyRewardMinor,
  templateRequiresVerifiedPurchase,
  type ReferralSnapshotV1,
  type RewardRuleConfigV1Type,
  type RewardMetadataV1Type,
} from "@refref/types";
export type CoreTransaction = Parameters<
  Parameters<DBType["transaction"]>[0]
>[0];
function frozenCommissionMinor(
  snapshot: ReferralSnapshotV1,
  config: RewardRuleConfigV1Type,
) {
  const base =
    snapshot.commission.basis === "base_amount"
      ? snapshot.pricing.baseAmountMinor
      : snapshot.pricing.payableAmountMinor;
  return config.reward.unit === "percent"
    ? percentOfMinor(base, String(config.reward.amount))
    : decimalToMinor(String(config.reward.amount));
}
function assertFrozenRewards(
  rewards: Array<typeof s.reward.$inferSelect>,
  snapshot: ReferralSnapshotV1,
) {
  if (
    rewards.length !== snapshot.commission.rules.length ||
    snapshot.commission.rules.some(
      (spec) =>
        !rewards.some(
          (result) =>
            result.rewardRuleId === spec.ruleId &&
            result.participantId ===
              snapshot.attribution.referrerParticipantId &&
            result.currency === snapshot.pricing.currency &&
            result.rewardType === "cash" &&
            result.amount !== null &&
            decimalToMinor(result.amount) ===
              frozenCommissionMinor(snapshot, spec.config),
        ),
    )
  )
    throw new Error("Expected frozen rewards missing or inconsistent");
}

// Legacy callers persist the event before processing; V2 instead calls the atomic transaction function.
export async function processEventForRewards(
  db: DBType,
  eventId: string,
  missingPercentageBase?: number,
) {
  try {
    return await db.transaction((tx) =>
      processEventRewards(tx, eventId, undefined, missingPercentageBase),
    );
  } catch (error) {
    try {
      await db
        .update(s.event)
        .set({ status: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(s.event.id, eventId),
            eq(s.event.status, "pending"),
            sql`(${s.event.metadata} IS NULL OR ${s.event.metadata}->>'schemaVersion' = '1')`,
          ),
        );
    } catch {
      console.error("Failed to persist legacy event failure status");
    }
    throw error;
  }
}
export async function processEventRewards(
  tx: CoreTransaction,
  eventId: string,
  frozen?: ReferralSnapshotV1,
  missingPercentageBase?: number,
) {
  const [event] = await tx
    .select()
    .from(s.event)
    .where(eq(s.event.id, eventId))
    .for("update");
  if (!event) throw new Error("Event not found");
  await validateEventScope(tx, event);
  const metadata = eventMetadataSchema.parse(
    event.metadata ?? { schemaVersion: 1 },
  );
  if (
    frozen &&
    (metadata.schemaVersion !== 2 ||
      !isDeepStrictEqual(frozen, metadata.referralSnapshot))
  )
    throw new Error("Frozen purchase terms differ");
  const existing = await tx
    .select()
    .from(s.reward)
    .where(eq(s.reward.eventId, eventId));
  if (event.status === "processed") {
    if (frozen) assertFrozenRewards(existing, frozen);
    return existing;
  }
  if (!event.programId) {
    await tx
      .update(s.event)
      .set({ status: "processed" })
      .where(eq(s.event.id, eventId));
    return [];
  }
  const [program] = await tx
    .select()
    .from(s.program)
    .where(eq(s.program.id, event.programId));
  const [definition] = await tx
    .select()
    .from(s.eventDefinition)
    .where(eq(s.eventDefinition.id, event.eventDefinitionId));
  if (!program || !definition)
    throw new Error("Missing event program/definition");
  if (
    (program.status === "pending_approval" ||
      program.config?.serverTracking ||
      program.config?.rewardConfig?.firstPaidOnly ||
      (program.config?.rewardConfig &&
        templateRequiresVerifiedPurchase(program.programTemplateId))) &&
    metadata.schemaVersion !== 2
  )
    throw new Error("Verified server purchase contract required");
  if (metadata.schemaVersion === 2) {
    if (!frozen || !isDeepStrictEqual(frozen, metadata.referralSnapshot))
      throw new Error("Frozen purchase terms required");
  }
  const rules = frozen
    ? frozen.commission.rules.map((r) => ({ id: r.ruleId, config: r.config }))
    : await tx
        .select()
        .from(s.rewardRule)
        .where(
          and(
            eq(s.rewardRule.programId, program.id),
            eq(s.rewardRule.isActive, true),
          ),
        )
        .orderBy(desc(s.rewardRule.priority));
  const [attribution] = event.referralId
    ? await tx
        .select()
        .from(s.referral)
        .where(eq(s.referral.id, event.referralId))
    : [];
  for (const rule of rules) {
    if (rule.config?.trigger?.event !== definition.type) continue;
    const config = rewardRuleConfigV1Schema.parse(rule.config);
    const participantId =
      config.participantType === "referrer"
        ? attribution?.referrerId
        : event.participantId;
    if (!participantId) {
      if (frozen) throw new Error("Expected reward recipient missing");
      continue;
    }
    if (config.conditions?.firstPaidOnly && metadata.schemaVersion !== 2)
      continue;
    const amountMinor =
      metadata.schemaVersion === 2
        ? frozenCommissionMinor(metadata.referralSnapshot, config)
        : legacyRewardMinor(
            config.reward.amount,
            config.reward.unit === "percent"
              ? metadata.orderAmount || missingPercentageBase
              : undefined,
          );
    const amount = minorToDecimal(amountMinor);
    // Legacy engines issued USD for omitted or unsupported rule currencies.
    const configuredCurrency = currencySchema.safeParse(config.reward.currency);
    const currency = configuredCurrency.success
      ? configuredCurrency.data
      : "USD";
    if (metadata.schemaVersion === 2 && currency !== metadata.currency)
      throw new Error("Reward purchase currency mismatch");
    const rewardMetadata: RewardMetadataV1Type = {
      schemaVersion: 1,
      notes: `Generated from ${definition.name} event`,
    };
    if (metadata.schemaVersion === 1 && config.reward.type === "discount") {
      const validUntil = new Date();
      validUntil.setUTCDate(
        validUntil.getUTCDate() + (config.reward.validityDays ?? 30),
      );
      rewardMetadata.couponCode = `REF-${randomInt(36 ** 6)
        .toString(36)
        .padStart(6, "0")
        .toUpperCase()}`;
      rewardMetadata.validUntil = validUntil.toISOString();
      const minimum =
        config.reward.minPurchaseAmount ??
        (config.reward.unit === "percent" ? 50 : undefined);
      if (minimum !== undefined) rewardMetadata.minPurchaseAmount = minimum;
    }
    await tx
      .insert(s.reward)
      .values({
        participantId,
        programId: program.id,
        rewardRuleId: rule.id,
        eventId,
        rewardType: config.reward.type,
        amount,
        currency,
        status:
          config.reward.type === "cash" ? "pending_disbursal" : "approved",
        metadata: rewardMetadata,
      })
      .onConflictDoNothing({
        target: [
          s.reward.eventId,
          s.reward.rewardRuleId,
          s.reward.participantId,
        ],
      });
  }
  const rewards = await tx
    .select()
    .from(s.reward)
    .where(eq(s.reward.eventId, eventId));
  if (frozen) assertFrozenRewards(rewards, frozen);
  await tx
    .update(s.event)
    .set({ status: "processed", updatedAt: new Date() })
    .where(eq(s.event.id, eventId));
  return rewards;
}
