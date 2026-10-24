/**
 * @refref/better-auth
 *
 * Better Auth integration for RefRef referral tracking.
 * Automatically tracks user signups with referral attribution.
 */

// Main plugin export
export { refrefAnalytics } from "./plugin";

// Type exports
export type {
  RefRefPluginOptions,
  SignupTrackingData,
  TrackingResponse,
  SignupTrackingPayload,
  PurchaseTrackingPayload,
  TrackingEventData,
} from "./types";

// Utility exports (for advanced usage)
export { RefRefAPIClient } from "./utils/api-client";
export type { ReferralApiResult } from "./utils/api-client";
export {
  referralCodeResolutionSchema,
  resolveReferralRequestSchema,
  referralSnapshotV1Schema,
  minorPurchaseRequestSchema,
  minorPurchaseResponseSchema,
} from "@refref/types";
export type {
  ReferralCodeResolution,
  ReferralSnapshotV1,
  MinorPurchaseRequest,
  MinorPurchaseResponse,
} from "@refref/types";
export {
  extractRefcodeFromRequest,
  extractRefcodeFromContext,
} from "./utils/cookie";
