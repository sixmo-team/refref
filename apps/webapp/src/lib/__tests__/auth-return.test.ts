import { describe, expect, it, vi } from "vitest";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { getAuthReturnPath, validateAuthCallback } from "@refref/auth/return";
import {
  postboxConfigFromEnv,
  sendPostboxEmail,
} from "../../../../../packages/auth/src/postbox";
import { preserveAuthReturn, withPasswordResetReturn } from "../auth-return";

const origin = "https://app.example.test";
const entry = "/participant-portal/join/program-123";
describe("Safe native auth return context", () => {
  it("retains only the relative programme context through verification and native reset navigation", () => {
    expect(getAuthReturnPath(entry)).toBe(entry);
    expect(
      preserveAuthReturn(
        "/auth/email-verification?email=partner%40example.test",
        entry,
      ),
    ).toBe(
      `/auth/email-verification?email=partner%40example.test&redirectTo=${encodeURIComponent(entry)}`,
    );
    expect(
      preserveAuthReturn("/auth/sign-in?token=spent-reset-token", entry),
    ).toBe(`/auth/sign-in?redirectTo=${encodeURIComponent(entry)}`);
    expect(
      withPasswordResetReturn(
        {
          email: "test@example.test",
          redirectTo: `${origin}/auth/reset-password`,
        },
        entry,
        origin,
      ),
    ).toEqual({
      email: "test@example.test",
      redirectTo: `${origin}/auth/reset-password?redirectTo=${encodeURIComponent(entry)}`,
    });
  });
  it.each([
    "https://foreign.example",
    "//foreign.example",
    "/\\foreign.example",
    "/%2f%2fforeign.example",
    "/participant-portal/join/p?email=private",
    "/participant-portal/join/p#private",
    "/participant-portal/join/p/../other",
    "/participant-portal/join/p%2fother",
  ])("rejects invalid return %s", (value) => {
    expect(getAuthReturnPath(value)).toBeUndefined();
    expect(() => validateAuthCallback(value, origin)).toThrow(
      "Invalid authentication return destination",
    );
  });
  it("preserves general merchant and invitation returns, including native absolute callbacks", () => {
    expect(getAuthReturnPath("/")).toBe("/");
    expect(getAuthReturnPath("/accept-invitation/invitation-id")).toBe(
      "/accept-invitation/invitation-id",
    );
    expect(() =>
      validateAuthCallback(`${origin}${entry}`, origin),
    ).not.toThrow();
    expect(preserveAuthReturn("/dashboard", entry)).toBe("/dashboard");
  });
  it("keeps explicit native invitation returns, including when the current auth page has no fallback", () => {
    const invitation = `/auth/accept-invitation?invitationId=${crypto.randomUUID()}`;
    const target = `/auth/sign-in?redirectTo=${encodeURIComponent(invitation)}`;
    expect(preserveAuthReturn(target, undefined)).toBe(target);
    expect(preserveAuthReturn(`${target}&token=spent-reset-token`, entry)).toBe(
      target,
    );
  });
  it("rejects a control-character absolute callback before URL normalization", () => {
    expect(() =>
      validateAuthCallback(`${origin}/dashboard\u0085`, origin),
    ).toThrow();
  });
  it("rejects an external destination nested in a same-origin reset page", () => {
    expect(() =>
      validateAuthCallback(
        `${origin}/auth/reset-password?redirectTo=https%3A%2F%2Fforeign.example`,
        origin,
      ),
    ).toThrow();
  });
});
describe("Independent Postbox transport", () => {
  it("fails closed on missing sender or incomplete explicitly supplied credentials", async () => {
    const client = new SESv2Client({ region: "ru-central1" });
    const send = vi.spyOn(client, "send").mockImplementation(async () => ({
      $metadata: {},
      MessageId: crypto.randomUUID(),
    }));
    try {
      await expect(
        sendPostboxEmail(client, undefined, {
          to: "partner@example.test",
          subject: "Verify",
          html: "private",
        }),
      ).rejects.toThrow();
      const config = postboxConfigFromEnv({
        REFREF_POSTBOX_FROM: "auth@example.test",
        REFREF_POSTBOX_ACCESS_KEY_ID: "provided-alone",
      });
      await expect(
        sendPostboxEmail(client, config, {
          to: "partner@example.test",
          subject: "Verify",
          html: "private",
        }),
      ).rejects.toThrow();
    } finally {
      send.mockRestore();
      client.destroy();
    }
  });
});
