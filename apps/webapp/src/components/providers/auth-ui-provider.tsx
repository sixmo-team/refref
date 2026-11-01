"use client";

import { AuthUIProvider as BetterAuthUIProvider } from "@daveyplate/better-auth-ui";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { env } from "@/env";
import { getAuthReturnPath } from "@refref/auth/return";
import { preserveAuthReturn } from "@/lib/auth-return";

export function AuthUIProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const destinationFor = (href: string) =>
    preserveAuthReturn(
      href,
      typeof window === "undefined"
        ? undefined
        : getAuthReturnPath(
            new URLSearchParams(window.location.search).get("redirectTo"),
          ),
    );

  return (
    <BetterAuthUIProvider
      authClient={authClient}
      baseURL={env.NEXT_PUBLIC_APP_URL}
      navigate={(href) => router.push(destinationFor(href))}
      replace={(href) => router.replace(destinationFor(href))}
      onSessionChange={() => router.refresh()}
      Link={Link}
      localization={{
        SIGN_UP_EMAIL:
          "Registration request completed. If an account can be created, use its verification email. Delivery is not confirmed here.",
        FORGOT_PASSWORD_EMAIL:
          "If this account exists, a password reset was requested. Check your inbox; delivery is not confirmed here.",
        MAGIC_LINK_EMAIL:
          "If this account can sign in, a sign-in email was requested. Check your inbox; delivery is not confirmed here.",
      }}
      magicLink={env.NEXT_PUBLIC_ENABLE_MAGIC_LINK_AUTH}
      credentials={env.NEXT_PUBLIC_ENABLE_PASSWORD_AUTH}
      social={{
        providers: env.NEXT_PUBLIC_ENABLED_SOCIAL_AUTH,
      }}
      organization={{
        logo: true,
      }}
    >
      {children}
    </BetterAuthUIProvider>
  );
}
