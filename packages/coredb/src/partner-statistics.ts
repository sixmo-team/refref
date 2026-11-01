import { sql } from "drizzle-orm";
import { checkedMinor, currencySchema, type CurrencyType } from "@refref/types";
import type { DBType } from "./index.js";
import * as s from "./schema.js";
import { ownParticipant } from "./payouts.js";
import { ReferralError } from "./referrals.js";

type CodeMetric = {
  currency: CurrencyType;
  paidPurchases: number;
  paidAmountMinor: number;
  pendingMinor: number;
  approvedMinor: number;
  rejectedMinor: number;
  disbursedMinor: number;
};
type CodeStatistics = {
  codeId: string;
  code: string;
  programId: string;
  programName: string;
  isActive: boolean;
  metrics: CodeMetric[];
};
type AggregateRow = {
  code_id: string;
  code: string;
  program_id: string;
  program_name: string;
  is_active: boolean;
  currency: string | null;
  paid_count: string | null;
  paid_minor: string | null;
  pending_minor: string;
  approved_minor: string;
  rejected_minor: string;
  disbursed_minor: string;
};
const minor = (amount: string | null) =>
  checkedMinor(BigInt((amount ?? "0").split(".")[0]!));

export async function partnerCodeStats(
  db: DBType,
  userId: string,
  input: {
    productId: string;
    from: Date;
    to: Date;
  },
): Promise<CodeStatistics[]> {
  const duration = input.to.getTime() - input.from.getTime();
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 366 * 86_400_000
  )
    throw new ReferralError(
      "INVALID_REQUEST",
      400,
      "Choose an interval of at most 366 days",
    );
  const owner = await ownParticipant(db, userId, input.productId);
  // Purchases are aggregated before rewards: two rules must not double one paid amount.
  const rows = await db.execute<AggregateRow>(sql`
    WITH own_codes AS (
      SELECT c.id, c.code, c.program_id, c.is_active, g.name AS program_name
      FROM ${s.refcode} c JOIN ${s.program} g ON g.id=c.program_id AND g.product_id=c.product_id
      WHERE c.product_id=${input.productId} AND c.participant_id=${owner.id}
    ), paid_events AS (
      SELECT e.id, r.refcode_id AS code_id, e.metadata->>'currency' AS currency,
             (e.metadata->>'orderAmountMinor')::numeric AS paid_minor
      FROM ${s.event} e
      JOIN ${s.referral} r ON r.id=e.referral_id AND r.product_id=e.product_id AND r.program_id=e.program_id
      JOIN own_codes c ON c.id=r.refcode_id AND c.program_id=e.program_id
      JOIN ${s.eventDefinition} d ON d.id=e.event_definition_id AND d.type='purchase'
      WHERE e.product_id=${input.productId} AND r.referrer_id=${owner.id}
        AND e.status='processed' AND e.metadata->>'schemaVersion'='2' AND e.metadata->>'source'='api'
        AND e.occurred_at >= ${input.from.toISOString()}::timestamptz
        AND e.occurred_at < ${input.to.toISOString()}::timestamptz
    ), purchases AS (
      SELECT code_id, currency, count(*)::text AS paid_count, sum(paid_minor)::text AS paid_minor
      FROM paid_events GROUP BY code_id, currency
    ), commissions AS (
      SELECT p.code_id, p.currency,
        (COALESCE(sum(w.amount) FILTER (WHERE w.status='pending_disbursal' AND w.disbursed_at IS NULL),0)*100)::text AS pending_minor,
        (COALESCE(sum(w.amount) FILTER (WHERE w.status='approved' AND w.disbursed_at IS NULL),0)*100)::text AS approved_minor,
        (COALESCE(sum(w.amount) FILTER (WHERE w.status='rejected' AND w.disbursed_at IS NULL),0)*100)::text AS rejected_minor,
        (COALESCE(sum(w.amount) FILTER (WHERE w.status='disbursed' OR w.disbursed_at IS NOT NULL),0)*100)::text AS disbursed_minor
      FROM paid_events p JOIN ${s.reward} w ON w.event_id=p.id AND w.currency=p.currency
      WHERE w.participant_id=${owner.id} AND w.reward_type='cash'
      GROUP BY p.code_id, p.currency
    )
    SELECT c.id AS code_id, c.code, c.program_id, c.program_name, c.is_active,
      p.currency, p.paid_count, p.paid_minor,
      COALESCE(w.pending_minor,'0') AS pending_minor, COALESCE(w.approved_minor,'0') AS approved_minor,
      COALESCE(w.rejected_minor,'0') AS rejected_minor, COALESCE(w.disbursed_minor,'0') AS disbursed_minor
    FROM own_codes c LEFT JOIN purchases p ON p.code_id=c.id
    LEFT JOIN commissions w ON w.code_id=p.code_id AND w.currency=p.currency
    ORDER BY c.program_name, c.id, p.currency
  `);
  const codes = new Map<string, CodeStatistics>();
  for (const row of rows) {
    let code = codes.get(row.code_id);
    if (!code) {
      code = {
        codeId: row.code_id,
        code: row.code,
        programId: row.program_id,
        programName: row.program_name,
        isActive: row.is_active,
        metrics: [],
      };
      codes.set(row.code_id, code);
    }
    if (row.currency)
      code.metrics.push({
        currency: currencySchema.parse(row.currency),
        paidPurchases: minor(row.paid_count),
        paidAmountMinor: minor(row.paid_minor),
        pendingMinor: minor(row.pending_minor),
        approvedMinor: minor(row.approved_minor),
        rejectedMinor: minor(row.rejected_minor),
        disbursedMinor: minor(row.disbursed_minor),
      });
  }
  return [...codes.values()];
}
