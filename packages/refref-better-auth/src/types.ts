import { z } from "zod";

/**
 * Configuration options for the RefRef Better Auth plugin
 */
export interface RefRefPluginOptions {
  /**
   * RefRef API key for authentication
   */
  apiKey: string;

  /**
   * Explicit URL of the operator's RefRef API; no third-party default.
   */
  apiUrl: string;

  /**
   * RefRef product ID
   */
  productId: string;

  /**
   * Optional program ID (if not provided, will use default program)
   */
  programId?: string;

  /**
   * Name of the cookie containing the referral code (default: "refref-refcode")
   */
  cookieName?: string;

  /**
   * Disable automatic signup tracking (default: false)
   */
  disableSignupTracking?: boolean;

  /**
   * Custom function to override the default signup tracking logic
   */
  customSignupTrack?: (data: SignupTrackingData) => Promise<void>;
}

/**
 * Data passed to the signup tracking function
 */
export interface SignupTrackingData {
  userId: string;
  email?: string;
  name?: string;
  refcode?: string;
  timestamp: string;
  productId: string;
  programId?: string;
}

export interface PurchaseTrackingPayload {
  timestamp: string;
  productId: string;
  programId?: string;
  payload: {
    userId: string;
    orderAmount: number;
    orderId: string;
    productIds?: string[];
    currency?: string;
  };
}

export const trackingEventResponseSchema = z.object({
  eventId: z.string().min(1),
  referralId: z.string().optional(),
  participantId: z.string().optional(),
});

export type TrackingEventData = z.infer<typeof trackingEventResponseSchema>;

/**
 * RefRef API response for tracking events
 */
export interface TrackingResponse {
  success: boolean;
  message?: string;
  data?: TrackingEventData;
}

/**
 * Schema for the signup tracking request payload
 */
export const signupTrackingSchema = z.object({
  timestamp: z.string(),
  productId: z.string(),
  programId: z.string().optional(),
  payload: z.object({
    userId: z.string(),
    refcode: z.string().optional(),
    email: z.string().email().optional(),
    name: z.string().optional(),
  }),
});

export type SignupTrackingPayload = z.infer<typeof signupTrackingSchema>;
