import { z } from "zod";
import {
  resolveReferralRequestSchema,
  referralCodeResolutionSchema,
  minorPurchaseRequestSchema,
  minorPurchaseResponseSchema,
  type MinorPurchaseRequest,
  type MinorPurchaseResponse,
  type ReferralCodeResolution,
} from "@refref/types";
import { trackingEventResponseSchema } from "../types";
import type {
  PurchaseTrackingPayload,
  SignupTrackingPayload,
  TrackingResponse,
} from "../types";
export type ReferralApiResult<T> =
  | { success: true; data: T }
  | { success: false; message: string; statusCode?: number; code?: string };
const errorSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
    .optional(),
});
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Existing server-side client; no auth plugin is needed to call its methods. */
export class RefRefAPIClient {
  private readonly apiUrl: string;
  constructor(
    private readonly apiKey: string,
    apiUrl: string,
  ) {
    if (!apiKey) throw new Error("RefRef API key is required");
    let base: URL;
    try {
      base = new URL(apiUrl);
    } catch {
      throw new Error("Invalid RefRef API base URL");
    }
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        "RefRef API base URL must use HTTP(S) without credentials, query or fragment",
      );
    this.apiUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
  }
  trackSignup(payload: SignupTrackingPayload): Promise<TrackingResponse> {
    return this.post("/v1/track/signup", payload, trackingEventResponseSchema);
  }
  trackPurchase(payload: PurchaseTrackingPayload): Promise<TrackingResponse>;
  trackPurchase(
    payload: MinorPurchaseRequest,
  ): Promise<ReferralApiResult<MinorPurchaseResponse>>;
  async trackPurchase(
    payload: PurchaseTrackingPayload | MinorPurchaseRequest,
  ): Promise<TrackingResponse | ReferralApiResult<MinorPurchaseResponse>> {
    if (!("orderAmountMinor" in payload.payload))
      return this.post(
        "/v1/track/purchase",
        payload,
        trackingEventResponseSchema,
      );
    const validated = minorPurchaseRequestSchema.safeParse(payload);
    if (!validated.success)
      return { success: false, message: "Invalid purchase contract" };
    const result = await this.post(
      "/v1/track/purchase",
      validated.data,
      minorPurchaseResponseSchema,
    );
    if (!result.success) return result;
    const ack = result.data;
    const snapshot = validated.data.payload.referralSnapshot;
    if (
      ack.productId !== payload.productId ||
      ack.programId !== payload.programId ||
      ack.orderId !== payload.payload.orderId ||
      ack.codeId !== snapshot.attribution.codeId ||
      ack.customerExternalId !== payload.payload.userId ||
      ack.referrerParticipantId !==
        snapshot.attribution.referrerParticipantId ||
      new Set(ack.rewardIds).size !== ack.rewardIds.length ||
      ack.rewards.length !== snapshot.commission.rules.length ||
      ack.rewardIds.length !== ack.rewards.length ||
      new Set(ack.rewards.map((r) => r.ruleId)).size !== ack.rewards.length ||
      new Set(ack.rewards.map((r) => r.id)).size !== ack.rewards.length ||
      ack.rewards.some((r) => {
        const spec = snapshot.commission.rules.find(
          (spec) => spec.ruleId === r.ruleId,
        );
        return (
          !spec ||
          !ack.rewardIds.includes(r.id) ||
          r.participantId !== snapshot.attribution.referrerParticipantId ||
          r.currency !== snapshot.pricing.currency ||
          JSON.stringify(spec.config) !== JSON.stringify(r.config)
        );
      })
    )
      return {
        success: false,
        message: "Purchase confirmation does not match frozen terms",
      };
    return result;
  }
  async resolveReferral(
    payload: z.input<typeof resolveReferralRequestSchema>,
    options?: { signal?: AbortSignal },
  ): Promise<ReferralApiResult<ReferralCodeResolution>> {
    const validated = resolveReferralRequestSchema.safeParse(payload);
    if (!validated.success)
      return { success: false, message: "Invalid referral request" };
    const result = await this.post(
      "/v1/referrals/resolve",
      validated.data,
      referralCodeResolutionSchema,
      options?.signal,
    );
    if (
      result.success &&
      (result.data.productId !== validated.data.productId ||
        result.data.programId !== validated.data.programId ||
        result.data.canonicalCode !== validated.data.code)
    )
      return { success: false, message: "Referral response scope differs" };
    return result;
  }
  private async post<T>(
    endpoint: string,
    payload: unknown,
    responseSchema: z.ZodType<T>,
    callerSignal?: AbortSignal,
  ): Promise<ReferralApiResult<T>> {
    try {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const response = await fetch(`${this.apiUrl}${endpoint}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
        },
        body: JSON.stringify(payload),
      });
      const length = response.headers.get("content-length");
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
      ) {
        await response.body?.cancel();
        throw new Error("Response too large");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body required");
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const json: unknown = JSON.parse(text);
      if (!response.ok) {
        const error = errorSchema.safeParse(json);
        return {
          success: false,
          message: `API request failed with status ${response.status}`,
          statusCode: response.status,
          ...(error.success && error.data.code
            ? { code: error.data.code }
            : {}),
        };
      }
      return { success: true, data: responseSchema.parse(json) };
    } catch {
      return { success: false, message: "Tracking request failed" };
    }
  }
}
