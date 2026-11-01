import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "@refref/coredb";
import { getAuth } from "@refref/auth";
import { hashPassword } from "better-auth/crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, inArray } from "drizzle-orm";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { renderToStaticMarkup } from "react-dom/server";
import winston from "winston";
import { logger as applicationLogger } from "@/lib/logger";
import { buildApp as buildApiApp } from "../../../../api/src/app";
import { buildApp as buildRedirectApp } from "../../../../refer/src/app";
import { coredbPlugin } from "@refref/utils";
import betterAuthPlugin from "../../../../api/src/plugins/better-auth";
import signupRoutes from "../../../../api/src/routes/v1/track/signup";
import purchaseRoutes from "../../../../api/src/routes/v1/track/purchase";
import programsRoutes from "../../../../api/src/routes/v1/programs";
import { processEventForRewards } from "@refref/coredb";
import type { AnyRouter } from "@trpc/server";
import { rewardRuleConfigV1Schema } from "@refref/types";
import { createCallerFactory, createTRPCContext } from "./trpc";
import { participantsRouter } from "./routers/participants";
import { eventsRouter } from "./routers/events";
import { analyticsRouter } from "./routers/analytics";
import { productMembersRouter } from "./routers/product-members";
import { productSecretsRouter } from "./routers/product-secrets";
import { userRouter } from "./routers/user";
import { apiKeysRouter } from "./routers/api-keys";
import { productRouter } from "./routers/product";
import AcceptInvitationPage from "../../app/accept-invitation/[token]/page";

const shared = vi.hoisted<{ requestHeaders: Headers | undefined }>(() => ({
  requestHeaders: undefined,
}));
vi.mock("@/server/db", () => ({
  get schema() {
    return schema;
  },
  get db() {
    return db;
  },
}));
vi.mock("@/lib/auth", () => ({
  get auth() {
    return auth;
  },
}));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_REFER_URL: "http://localhost:4310/r" },
}));
vi.mock("next/headers", () => ({
  headers: async () => shared.requestHeaders ?? new Headers(),
}));

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to a dedicated test database");
}
process.env.BETTER_AUTH_SECRET =
  "isolated-regression-secret-at-least-thirty-two-characters";
const db = createDb(url);
const auth = getAuth({
  baseURL: "http://localhost:4000",
  db,
  schema,
  enabledSocialAuth: [],
  enablePasswordAuth: true,
  enableMagicLinkAuth: true,
});
const id = randomUUID();
const ids = {
  orgA: `oa-${id}`,
  orgB: `ob-${id}`,
  productA: `pa-${id}`,
  productB: `pb-${id}`,
  programA: `ga-${id}`,
  programB: `gb-${id}`,
  programOther: `gc-${id}`,
  participantA: `ua-${id}`,
  participantB: `ub-${id}`,
  owner: `owner-${id}`,
  member: `member-${id}`,
  outsider: `outside-${id}`,
  invitation: `invite-${id}`,
  referralA: `ra-${id}`,
  referralB: `rb-${id}`,
  referralOther: `rc-${id}`,
};
let headers: Headers;
let memberHeaders: Headers;
let app: FastifyInstance;
let apiKey: string;
const routers = {
  participants: participantsRouter,
  events: eventsRouter,
  analytics: analyticsRouter,
  members: productMembersRouter,
  secrets: productSecretsRouter,
  user: userRouter,
  keys: apiKeysRouter,
  product: productRouter,
};
const fixtureSessions = new Map<string, typeof schema.session.$inferSelect>();
function caller<TRouter extends AnyRouter>(
  router: TRouter,
  role: "owner" | "admin" | "member" = "owner",
  userId = ids.owner,
) {
  const session = fixtureSessions.get(userId);
  if (!session) throw new Error("Authenticated fixture session is missing");
  return createCallerFactory<TRouter["_def"]["record"]>(router)({
    db,
    headers: role === "member" ? memberHeaders : headers,
    session: { ...session, activeOrganizationId: ids.orgA },
    userId,
    activeOrganizationId: ids.orgA,
    activeProductId: ids.productA,
    organizationUserId: `membership-${userId}`,
    organizationUserRole: role,
    logger: applicationLogger,
  });
}
async function login(email: string) {
  const response = await auth.api.signInEmail({
    body: { email, password: "Regression-only-password-123!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return new Headers({ cookie: cookie!.split(";")[0]! });
}

beforeAll(async () => {
  await db.insert(schema.org).values([
    { id: ids.orgA, name: "A" },
    { id: ids.orgB, name: "B" },
  ]);
  await db.insert(schema.user).values([
    {
      id: ids.owner,
      name: "Owner",
      email: `owner-${id}@example.test`,
      emailVerified: true,
    },
    {
      id: ids.member,
      name: "Member",
      email: `member-${id}@example.test`,
      emailVerified: true,
    },
    {
      id: ids.outsider,
      name: "Unverified",
      email: `outside-${id}@example.test`,
      emailVerified: false,
    },
  ]);
  const password = await hashPassword("Regression-only-password-123!");
  await db.insert(schema.account).values(
    [ids.owner, ids.member, ids.outsider].map((userId) => ({
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    })),
  );
  await db.insert(schema.orgUser).values([
    { orgId: ids.orgA, userId: ids.owner, role: "owner" },
    { orgId: ids.orgA, userId: ids.member, role: "member" },
  ]);
  await db.insert(schema.product).values([
    { id: ids.productA, orgId: ids.orgA, name: "A" },
    { id: ids.productB, orgId: ids.orgB, name: "B" },
  ]);
  await db.insert(schema.program).values([
    {
      id: ids.programA,
      productId: ids.productA,
      name: "A",
      status: "active",
      programTemplateId: "test",
    },
    {
      id: ids.programB,
      productId: ids.productB,
      name: "B",
      status: "active",
      programTemplateId: "test",
    },
    {
      id: ids.programOther,
      productId: ids.productA,
      name: "Other A",
      status: "active",
      programTemplateId: "test",
    },
  ]);
  await db.insert(schema.participant).values([
    {
      id: ids.participantA,
      productId: ids.productA,
      externalId: "same-external-id",
      name: "A",
    },
    {
      id: ids.participantB,
      productId: ids.productB,
      externalId: "same-external-id",
      name: "B",
    },
  ]);
  await db.insert(schema.refcode).values([
    {
      code: `a-${id}`,
      productId: ids.productA,
      programId: ids.programA,
      participantId: ids.participantA,
    },
    {
      code: `b-${id}`,
      productId: ids.productB,
      programId: ids.programB,
      participantId: ids.participantB,
    },
    {
      code: `c-${id}`,
      productId: ids.productA,
      programId: ids.programOther,
      participantId: ids.participantA,
    },
  ]);
  // Insert B first: an unscoped LIMIT 1 deterministically selects the foreign attribution.
  await db.insert(schema.referral).values([
    {
      id: ids.referralB,
      programId: ids.programB,
      referrerId: ids.participantB,
      externalId: "same-external-id",
    },
    {
      id: ids.referralA,
      programId: ids.programA,
      referrerId: ids.participantA,
      externalId: "same-external-id",
      createdAt: new Date("2024-02-29T23:59:59Z"),
    },
    {
      id: ids.referralOther,
      programId: ids.programOther,
      referrerId: ids.participantA,
      externalId: "same-external-id",
    },
  ]);
  await db
    .insert(schema.eventDefinition)
    .values([
      { name: "Purchase", type: "purchase" },
      { name: "Signup", type: "signup" },
    ])
    .onConflictDoNothing();
  await db.insert(schema.rewardRule).values({
    programId: ids.programA,
    name: "Purchase regression",
    type: "cash",
    config: rewardRuleConfigV1Schema.parse({
      schemaVersion: 1,
      trigger: { event: "purchase" },
      participantType: "referrer",
      reward: { type: "cash", amount: 5, unit: "fixed" },
    }),
  });
  await db.insert(schema.invitation).values({
    id: ids.invitation,
    organizationId: ids.orgA,
    email: `outside-${id}@example.test`,
    inviterId: ids.owner,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86400000),
  });
  await db.insert(schema.productSecrets).values({
    productId: ids.productA,
    clientId: `client-${id}`,
    clientSecret: "regression-only",
  });
  headers = await login(`owner-${id}@example.test`);
  memberHeaders = await login(`member-${id}@example.test`);
  for (const session of await db
    .select()
    .from(schema.session)
    .where(inArray(schema.session.userId, [ids.owner, ids.member]))) {
    fixtureSessions.set(session.userId, session);
  }
  apiKey = (await caller(routers.keys).create({ name: "Regression" })).key;
  app = Fastify({ logger: false });
  await app.register(coredbPlugin, { db });
  await app.register(betterAuthPlugin, { db });
  await app.register(signupRoutes, { prefix: "/signup" });
  await app.register(purchaseRoutes, { prefix: "/purchase" });
  await app.register(programsRoutes, { prefix: "/programs" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db
    .delete(schema.reward)
    .where(eq(schema.reward.programId, ids.programA));
  await db
    .delete(schema.event)
    .where(inArray(schema.event.productId, [ids.productA, ids.productB]));
  await db
    .delete(schema.referral)
    .where(inArray(schema.referral.productId, [ids.productA, ids.productB]));
  await db
    .delete(schema.refcode)
    .where(inArray(schema.refcode.productId, [ids.productA, ids.productB]));
  await db
    .delete(schema.rewardRule)
    .where(
      inArray(schema.rewardRule.programId, [
        ids.programA,
        ids.programB,
        ids.programOther,
      ]),
    );
  await db
    .delete(schema.org)
    .where(inArray(schema.org.id, [ids.orgA, ids.orgB]));
  await db
    .delete(schema.user)
    .where(inArray(schema.user.id, [ids.owner, ids.member, ids.outsider]));
  await db
    .delete(schema.user)
    .where(eq(schema.user.email, `service-account_${ids.orgA}@refref.local`));
});

const track = (
  path: string,
  overrides: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
) =>
  app.inject({
    method: "POST",
    url: path,
    headers: { "x-api-key": apiKey },
    payload: {
      timestamp: new Date().toISOString(),
      productId: ids.productA,
      programId: ids.programA,
      payload: {
        userId: "same-external-id",
        ...(path === "/purchase"
          ? { orderId: `order-${id}`, orderAmount: 25, currency: "USD" }
          : {}),
        ...payload,
      },
      ...overrides,
    },
  });

describe.sequential(
  "tenant authorization and bounded operations (real PostgreSQL)",
  () => {
    it("isolates session cookies from other services sharing the same host", async () => {
      const cookie = headers.get("cookie")!;
      const value = cookie.slice(cookie.indexOf("=") + 1);
      const isolated = new Headers({
        cookie: `better-auth.session_token=another-application; refref.session_token=${value}`,
      });
      expect((await auth.api.getSession({ headers: isolated }))?.user.id).toBe(
        ids.owner,
      );
      const otherServiceOnly = new Headers({
        cookie: `better-auth.session_token=${value}`,
      });
      expect(
        await auth.api.getSession({ headers: otherServiceOnly }),
      ).toBeNull();
    });
    it("returns authorization failures for anonymous and unselected-organization RPC sessions", async () => {
      const anonymous = await createTRPCContext({ headers: new Headers() });
      await expect(
        createCallerFactory(participantsRouter)(anonymous).getAll({
          page: 1,
          pageSize: 10,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      const unselectedHeaders = await login(`owner-${id}@example.test`);
      await auth.api.setActiveOrganization({
        headers: unselectedHeaders,
        body: { organizationId: null },
      });
      const unselected = await createTRPCContext({
        headers: unselectedHeaders,
      });
      await expect(
        createCallerFactory(participantsRouter)(unselected).getAll({
          page: 1,
          pageSize: 10,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    it("lists and counts only the active product, including filtered lists", async () => {
      for (const filters of [
        undefined,
        [{ id: "name", value: "%", variant: "text", operator: "contains" }],
      ]) {
        const result = await caller(routers.participants).getAll({
          page: 1,
          pageSize: 100,
          filters,
        });
        expect(result.data.map((p) => p.id)).toEqual([ids.participantA]);
        expect(Number(result.total)).toBe(1);
      }
    });
    it("rejects foreign participant detail but permits same-product detail", async () => {
      const scope = { userId: ids.owner, organizationId: ids.orgA };
      await expect(
        caller(routers.participants).getById({ id: ids.participantB, scope }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        (
          await caller(routers.participants).getById({
            id: ids.participantA,
            scope,
          })
        ).id,
      ).toBe(ids.participantA);
    });
    it("rejects every mixed event ownership combination before inserting", async () => {
      const before = await db
        .select()
        .from(schema.event)
        .where(eq(schema.event.productId, ids.productA));
      for (const foreign of [
        { productId: ids.productB },
        { programId: ids.programB },
        { participantId: ids.participantB },
        { referralId: ids.referralB },
        { referralId: ids.referralOther },
      ]) {
        await expect(
          caller(routers.events).create({
            productId: ids.productA,
            programId: ids.programA,
            participantId: ids.participantA,
            referralId: ids.referralA,
            eventType: "signup",
            ...foreign,
          }),
        ).rejects.toBeDefined();
      }
      expect(
        await db
          .select()
          .from(schema.event)
          .where(eq(schema.event.productId, ids.productA)),
      ).toHaveLength(before.length);
      expect(
        (
          await caller(routers.events).create({
            productId: ids.productA,
            programId: ids.programA,
            participantId: ids.participantA,
            referralId: ids.referralA,
            eventType: "signup",
          })
        ).productId,
      ).toBe(ids.productA);
    });
    it.each([
      ["2024-02-30", "2024-03-01"],
      ["garbage", "2024-03-01"],
      ["2024-03-02", "2024-03-01"],
      ["2024-01-01", "2024-12-31"],
      ["2024-01-01T00:00:00Z", "2024-01-02"],
      ["2024-01-01", undefined],
    ])(
      "rejects unsafe explicit date range %s to %s",
      async (startDate, endDate) => {
        await expect(
          caller(routers.analytics).getTimeSeriesData({
            programId: ids.programA,
            startDate,
            endDate,
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      },
    );
    it("includes the entire leap-day endpoint and allows exactly 365 inclusive dates", async () => {
      expect(
        await caller(routers.analytics).getTimeSeriesData({
          programId: ids.programA,
          startDate: "2024-02-29",
          endDate: "2024-02-29",
        }),
      ).toEqual([{ date: "2024-02-29", referrals: 1 }]);
      expect(
        await caller(routers.analytics).getTimeSeriesData({
          programId: ids.programA,
          startDate: "2023-01-01",
          endDate: "2023-12-31",
        }),
      ).toHaveLength(365);
      expect(
        await caller(routers.analytics).getTimeSeriesData({
          programId: ids.programA,
          days: 1,
        }),
      ).toHaveLength(1);
    });
    it("restricts invitation bearer IDs and signing credentials to owner/admin", async () => {
      await expect(
        caller(routers.members, "member", ids.member).listInvitations(),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller(routers.secrets, "member", ids.member).get({
          productId: ids.productA,
          scope: { userId: ids.member, organizationId: ids.orgA },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        (await caller(routers.members).listInvitations()).some(
          (i) => i.id === ids.invitation,
        ),
      ).toBe(true);
      expect(
        (
          await caller(routers.secrets).get({
            productId: ids.productA,
            scope: { userId: ids.owner, organizationId: ids.orgA },
          })
        ).clientSecret,
      ).toBe("regression-only");
    });
    it("also protects invitation tokens through Better Auth's direct organization endpoints", async () => {
      await expect(
        auth.api.listInvitations({
          headers: memberHeaders,
          query: { organizationId: ids.orgA },
        }),
      ).rejects.toBeDefined();
      const organization = await auth.api.getFullOrganization({
        headers: memberHeaders,
        query: { organizationId: ids.orgA },
      });
      if (!organization)
        throw new Error("Fixture organization was not returned");
      expect(organization.id).toBe(ids.orgA);
      expect(organization.invitations ?? []).toEqual([]);
      expect(
        (
          await auth.api.listInvitations({
            headers,
            query: { organizationId: ids.orgA },
          })
        ).some((i) => i.id === ids.invitation),
      ).toBe(true);
    });
    it("does not let a member create products to obtain new signing credentials", async () => {
      await expect(
        caller(routers.product, "member", ids.member).create({
          name: "Unauthorized",
          url: "https://example.test",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await db
          .select()
          .from(schema.product)
          .where(eq(schema.product.orgId, ids.orgA)),
      ).toHaveLength(1);
    });
    it("cannot change a verified mailbox through profile update", async () => {
      await expect(
        caller(routers.user).updateProfile({
          name: "Owner",
          email: `changed-${id}@example.test`,
        }),
      ).rejects.toBeDefined();
      const [record] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, ids.owner));
      expect(record?.email).toBe(`owner-${id}@example.test`);
      expect(record?.emailVerified).toBe(true);
      expect(
        (
          await caller(routers.user).updateProfile({
            name: "Renamed",
            email: `owner-${id}@example.test`,
          })
        ).name,
      ).toBe("Renamed");
    });
    it("does not disclose arbitrary users outside the active organization", async () => {
      await expect(
        caller(routers.user).getById({ id: ids.outsider }),
      ).rejects.toBeDefined();
      expect((await caller(routers.user).getById({ id: ids.member })).id).toBe(
        ids.member,
      );
    });
    it("requires mailbox verification and invitation recipient ownership", async () => {
      // A pre-existing session can outlive verification-policy changes; acceptance must check the mailbox itself.
      await db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, ids.outsider));
      const unverifiedHeaders = await login(`outside-${id}@example.test`);
      await db
        .update(schema.user)
        .set({ emailVerified: false })
        .where(eq(schema.user.id, ids.outsider));
      await expect(
        auth.api.acceptInvitation({
          headers: unverifiedHeaders,
          body: { invitationId: ids.invitation },
        }),
      ).rejects.toBeDefined();
      await expect(
        auth.api.acceptInvitation({
          headers,
          body: { invitationId: ids.invitation },
        }),
      ).rejects.toBeDefined();
      const [invite] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, ids.invitation));
      expect(invite?.status).toBe("pending");
    });
    it("accepts an auth-mail request but blocks unconfigured transport and redacts failure diagnostics", async () => {
      const sendSpy = vi
        .spyOn(SESv2Client.prototype, "send")
        .mockRejectedValue(new Error("Unexpected outbound auth mail"));
      const diagnostics = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const response = await auth.api.signInMagicLink({
          headers,
          body: { email: `owner-${id}@example.test` },
        });
        expect(response).toEqual({ status: true });
        await vi.waitFor(() =>
          expect(diagnostics.mock.calls).toContainEqual([
            expect.any(String),
            { level: "error" },
          ]),
        );
        expect(sendSpy).not.toHaveBeenCalled();
        const logged = JSON.stringify(diagnostics.mock.calls);
        expect(logged).not.toContain(`owner-${id}@example.test`);
        expect(logged).not.toContain("token=");
      } finally {
        sendSpy.mockRestore();
        diagnostics.mockRestore();
      }
    });
    it("organization key cannot fetch a foreign program or write a foreign product/program", async () => {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/programs/${ids.programB}`,
            headers: { "x-api-key": apiKey },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/programs/${ids.programA}`,
            headers: { "x-api-key": apiKey },
          })
        ).statusCode,
      ).toBe(200);
      for (const path of ["/signup", "/purchase"]) {
        expect(
          (
            await track(path, {
              productId: ids.productB,
              programId: ids.programB,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (await track(path, { programId: ids.programB })).statusCode,
        ).toBe(403);
      }
    });
    it("validates a signup's referral-code program before creating its participant", async () => {
      const before = await db
        .select()
        .from(schema.participant)
        .where(eq(schema.participant.productId, ids.productA));
      for (const refcode of [`b-${id}`, `c-${id}`]) {
        expect(
          (await track("/signup", {}, { userId: `new-${id}`, refcode }))
            .statusCode,
        ).toBe(403);
      }
      expect(
        await db
          .select()
          .from(schema.participant)
          .where(eq(schema.participant.productId, ids.productA)),
      ).toHaveLength(before.length);
      const allowed = await track(
        "/signup",
        {},
        { userId: `new-${id}`, refcode: `a-${id}` },
      );
      expect(allowed.statusCode).toBe(200);
      const [created] = await db
        .select()
        .from(schema.event)
        .where(eq(schema.event.id, allowed.json().eventId));
      const [attribution] = await db
        .select()
        .from(schema.referral)
        .where(eq(schema.referral.id, created!.referralId!));
      expect(attribution?.programId).toBe(ids.programA);
    });
    it("purchase attribution stays product-scoped and retry/concurrency does not duplicate ledger rewards", async () => {
      const first = await track("/purchase");
      expect(first.statusCode).toBe(200);
      const eventId = first.json().eventId;
      const [event] = await db
        .select()
        .from(schema.event)
        .where(eq(schema.event.id, eventId));
      expect(event?.referralId).toBe(ids.referralA);
      const retries = await Promise.all([
        track("/purchase"),
        track("/purchase"),
      ]);
      expect(retries.map((r) => r.json().eventId)).toEqual([eventId, eventId]);
      await Promise.all([
        processEventForRewards(db, eventId, "api"),
        processEventForRewards(db, eventId, "api"),
      ]);
      const rewards = await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, eventId));
      expect(rewards).toHaveLength(1);
      expect(rewards[0]?.participantId).toBe(ids.participantA);
      expect(
        (await track("/purchase", {}, { orderAmount: 26 })).statusCode,
      ).toBe(409);
      expect(
        (await track("/purchase", {}, { currency: "EUR" })).statusCode,
      ).toBe(409);
      expect(
        (await track("/purchase", {}, { userId: `another-${id}` })).statusCode,
      ).toBe(409);
      expect(
        (await track("/purchase", { programId: ids.programOther })).statusCode,
      ).toBe(409);
      expect(
        (await track("/purchase", {}, { productIds: ["different-item"] }))
          .statusCode,
      ).toBe(409);
      expect(
        (await track("/purchase", {}, { orderId: "x".repeat(201) })).statusCode,
      ).toBe(400);
      expect(
        await db
          .select()
          .from(schema.event)
          .where(
            and(
              eq(schema.event.productId, ids.productA),
              eq(schema.event.eventDefinitionId, event!.eventDefinitionId),
            ),
          ),
      ).toHaveLength(1);
    });
    it("keeps an identical retry stable when its external user signs up later", async () => {
      const payload = { userId: `late-${id}`, orderId: `late-order-${id}` };
      const original = await track("/purchase", {}, payload);
      expect(original.statusCode).toBe(200);
      expect(
        (await track("/signup", {}, { userId: payload.userId })).statusCode,
      ).toBe(200);
      const retry = await track("/purchase", {}, payload);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().eventId).toBe(original.json().eventId);
      expect(
        await db
          .select()
          .from(schema.reward)
          .where(eq(schema.reward.eventId, original.json().eventId)),
      ).toHaveLength(0);
    });
    it("returns a rate-limit response without disabling API-key limits", async () => {
      const limitedKey = await caller(routers.keys).create({
        name: "Limited regression",
      });
      await db
        .update(schema.apikey)
        .set({
          rateLimitMax: 2,
          rateLimitTimeWindow: 60_000,
          requestCount: 0,
          lastRequest: null,
        })
        .where(eq(schema.apikey.id, limitedKey.id));
      const request = () =>
        app.inject({
          method: "GET",
          url: `/programs/${ids.programA}`,
          headers: { "x-api-key": limitedKey.key },
        });
      expect((await request()).statusCode).toBe(200);
      expect((await request()).statusCode).toBe(200);
      expect((await request()).statusCode).toBe(429);
    });
    it("preserves the advertised two-year key lifetime through the real SDK and persisted verification", async () => {
      const twoYears = 2 * 365 * 24 * 60 * 60;
      const created = await caller(routers.keys).create({
        name: "Two-year integration",
        expiresIn: twoYears,
      });
      expect(created.expiresAt?.getTime()).toBeGreaterThan(
        Date.now() + (twoYears - 60) * 1000,
      );
      const verification = await auth.api.verifyApiKey({
        body: { key: created.key },
      });
      expect(verification.valid).toBe(true);
      expect(verification.key?.metadata).toMatchObject({
        organizationId: ids.orgA,
      });
    });
    it("returns client errors for native SDK name and expiry validation without minting keys", async () => {
      const original = await caller(routers.keys).list();
      for (const input of [
        { name: "x".repeat(33) },
        { name: "Too short expiry", expiresIn: 1 },
        { name: "Too long expiry", expiresIn: 2 * 365 * 24 * 60 * 60 + 1 },
      ]) {
        await expect(caller(routers.keys).create(input)).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
      }
      expect((await caller(routers.keys).list()).map((key) => key.id)).toEqual(
        original.map((key) => key.id),
      );
    });
    it("keeps query values and rejected participant PII out of real application logs", async () => {
      const oldDatabaseUrl = process.env.DATABASE_URL;
      const oldLogLevel = process.env.LOG_LEVEL;
      process.env.DATABASE_URL = url;
      process.env.LOG_LEVEL = "info";
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      });
      let realApi: FastifyInstance | undefined;
      let realRedirect: FastifyInstance | undefined;
      const email = `private-log-${id}@example.test`;
      const name = `PRIVATE_LOG_NAME_${id}`;
      const query = `PRIVATE_QUERY_${id}`;
      try {
        realApi = await buildApiApp(stream);
        realRedirect = await buildRedirectApp(stream);
        expect(
          (await realApi.inject(`/health?email=${query}`)).statusCode,
        ).toBe(200);
        expect(
          (await realRedirect.inject(`/missing-${id}?token=${query}`))
            .statusCode,
        ).toBe(404);
        expect(
          (await realApi.inject(`/missing/path?token=${query}`)).statusCode,
        ).toBe(404);
        expect(
          (await realRedirect.inject(`/missing/a/b?email=${query}`)).statusCode,
        ).toBe(404);
        const failure = await realApi.inject({
          method: "POST",
          url: "/v1/track/signup",
          headers: { "x-api-key": apiKey },
          payload: {
            timestamp: new Date().toISOString(),
            productId: ids.productA,
            programId: ids.programA,
            payload: { userId: `log-${id}`, email, name: `${name}\u0000` },
          },
        });
        expect(failure.statusCode).toBe(500);
        const output = chunks.join("");
        expect(output).not.toContain(email);
        expect(output).not.toContain(name);
        expect(output).not.toContain(query);
        expect(
          output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .some((record) => record.error?.code === "22021"),
        ).toBe(true);
      } finally {
        await realApi?.close();
        await realRedirect?.close();
        if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = oldDatabaseUrl;
        if (oldLogLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = oldLogLevel;
      }
    });
    it("changes email only after the replacement mailbox verifies its token", async () => {
      const emailAuth = getAuth({
        baseURL: "http://localhost:4000",
        postbox: {
          from: "auth@example.test",
          credentials: {
            accessKeyId: "isolated-test-key",
            secretAccessKey: "isolated-test-secret",
          },
        },
        db,
        schema,
        enabledSocialAuth: [],
        enablePasswordAuth: true,
        enableMagicLinkAuth: false,
      });
      let sentCommand: SendEmailCommand | undefined;
      const sendSpy = vi
        .spyOn(SESv2Client.prototype, "send")
        .mockImplementation(async (command) => {
          if (!(command instanceof SendEmailCommand))
            throw new Error("Unexpected email command");
          sentCommand = command;
          return { $metadata: {}, MessageId: "regression-email" };
        });
      try {
        const replacement = `replacement-${id}@example.test`;
        await emailAuth.api.changeEmail({
          headers,
          body: { newEmail: replacement },
        });
        expect(
          (
            await db
              .select()
              .from(schema.user)
              .where(eq(schema.user.id, ids.owner))
          )[0]?.email,
        ).toBe(`owner-${id}@example.test`);
        await vi.waitFor(() =>
          expect(sentCommand?.input.Destination?.ToAddresses).toContain(
            replacement,
          ),
        );
        const sentBody = sentCommand?.input;
        const token = /[?&]token=([^&"]+)/.exec(
          sentBody?.Content?.Simple?.Body?.Html?.Data ?? "",
        )?.[1];
        expect(token).toBeTruthy();
        await emailAuth.api.verifyEmail({
          query: { token: decodeURIComponent(token!) },
        });
        const [verified] = await db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, ids.owner));
        expect(verified?.email).toBe(replacement);
        expect(verified?.emailVerified).toBe(true);
      } finally {
        sendSpy.mockRestore();
      }
    });
    it("does not expose SQL parameters in server caller exceptions", async () => {
      const marker = `private-server-${id}@example.test`;
      const failure = await caller(routers.participants)
        .getById({
          id: `${marker}\u0000`,
          scope: { userId: ids.owner, organizationId: ids.orgA },
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(String(failure)).not.toContain(marker);
      expect(JSON.stringify(failure)).not.toContain(marker);
    });
    it("keeps invalid invitation failures visible without logging their bearer input", async () => {
      const marker = `private-invitation-${id}`;
      shared.requestHeaders = headers;
      const chunks: string[] = [];
      const transport = new winston.transports.Stream({
        stream: new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(String(chunk));
            callback();
          },
        }),
      });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      applicationLogger.add(transport);
      try {
        const page = await AcceptInvitationPage({
          params: Promise.resolve({ token: `${marker}\u0000` }),
        });
        expect(renderToStaticMarkup(page)).toContain('role="alert"');
        const logged =
          chunks.join("") +
          consoleSpy.mock.calls
            .map((args) => args.map(String).join(" "))
            .join("\n");
        expect(logged).not.toContain(marker);
      } finally {
        applicationLogger.remove(transport);
        consoleSpy.mockRestore();
        shared.requestHeaders = undefined;
      }
    });
    it("accepts a verified invitation recipient and creates actual organization membership", async () => {
      await db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, ids.outsider));
      shared.requestHeaders = await login(`outside-${id}@example.test`);
      try {
        await AcceptInvitationPage({
          params: Promise.resolve({ token: ids.invitation }),
        }).catch(() => undefined);
        expect(
          (
            await db
              .select()
              .from(schema.invitation)
              .where(eq(schema.invitation.id, ids.invitation))
          )[0]?.status,
        ).toBe("accepted");
        expect(
          (
            await db
              .select()
              .from(schema.orgUser)
              .where(
                and(
                  eq(schema.orgUser.orgId, ids.orgA),
                  eq(schema.orgUser.userId, ids.outsider),
                ),
              )
          )[0]?.role,
        ).toBe("member");
      } finally {
        shared.requestHeaders = undefined;
      }
    });
  },
);
