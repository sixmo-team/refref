import { inspect } from "node:util";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import { refrefAnalytics } from "./plugin";
import type { SignupTrackingData } from "./types";

describe("native Better Auth signup attribution", () => {
  it.each([
    { disabled: false, trackingFails: false, direct: false },
    { disabled: true, trackingFails: false, direct: false },
    { disabled: false, trackingFails: true, direct: false },
    { disabled: false, trackingFails: false, direct: true },
  ])(
    "tracks only user creation without breaking authentication: %o",
    async ({ disabled, trackingFails, direct }) => {
      const signups: SignupTrackingData[] = [];
      const diagnostics: unknown[][] = [];
      const sensitiveError = "sdk-person+private@example.test";
      const consoleLog = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          diagnostics.push(args);
        });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          diagnostics.push(args);
        });
      const baseURL = "http://auth.example.test";
      const auth = betterAuth({
        baseURL,
        secret: "isolated-sdk-regression-secret-at-least-32-characters",
        database: memoryAdapter({
          user: [],
          account: [],
          session: [],
          verification: [],
        }),
        emailAndPassword: { enabled: true },
        rateLimit: { enabled: false },
        telemetry: { enabled: false },
        logger: { disabled: true },
        plugins: [
          refrefAnalytics({
            apiKey: "regression-only-key",
            apiUrl: "http://127.0.0.1:4310/tracking",
            productId: "regression-product",
            disableSignupTracking: disabled,
            customSignupTrack: async (data) => {
              signups.push(data);
              if (trackingFails) throw new Error(sensitiveError);
            },
          }),
        ],
      });
      const headers = {
        "content-type": "application/json",
        origin: baseURL,
        cookie: "refref-refcode=FROM%2FLINK",
      };
      const credentials = {
        name: "Referral regression",
        email: "signup@example.test",
        password: "regression-only-Strong42!",
      };
      try {
        const signup = direct
          ? await auth.api.signUpEmail({
              headers,
              body: credentials,
              asResponse: true,
            })
          : await auth.handler(
              new Request(`${baseURL}/api/auth/sign-up/email`, {
                method: "POST",
                headers,
                body: JSON.stringify(credentials),
              }),
            );
        expect(signup.status).toBe(200);
        expect(signups).toHaveLength(disabled ? 0 : 1);
        if (!disabled) expect(signups[0]?.refcode).toBe("FROM/LINK");

        const signin = await auth.handler(
          new Request(`${baseURL}/api/auth/sign-in/email`, {
            method: "POST",
            headers,
            body: JSON.stringify(credentials),
          }),
        );
        expect(signin.status).toBe(200);
        expect(signups).toHaveLength(disabled ? 0 : 1);
        expect(inspect(diagnostics)).not.toContain(sensitiveError);
      } finally {
        consoleLog.mockRestore();
        consoleError.mockRestore();
      }
    },
  );
});
