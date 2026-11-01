import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";
import { env } from "@/env";
import { getAuthReturnPath } from "@refref/auth/return";
import { withPasswordResetReturn } from "@/lib/auth-return";

/**
 * BetterAuth client setup with organization plugin for React components
 */
export const authClient = createAuthClient({
  // Base URL should match the server's baseURL
  baseURL: env.NEXT_PUBLIC_APP_URL,
  fetchOptions: {
    onRequest: (context) => {
      if (
        typeof window === "undefined" ||
        new URL(context.url, window.location.origin).pathname !==
          "/api/auth/request-password-reset"
      )
        return;
      const destination = getAuthReturnPath(
        new URLSearchParams(window.location.search).get("redirectTo"),
      );
      if (!destination || typeof context.body !== "string") return;
      const body: unknown = JSON.parse(context.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) return;
      context.body = JSON.stringify(
        withPasswordResetReturn(
          body as Record<string, unknown>,
          destination,
          env.NEXT_PUBLIC_APP_URL,
        ),
      );
    },
  },

  // Add the organization client plugin
  plugins: [
    adminClient(),
    apiKeyClient(),
    organizationClient(),
    magicLinkClient(),
  ],
});

// Export commonly used auth client methods
export const {
  // Session management
  useSession,
  getSession,

  // Authentication methods
  signIn,
  signUp,
  signOut,

  // Organization-related hooks and methods
  useListOrganizations,
  useActiveOrganization,
  useActiveMember,

  // Organization management methods
  organization,
} = authClient;

// Export specific organization methods for convenience
export const {
  inviteMember,
  cancelInvitation,
  updateMemberRole,
  removeMember,
  listInvitations,
  acceptInvitation,
} = authClient.organization;
