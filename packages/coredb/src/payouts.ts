import { and, eq, inArray, sql } from "drizzle-orm";
import type { DBType } from "./index.js";
import type { CoreTransaction } from "./reward-engine.js";
import * as s from "./schema.js";
import {
  checkedMinor,
  currencySchema,
  payoutRecipientInputSchema,
  type CurrencyType,
  type PayoutRecipientInput,
} from "@refref/types";
import { ReferralError, verifiedPersonAccount } from "./referrals.js";

export async function lockParticipantCurrency(
  tx: CoreTransaction,
  productId: string,
  participantId: string,
  currency: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${productId}:${participantId}:${currency}`},0))`,
  );
}
export async function participantBalances(
  db: Pick<DBType, "select">,
  productId: string,
  participantId: string,
  currencies: readonly CurrencyType[],
) {
  const earnings = await db
    .select({
      currency: s.reward.currency,
      minor: sql<string>`COALESCE(sum(${s.reward.amount})*100,0)::text`,
    })
    .from(s.reward)
    .innerJoin(s.program, eq(s.reward.programId, s.program.id))
    .where(
      and(
        eq(s.program.productId, productId),
        eq(s.reward.participantId, participantId),
        inArray(s.reward.currency, currencies),
        eq(s.reward.rewardType, "cash"),
        eq(s.reward.status, "approved"),
        sql`${s.reward.disbursedAt} IS NULL`,
      ),
    )
    .groupBy(s.reward.currency);
  const payouts = await db
    .select({
      currency: s.payout.currency,
      reserved: sql<string>`COALESCE(sum(${s.payout.amountMinor}) FILTER (WHERE ${s.payout.status} IN ('requested','processing')),0)::text`,
      completed: sql<string>`COALESCE(sum(${s.payout.amountMinor}) FILTER (WHERE ${s.payout.status} = 'completed'),0)::text`,
    })
    .from(s.payout)
    .where(
      and(
        eq(s.payout.productId, productId),
        eq(s.payout.participantId, participantId),
        inArray(s.payout.currency, currencies),
        inArray(s.payout.status, ["requested", "processing", "completed"]),
      ),
    )
    .groupBy(s.payout.currency);
  return currencies.map((currency) => {
    const earned = earnings.find((row) => row.currency === currency);
    const paid = payouts.find((row) => row.currency === currency);
    // sum(numeric)*100 is exact; PostgreSQL may emit a trailing .00, not binary floating point.
    const earnedMinor = BigInt((earned?.minor ?? "0").split(".")[0]!);
    const eligibleMinor =
      earnedMinor < 0n
        ? -checkedMinor(-earnedMinor)
        : checkedMinor(earnedMinor);
    const reservedMinor = checkedMinor(BigInt(paid?.reserved ?? "0"));
    const completedMinor = checkedMinor(BigInt(paid?.completed ?? "0"));
    const available =
      earnedMinor - BigInt(reservedMinor) - BigInt(completedMinor);
    return {
      currency,
      eligibleMinor,
      reservedMinor,
      completedMinor,
      availableMinor:
        available < 0n ? -checkedMinor(-available) : checkedMinor(available),
    };
  });
}
export async function ownParticipant(
  db: Pick<DBType, "select">,
  userId: string,
  productId: string,
) {
  const [owner] = await db
    .select()
    .from(s.participant)
    .where(
      and(
        eq(s.participant.productId, productId),
        eq(s.participant.ownerUserId, userId),
      ),
    )
    .limit(1);
  if (!owner?.ownershipVerifiedAt || !owner.ownershipVerifiedBy)
    throw new ReferralError(
      "FORBIDDEN",
      403,
      "Verified participant ownership required",
    );
  await verifiedPersonAccount(db, userId);
  return owner;
}
export async function requestParticipantPayout(
  db: DBType,
  userId: string,
  input: {
    productId: string;
    currency: CurrencyType;
    amountMinor: number;
    idempotencyKey: string;
    recipient: PayoutRecipientInput;
  },
) {
  const recipient = payoutRecipientInputSchema.parse(input.recipient);
  return db.transaction(async (tx) => {
    const owner = await ownParticipant(tx, userId, input.productId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout-request:${input.productId}:${owner.id}:${input.idempotencyKey}`},0))`,
    );
    await lockParticipantCurrency(
      tx,
      input.productId,
      owner.id,
      input.currency,
    );
    const [prior] = await tx
      .select()
      .from(s.payout)
      .where(
        and(
          eq(s.payout.productId, input.productId),
          eq(s.payout.participantId, owner.id),
          eq(s.payout.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (prior) {
      if (
        prior.amountMinor !== input.amountMinor ||
        prior.currency !== input.currency ||
        prior.requestedBy !== userId ||
        prior.recipient.name !== recipient.name ||
        prior.recipient.details !== recipient.details
      )
        throw new ReferralError(
          "PAYOUT_CONFLICT",
          409,
          "Idempotency key differs from original request",
        );
      return prior;
    }
    const amount = checkedMinor(input.amountMinor);
    if (amount === 0)
      throw new ReferralError(
        "INVALID_REQUEST",
        400,
        "Payout must be positive",
      );
    const balance = (
      await participantBalances(tx, input.productId, owner.id, [input.currency])
    )[0]!;
    if (balance.availableMinor < amount)
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Insufficient approved available earnings",
      );
    const recipientSnapshot = {
      ...recipient,
      providedBy: userId,
      providedAt: new Date().toISOString(),
    };
    await tx
      .update(s.participant)
      .set({
        payoutRecipient: recipientSnapshot,
        updatedAt: new Date(),
      })
      .where(eq(s.participant.id, owner.id));
    const [created] = await tx
      .insert(s.payout)
      .values({
        productId: input.productId,
        participantId: owner.id,
        currency: input.currency,
        amountMinor: amount,
        requestedBy: userId,
        recipient: recipientSnapshot,
        idempotencyKey: input.idempotencyKey,
        status: "requested",
        audit: [
          {
            actorId: userId,
            status: "requested",
            at: new Date().toISOString(),
          },
        ],
      })
      .returning();
    if (!created) throw new Error("Payout request missing");
    return created;
  });
}
export async function claimPayout(
  db: DBType,
  actorId: string,
  productId: string,
  payoutId: string,
  executionNamespace: string,
) {
  if (!executionNamespace.trim())
    throw new ReferralError(
      "PAYOUT_UNAVAILABLE",
      503,
      "Manual execution account namespace must be configured",
    );
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(s.payout)
      .where(and(eq(s.payout.id, payoutId), eq(s.payout.productId, productId)));
    if (!initial) throw new ReferralError("NOT_FOUND", 404, "Payout not found");
    await lockParticipantCurrency(
      tx,
      productId,
      initial.participantId,
      initial.currency,
    );
    const [payout] = await tx
      .select()
      .from(s.payout)
      .where(eq(s.payout.id, initial.id))
      .for("update");
    if (!payout) throw new Error("Payout missing");
    if (
      payout.status === "processing" &&
      payout.assignedTo === actorId &&
      payout.executionNamespace === executionNamespace
    )
      return payout;
    if (payout.status !== "requested")
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Payout is not available to claim",
      );
    const [claimed] = await tx
      .update(s.payout)
      .set({
        status: "processing",
        assignedTo: actorId,
        executionMethod: "manual",
        provider: "manual",
        executionNamespace,
        updatedAt: new Date(),
        audit: [
          ...payout.audit,
          { actorId, status: "processing", at: new Date().toISOString() },
        ],
      })
      .where(and(eq(s.payout.id, payoutId), eq(s.payout.status, "requested")))
      .returning();
    if (!claimed)
      throw new ReferralError("PAYOUT_CONFLICT", 409, "Payout already claimed");
    return claimed;
  });
}
// Provider-neutral settlement boundary: authorized manual confirmation today, verified provider evidence later.
export async function completePayout(
  db: DBType,
  actorId: string,
  input: {
    productId: string;
    payoutId: string;
    amountMinor: number;
    currency: CurrencyType;
    externalReference: string;
    completedAt: string;
    idempotencyKey: string;
  },
) {
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(s.payout)
      .where(
        and(
          eq(s.payout.productId, input.productId),
          eq(s.payout.id, input.payoutId),
        ),
      );
    if (!initial) throw new ReferralError("NOT_FOUND", 404, "Payout not found");
    await lockParticipantCurrency(
      tx,
      input.productId,
      initial.participantId,
      initial.currency,
    );
    const [payout] = await tx
      .select()
      .from(s.payout)
      .where(eq(s.payout.id, initial.id))
      .for("update");
    if (!payout) throw new Error("Payout missing");
    if (
      payout.amountMinor !== input.amountMinor ||
      payout.currency !== input.currency
    )
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Transfer amount/currency differs from reservation",
      );
    const completedAt = new Date(input.completedAt);
    if (
      !Number.isFinite(completedAt.getTime()) ||
      completedAt.getTime() > Date.now() ||
      completedAt.getTime() < payout.createdAt.getTime()
    )
      throw new ReferralError(
        "INVALID_REQUEST",
        400,
        "Invalid transfer completion time",
      );
    if (payout.status === "completed") {
      if (
        payout.confirmedBy === actorId &&
        payout.confirmationKey === input.idempotencyKey &&
        payout.externalReference === input.externalReference &&
        payout.completedAt?.getTime() === completedAt.getTime()
      )
        return payout;
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Completed payout is immutable",
      );
    }
    if (
      payout.status !== "processing" ||
      payout.assignedTo !== actorId ||
      payout.executionMethod !== "manual" ||
      !payout.provider ||
      !payout.executionNamespace
    )
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Only the assigned manual operator can confirm this payout",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payout-transfer:${payout.executionNamespace}:${payout.provider}:${input.externalReference}`},0))`,
    );
    const [conflict] = await tx
      .select({ id: s.payout.id })
      .from(s.payout)
      .where(
        and(
          eq(s.payout.executionNamespace, payout.executionNamespace),
          eq(s.payout.provider, payout.provider),
          eq(s.payout.externalReference, input.externalReference),
        ),
      )
      .limit(1);
    if (conflict)
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "External transfer reference already used",
      );
    const [result] = await tx
      .update(s.payout)
      .set({
        status: "completed",
        confirmedBy: actorId,
        externalReference: input.externalReference,
        confirmationKey: input.idempotencyKey,
        completedAt,
        updatedAt: new Date(),
        audit: [
          ...payout.audit,
          { actorId, status: "completed", at: new Date().toISOString() },
        ],
      })
      .where(
        and(
          eq(s.payout.id, payout.id),
          eq(s.payout.status, "processing"),
          eq(s.payout.assignedTo, actorId),
        ),
      )
      .returning();
    if (!result)
      throw new ReferralError("PAYOUT_CONFLICT", 409, "Payout state changed");
    return result;
  });
}
export async function rejectPayout(
  db: DBType,
  actorId: string,
  input: {
    productId: string;
    payoutId: string;
    reason: string;
    transferNotExecutedVerified: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select()
      .from(s.payout)
      .where(
        and(
          eq(s.payout.id, input.payoutId),
          eq(s.payout.productId, input.productId),
        ),
      );
    if (!initial) throw new ReferralError("NOT_FOUND", 404, "Payout not found");
    await lockParticipantCurrency(
      tx,
      input.productId,
      initial.participantId,
      initial.currency,
    );
    const [payout] = await tx
      .select()
      .from(s.payout)
      .where(eq(s.payout.id, initial.id))
      .for("update");
    if (!payout) throw new Error("Payout missing");
    if (payout.status === "rejected") return payout;
    if (
      payout.status === "completed" ||
      (payout.status === "processing" &&
        (!input.transferNotExecutedVerified || payout.assignedTo !== actorId))
    )
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Unknown or completed transfer cannot release its reservation",
      );
    const [result] = await tx
      .update(s.payout)
      .set({
        status: "rejected",
        updatedAt: new Date(),
        audit: [
          ...payout.audit,
          {
            actorId,
            status: "rejected",
            at: new Date().toISOString(),
            reason: input.reason,
          },
        ],
      })
      .where(eq(s.payout.id, payout.id))
      .returning();
    return result!;
  });
}
export async function updateRewardApproval(
  db: DBType,
  productId: string,
  rewardId: string,
  status: "approved" | "rejected" | "pending_disbursal",
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ reward: s.reward })
      .from(s.reward)
      .innerJoin(s.program, eq(s.reward.programId, s.program.id))
      .where(
        and(eq(s.reward.id, rewardId), eq(s.program.productId, productId)),
      );
    if (!row) throw new ReferralError("NOT_FOUND", 404, "Reward not found");
    const currency = currencySchema.safeParse(row.reward.currency);
    await lockParticipantCurrency(
      tx,
      productId,
      row.reward.participantId,
      row.reward.currency ?? "unknown",
    );
    const [current] = await tx
      .select()
      .from(s.reward)
      .where(eq(s.reward.id, rewardId))
      .for("update");
    if (!current || current.status === "disbursed" || current.disbursedAt)
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Legacy disbursed reward is immutable",
      );
    const [updated] = await tx
      .update(s.reward)
      .set({ status, updatedAt: new Date() })
      .where(eq(s.reward.id, rewardId))
      .returning();
    if (current.rewardType === "cash" && currency.success) {
      const balance = (
        await participantBalances(tx, productId, current.participantId, [
          currency.data,
        ])
      )[0]!;
      if (
        balance.availableMinor < 0 &&
        (balance.reservedMinor > 0 || balance.completedMinor > 0)
      )
        throw new ReferralError(
          "PAYOUT_CONFLICT",
          409,
          "Reward change would remove reserved or paid earnings",
        );
    }
    return updated!;
  });
}
export async function markLegacyRewardDisbursed(
  db: DBType,
  productId: string,
  rewardId: string,
) {
  return db.transaction(async (tx) => {
    const [initial] = await tx
      .select({ reward: s.reward, program: s.program })
      .from(s.reward)
      .innerJoin(s.program, eq(s.reward.programId, s.program.id))
      .where(
        and(eq(s.reward.id, rewardId), eq(s.program.productId, productId)),
      );
    if (!initial) throw new ReferralError("NOT_FOUND", 404, "Reward not found");
    await lockParticipantCurrency(
      tx,
      productId,
      initial.reward.participantId,
      initial.reward.currency ?? "unknown",
    );
    const [owner] = await tx
      .select()
      .from(s.participant)
      .where(eq(s.participant.id, initial.reward.participantId))
      .for("update");
    if (
      initial.reward.rewardType === "cash" &&
      (owner?.ownerUserId ||
        initial.program.config?.serverTracking ||
        initial.program.config?.rewardConfig?.firstPaidOnly)
    )
      throw new ReferralError(
        "FORBIDDEN",
        403,
        "Use participant payout requests; whole-reward disbursal is closed",
      );
    const [current] = await tx
      .select()
      .from(s.reward)
      .where(eq(s.reward.id, rewardId))
      .for("update");
    if (
      !current ||
      current.status === "rejected" ||
      current.status === "disbursed"
    )
      throw new ReferralError(
        "PAYOUT_CONFLICT",
        409,
        "Reward cannot be disbursed",
      );
    const [result] = await tx
      .update(s.reward)
      .set({
        status: "disbursed",
        disbursedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(s.reward.id, rewardId))
      .returning();
    return result!;
  });
}
