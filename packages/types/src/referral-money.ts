// calculationVersion 1: nonnegative rational amounts, round half-up once to minor units.
// Activation requires approved G1/G2 business terms and edge examples; this is not approval.
export const CALCULATION_VERSION = 1 as const;
export const MAX_REWARD_MINOR = 9_999_999_999;
function rational(value: string, scale: number): [bigint, bigint] {
  if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${scale}})?$`).test(value))
    throw new Error("Invalid decimal amount");
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}
function roundMinorHalfUp(numerator: bigint, denominator: bigint): number {
  return checkedMinor((numerator * 2n + denominator) / (denominator * 2n));
}
function legacyNumberRatio(value: number): [bigint, bigint] {
  if (!Number.isFinite(value)) throw new Error("Invalid legacy amount");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(
    String(Math.abs(value)),
  );
  if (!match) throw new Error("Invalid legacy decimal");
  const magnitude = BigInt(match[1]! + (match[2] ?? ""));
  const digits = value < 0 ? -magnitude : magnitude;
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  return exponent >= 0
    ? [digits * 10n ** BigInt(exponent), 1n]
    : [digits, 10n ** BigInt(-exponent)];
}
function roundLegacyMinor(numerator: bigint, denominator: bigint): number {
  // PostgreSQL numeric rounds signed ties away from zero, including V1 subcent amounts.
  return numerator < 0n
    ? -roundMinorHalfUp(-numerator, denominator)
    : roundMinorHalfUp(numerator, denominator);
}
// V1 remains major-unit and accepts its original numeric precision; do not round the base first.
export function legacyRewardMinor(
  amount: number,
  purchaseMajor?: number,
): number {
  const [n, d] = legacyNumberRatio(amount);
  if (purchaseMajor === undefined) return roundLegacyMinor(n * 100n, d);
  const [baseN, baseD] = legacyNumberRatio(purchaseMajor);
  return roundLegacyMinor(n * baseN, d * baseD);
}
export function legacyMinorToDecimal(value: number): string {
  // Only V1 may be signed; retain the native decimal(10,2) bound on its magnitude.
  return `${value < 0 ? "-" : ""}${minorToDecimal(Math.abs(value))}`;
}
export function checkedMinor(value: bigint | number): number {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Invalid minor amount");
  const n = BigInt(value);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Minor amount out of range");
  return Number(n);
}
export function decimalToMinor(value: string): number {
  const [n, d] = rational(value, 2);
  const result = checkedMinor((n * 100n) / d);
  if (result > MAX_REWARD_MINOR)
    throw new Error("Native reward amount out of range");
  return result;
}
export function minorToDecimal(value: number): string {
  const n = BigInt(checkedMinor(value));
  if (n > BigInt(MAX_REWARD_MINOR))
    throw new Error("Native reward amount out of range");
  return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
}
export function percentOfMinor(baseMinor: number, percent: string): number {
  const [n, d] = rational(percent, 6);
  if (n > 100n * d) throw new Error("Invalid percentage");
  const numerator = BigInt(checkedMinor(baseMinor)) * n;
  const denominator = d * 100n;
  return roundMinorHalfUp(numerator, denominator);
}
export function buyerDiscountMinor(
  discount:
    | { kind: "none" }
    | {
        kind: "fixed";
        amountMinor: number;
        minPurchaseAmountMinor: number | null;
      }
    | {
        kind: "percent";
        percentDecimal: string;
        minPurchaseAmountMinor: number | null;
      },
  baseMinor: number,
): number {
  checkedMinor(baseMinor);
  if (
    discount.kind === "none" ||
    (discount.minPurchaseAmountMinor !== null &&
      baseMinor < discount.minPurchaseAmountMinor)
  )
    return 0;
  return Math.min(
    baseMinor,
    discount.kind === "fixed"
      ? checkedMinor(discount.amountMinor)
      : percentOfMinor(baseMinor, discount.percentDecimal),
  );
}
