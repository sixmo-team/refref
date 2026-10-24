import { getAuth } from "@refref/auth";
import { db, schema } from "@/server/db";
import { env } from "@/env";
import { logger } from "@/lib/logger";

// Create auth instance using the factory function from @refref/auth
export const auth = getAuth({
  baseURL: env.NEXT_PUBLIC_APP_URL,
  resendApiKey: env.RESEND_API_KEY || "",
  db,
  schema,
  enabledSocialAuth: env.NEXT_PUBLIC_ENABLED_SOCIAL_AUTH,
  enablePasswordAuth: env.NEXT_PUBLIC_ENABLE_PASSWORD_AUTH,
  enableMagicLinkAuth: env.NEXT_PUBLIC_ENABLE_MAGIC_LINK_AUTH,
  disableSignUp: env.DISABLE_SIGN_UP,
  google: env.GOOGLE_CLIENT_ID
    ? {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      }
    : undefined,
  logger,
  trustedOrigins: [env.NEXT_PUBLIC_APP_URL],
  emailFrom: env.NOTIFICATIONS_EMAIL_FROM,
});
