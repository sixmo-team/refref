import type {
  BaseUser,
  BetterAuthPlugin,
  GenericEndpointContext,
} from "better-auth";
import type { RefRefPluginOptions, SignupTrackingData } from "./types";
import { extractRefcodeFromContext } from "./utils/cookie";
import { RefRefAPIClient } from "./utils/api-client";

/**
 * RefRef Better Auth Plugin
 *
 * Automatically tracks user signups with referral attribution
 * by extracting referral codes from cookies and calling the RefRef API.
 *
 * @example
 * ```typescript
 * import { betterAuth } from "better-auth";
 * import { refrefAnalytics } from "@refref/better-auth";
 *
 * export const auth = betterAuth({
 *   // ... other config
 *   plugins: [
 *     refrefAnalytics({
 *       apiKey: process.env.REFREF_API_KEY,
 *       productId: process.env.REFREF_PRODUCT_ID,
 *       apiUrl: "http://127.0.0.1:4310/tracking",
 *     })
 *   ]
 * });
 * ```
 */
export const refrefAnalytics = (
  options: RefRefPluginOptions,
): BetterAuthPlugin => {
  // Validate required options
  if (!options.productId) {
    throw new Error("RefRef plugin: productId is required");
  }

  // Initialize API client
  const apiClient = new RefRefAPIClient(options.apiKey, options.apiUrl);

  return {
    id: "refref-analytics",
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              after: async (
                user: BaseUser,
                context: GenericEndpointContext | null,
              ) => {
                if (options.disableSignupTracking) return;
                try {
                  const refcode = context
                    ? extractRefcodeFromContext(context, options.cookieName)
                    : undefined;
                  const trackingData: SignupTrackingData = {
                    userId: user.id,
                    email: user.email,
                    name: user.name,
                    refcode,
                    timestamp: new Date().toISOString(),
                    productId: options.productId,
                    programId: options.programId,
                  };
                  if (options.customSignupTrack) {
                    await options.customSignupTrack(trackingData);
                    return;
                  }
                  const result = await apiClient.trackSignup({
                    timestamp: trackingData.timestamp,
                    productId: trackingData.productId,
                    programId: trackingData.programId,
                    payload: {
                      userId: trackingData.userId,
                      refcode: trackingData.refcode,
                      email: trackingData.email,
                      name: trackingData.name,
                    },
                  });
                  if (!result.success)
                    console.error("RefRef signup tracking failed");
                } catch {
                  // Tracking must neither abort account creation nor expose user/error data.
                  console.error("RefRef signup tracking failed");
                }
              },
            },
          },
        },
      },
    }),
  };
};
