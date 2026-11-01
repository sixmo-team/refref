import { betterAuth } from "better-auth";
import type {
  Auth as BetterAuthInstance,
  BetterAuthOptions,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization } from "better-auth/plugins";
import type {
  DefaultOrganizationPlugin,
  OrganizationOptions,
} from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import type { ApiKeyClientPlugin } from "@better-auth/api-key/client";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import {
  renderMagicLinkEmail,
  renderInvitationEmail,
  renderVerificationEmail,
  renderResetPasswordEmail,
} from "@refref/email-templates";
import type { DBType, schema as databaseSchema } from "@refref/coredb";
import { sendPostboxEmail, type PostboxConfig } from "./postbox.js";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { validateAuthCallback } from "./return.js";
export { postboxConfigFromEnv } from "./postbox.js";
export type { PostboxConfig } from "./postbox.js";
import { eq, and, inArray } from "drizzle-orm";

type RefRefMagicLinkPlugin = ReturnType<typeof magicLink>;

type RefRefBasePlugins = [
  DefaultOrganizationPlugin<OrganizationOptions>,
  ApiKeyClientPlugin["$InferServerPlugin"],
];

type RefRefAuthOptions = Omit<BetterAuthOptions, "plugins"> & {
  plugins: RefRefBasePlugins | [RefRefMagicLinkPlugin, ...RefRefBasePlugins];
};

export type RefRefAuth = BetterAuthInstance<RefRefAuthOptions>;

export interface AuthConfig {
  /**
   * Base URL for the application (e.g., https://app.refref.ai)
   */
  baseURL: string;

  /** Independent RefRef mail configuration; absent configuration fails only on actual sends. */
  postbox?: PostboxConfig;

  /**
   * Database instance
   */
  db: DBType;

  /**
   * Database schema
   */
  schema: typeof databaseSchema;

  /**
   * Enabled social auth providers
   */
  enabledSocialAuth: string[];

  /**
   * Enable password authentication
   */
  enablePasswordAuth: boolean;

  /**
   * Enable magic link authentication
   */
  enableMagicLinkAuth: boolean;
  disableSignUp?: boolean;

  /**
   * Google OAuth credentials (optional)
   */
  google?: {
    clientId: string;
    clientSecret: string;
  };

  /**
   * Logger instance
   */
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };

  /**
   * Trusted origins for CORS
   */
  trustedOrigins?: string[];
}

/**
 * Creates a Better Auth instance with the provided configuration
 */
export function getAuth(config: AuthConfig): RefRefAuth {
  const {
    baseURL,
    postbox,
    db,
    schema,
    enabledSocialAuth,
    enablePasswordAuth,
    enableMagicLinkAuth,
    disableSignUp = false,
    google,
    logger,
    trustedOrigins = [baseURL],
  } = config;
  const emailClient = new SESv2Client({
    endpoint: "https://postbox.cloud.yandex.net",
    region: "ru-central1",
    ...(postbox?.credentials ? { credentials: postbox.credentials } : {}),
  });

  // Build social providers object dynamically based on enabled providers
  const socialProviders = enabledSocialAuth.reduce(
    (acc, provider) => {
      if (provider === "google" && google) {
        return {
          ...acc,
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
          },
        };
      }
      // Add more providers here as needed (github, etc.)
      return acc;
    },
    {} as Record<string, { clientId: string; clientSecret: string }>,
  );

  async function sendLink(
    email: string,
    url: string,
    purpose: "verification" | "reset" | "magic-link",
  ) {
    const subject =
      purpose === "verification"
        ? "Verify your email address"
        : purpose === "reset"
          ? "Reset your password"
          : "Your Magic Link to Sign In";
    const html =
      purpose === "verification"
        ? await renderVerificationEmail(url)
        : purpose === "reset"
          ? await renderResetPasswordEmail(url)
          : await renderMagicLinkEmail(url);
    await sendPostboxEmail(emailClient, postbox, { to: email, subject, html });
  }
  const authLogger = {
    level: "warn",
    log: (level) => {
      if (logger) logger.error("Authentication diagnostic", { level });
      else console.error("Authentication diagnostic", { level });
    },
  } satisfies NonNullable<BetterAuthOptions["logger"]>;
  const backgroundTasks = {
    // ponytail: long-lived Node owns these tasks; use platform waitUntil for serverless.
    handler: (task: Promise<unknown>) => {
      void task.catch(() => authLogger.log("error"));
    },
  };

  return betterAuth<RefRefAuthOptions>({
    logger: authLogger,
    baseURL,
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: "refref",
      backgroundTasks,
    },
    socialProviders,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    emailAndPassword: {
      enabled: enablePasswordAuth,
      disableSignUp,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        backgroundTasks.handler(sendLink(user.email, url, "reset"));
      },
    },
    trustedOrigins,
    user: {
      changeEmail: { enabled: true, updateEmailWithoutVerification: false },
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        backgroundTasks.handler(sendLink(user.email, url, "verification"));
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Run for native signup/resend/reset/social/magic-link and callback routes alike.
        // Preserve Better Auth's own origin, token, expiry and rate-limit checks.
        for (const input of [ctx.body, ctx.query]) {
          if (!input || typeof input !== "object") continue;
          for (const key of [
            "callbackURL",
            "newUserCallbackURL",
            "errorCallbackURL",
            "redirectTo",
          ]) {
            try {
              validateAuthCallback(input[key], baseURL);
            } catch {
              throw new APIError("BAD_REQUEST", {
                message: "Invalid authentication return destination",
              });
            }
          }
        }
        if (ctx.path !== "/organization/list-invitations") return;
        const session = await getSessionFromCtx(ctx);
        if (!session) throw new APIError("UNAUTHORIZED");
        const organizationId =
          ctx.query?.organizationId ?? session.session.activeOrganizationId;
        if (typeof organizationId !== "string") throw new APIError("FORBIDDEN");
        const [member] = await db
          .select()
          .from(schema.orgUser)
          .where(
            and(
              eq(schema.orgUser.orgId, organizationId),
              eq(schema.orgUser.userId, session.user.id),
            ),
          )
          .limit(1);
        if (member?.role !== "owner" && member?.role !== "admin")
          throw new APIError("FORBIDDEN");
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith("/organization/")) return;
        const result = ctx.context.returned;
        if (
          !result ||
          typeof result !== "object" ||
          !("invitations" in result) ||
          !("id" in result) ||
          typeof result.id !== "string"
        )
          return;
        const session = await getSessionFromCtx(ctx);
        const [member] = session
          ? await db
              .select()
              .from(schema.orgUser)
              .where(
                and(
                  eq(schema.orgUser.orgId, result.id),
                  eq(schema.orgUser.userId, session.user.id),
                ),
              )
              .limit(1)
          : [];
        if (member?.role !== "owner" && member?.role !== "admin") {
          return ctx.json({ ...result, invitations: [] });
        }
      }),
    },
    plugins: [
      ...(enableMagicLinkAuth
        ? ([
            magicLink({
              disableSignUp,
              sendMagicLink: async ({ email, url }) => {
                backgroundTasks.handler(sendLink(email, url, "magic-link"));
              },
            }),
          ] as const)
        : ([] as const)),
      organization<OrganizationOptions>({
        requireEmailVerificationOnInvitation: true,
        schema: {
          organization: {
            modelName: "org",
          },
          session: {
            fields: {
              activeOrganizationId: "activeOrganizationId",
            },
          },
          member: {
            modelName: "orgUser",
            fields: {
              organizationId: "orgId",
            },
          },
          invitation: {
            modelName: "invitation",
            fields: {
              organizationId: "organizationId",
            },
          },
        },
        async sendInvitationEmail({ id, email, role, inviter }) {
          const inviteLink = `${baseURL}/accept-invitation/${id}`;

          const emailContent = await renderInvitationEmail({
            role,
            inviterName: inviter?.user?.name,
            inviterEmail: inviter?.user?.email,
            inviteLink,
          });

          await sendPostboxEmail(emailClient, postbox, {
            to: email,
            subject: "You've been invited to RefRef",
            html: emailContent,
          });
        },
        organizationHooks: {
          async afterAddMember({ member }) {
            try {
              const { product, productUser, program, programUser, user } =
                schema;

              // Check if user is a service account (service accounts have no email or special naming)
              const [userRecord] = await db
                .select()
                .from(user)
                .where(eq(user.id, member.userId))
                .limit(1);

              if (userRecord?.role === "service") return;

              // Get the product for this organization
              const [orgProduct] = await db
                .select()
                .from(product)
                .where(eq(product.orgId, member.organizationId))
                .limit(1);

              if (!orgProduct) {
                return;
              }

              // Add user to productUser table
              await db.insert(productUser).values({
                productId: orgProduct.id,
                userId: member.userId,
                role: member.role,
              });

              // Get all programs for this product
              const programs = await db
                .select()
                .from(program)
                .where(eq(program.productId, orgProduct.id));

              // Add user to all programs
              if (programs.length > 0) {
                await db.insert(programUser).values(
                  programs.map((prog) => ({
                    programId: prog.id,
                    userId: member.userId,
                    role: member.role,
                  })),
                );
              }
            } catch {
              logger?.error("Failed to sync member to product and programs");
              // Don't throw - allow member addition to succeed even if sync fails
            }
          },
          async beforeRemoveMember({ member }) {
            try {
              const { product, productUser, program, programUser } = schema;

              // Get the product for this organization
              const [orgProduct] = await db
                .select()
                .from(product)
                .where(eq(product.orgId, member.organizationId))
                .limit(1);

              if (!orgProduct) {
                return;
              }

              // Get all program IDs for this product
              const programs = await db
                .select({ id: program.id })
                .from(program)
                .where(eq(program.productId, orgProduct.id));

              // Remove from programUser entries for this product's programs
              if (programs.length > 0) {
                await db.delete(programUser).where(
                  and(
                    eq(programUser.userId, member.userId),
                    inArray(
                      programUser.programId,
                      programs.map((p) => p.id),
                    ),
                  ),
                );
              }

              // Remove from productUser table
              await db
                .delete(productUser)
                .where(
                  and(
                    eq(productUser.productId, orgProduct.id),
                    eq(productUser.userId, member.userId),
                  ),
                );
            } catch {
              logger?.error(
                "Failed to remove member from product and programs",
              );
              // Don't throw - allow member removal to succeed even if cleanup fails
            }
          },
        },
      }),
      apiKey({
        defaultPrefix: "prod_refref_key_",
        enableMetadata: true,
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
        keyExpiration: { maxExpiresIn: 730 },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (disableSignUp)
              throw new APIError("FORBIDDEN", {
                message: "Sign up is disabled",
              });
          },
          after: async (user) => {
            // Auto-create default organization for new users
            try {
              const { org: orgTable, orgUser } = schema;

              // Check if user is already a member of any organization
              const existingMembership = await db
                .select()
                .from(orgUser)
                .where(eq(orgUser.userId, user.id))
                .limit(1);

              if (existingMembership.length > 0) {
                return;
              }

              // Create default organization
              const [newOrg] = await db
                .insert(orgTable)
                .values({
                  name: `${user.name || user.email}'s Organization`,
                  slug: `org-${user.id.slice(0, 8)}`,
                })
                .returning();

              // Add user as owner of the organization
              await db.insert(orgUser).values({
                orgId: newOrg!.id,
                userId: user.id,
                role: "owner",
              });
            } catch {
              logger?.error("Failed to create default organization for user");
              // Don't throw - allow user creation to succeed even if org creation fails
            }
          },
        },
      },
    },
  });
}
