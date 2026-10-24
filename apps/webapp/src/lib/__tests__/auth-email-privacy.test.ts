import { describe, expect, it } from "vitest";
import {
  renderInvitationEmail,
  renderMagicLinkEmail,
} from "@refref/email-templates";

describe("Authentication email privacy", () => {
  it.each(["magic-link", "invitation"] as const)(
    "%s preserves the authentication link without remote passive resources",
    async (kind) => {
      const link = kind === "magic-link"
        ? "https://app.example/auth/magic-link/verify?token=private-test-token"
        : "https://app.example/accept-invitation/private-test-token";
      const html = kind === "magic-link"
        ? await renderMagicLinkEmail(link)
        : await renderInvitationEmail({
            role: "member",
            inviterName: "Test inviter",
            inviterEmail: "inviter@example.com",
            inviteLink: link,
          });

      expect(html).toContain(`href="${link}"`);
      expect(html).not.toMatch(
        /<(?:img|link|script)\b[^>]*(?:src|href)=["']https?:\/\//i,
      );
    },
  );
});
