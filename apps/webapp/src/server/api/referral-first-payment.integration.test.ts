import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import {
  createDb,
  schema,
  ensureServiceAccountForOrganization,
  participantBalances,
  processEventForRewards,
  referralTermsFingerprint,
  type DBType,
  type CoreTransaction,
} from "@refref/coredb";
import { getAuth } from "@refref/auth";
import { hashPassword } from "better-auth/crypto";
import { coredbPlugin } from "@refref/utils";
import {
  defaultWidgetConfig,
  minorPurchaseResponseSchema,
  referralCodeResolutionSchema,
  type MinorPurchaseRequest,
  type MinorPurchaseResponse,
  type ReferralSnapshotV1,
  type RewardConfigType,
} from "@refref/types";
import betterAuthPlugin from "../../../../api/src/plugins/better-auth";
import resolveRoutes from "../../../../api/src/routes/v1/referrals/resolve";
import purchaseRoutes from "../../../../api/src/routes/v1/track/purchase";
import signupRoutes from "../../../../api/src/routes/v1/track/signup";
import { createCallerFactory, createTRPCContext } from "./trpc";
import { programRouter } from "./routers/program";
import { payoutsRouter } from "./routers/payouts";
import { participantPortalRouter } from "./routers/participant-portal";
import { rewardsRouter } from "./routers/rewards";
import { eventsRouter } from "./routers/events";
import { rewardRulesRouter } from "./routers/reward-rules";
import { productRouter } from "./routers/product";
import { productSecretsRouter } from "./routers/product-secrets";
import { participantsRouter } from "./routers/participants";
import type { AnyRouter, inferRouterInputs } from "@trpc/server";

vi.mock("@/server/db", () => ({
  get db() {
    return db;
  },
  get schema() {
    return schema;
  },
}));
vi.mock("@/lib/auth", () => ({
  get auth() {
    return auth;
  },
}));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_REFER_URL: "http://localhost:4310/r",
    NEXT_PUBLIC_APP_URL: "http://localhost:4000",
  },
}));
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("test"))
  throw new Error("TEST_DATABASE_URL must point to a dedicated test database");
process.env.BETTER_AUTH_SECRET =
  "first-payment-isolated-test-secret-at-least-thirty-two-characters";
process.env.PAYOUT_MANUAL_EXECUTION_NAMESPACE = "test-account-" + randomUUID();
const db = createDb(url);
// Only synchronization-fixture DDL may use the test migrator; all business calls keep the runtime role.
const ddlUrl = process.env.TEST_DDL_DATABASE_URL;
if (ddlUrl) {
  const target = new URL(ddlUrl);
  const runtimeTarget = new URL(url);
  if (
    target.host !== runtimeTarget.host ||
    target.pathname !== runtimeTarget.pathname
  )
    throw new Error(
      "TEST_DDL_DATABASE_URL must target the same dedicated test database",
    );
}
const ddlDb = ddlUrl ? createDb(ddlUrl) : db;
const auth = getAuth({
  baseURL: "http://localhost:4000",
  db,
  schema,
  enabledSocialAuth: [],
  enablePasswordAuth: true,
  enableMagicLinkAuth: false,
});
const suffix = randomUUID();
const ids = {
  org: `rf-org-${suffix}`,
  foreignOrg: `rf-foreign-org-${suffix}`,
  product: `rf-product-${suffix}`,
  foreignProduct: `rf-foreign-product-${suffix}`,
  program: `rf-program-${suffix}`,
  legacy: `rf-legacy-${suffix}`,
  admin: `rf-admin-${suffix}`,
  operator: `rf-operator-${suffix}`,
  member: `rf-member-${suffix}`,
  outsider: `rf-outsider-${suffix}`,
  referrer: `rf-referrer-${suffix}`,
  buyer: `rf-buyer-${suffix}`,
  buyerExternal: `tenant-buyer-${suffix}`,
};
const adminIdentity = { userId: ids.admin, organizationId: ids.org };
const code = `anna${suffix.replaceAll("-", "").slice(0, 16)}`;
let app: FastifyInstance;
let key: string;
let legacyKey: string;
let adminHeaders: Headers;
let memberHeaders: Headers;
let operatorHeaders: Headers;
let outsiderHeaders: Headers;
let snapshot: ReferralSnapshotV1;
let purchase: MinorPurchaseRequest;
let ack: MinorPurchaseResponse;
async function caller<R extends AnyRouter>(
  router: R,
  headers = adminHeaders,
  database: DBType = db,
) {
  return createCallerFactory<R["_def"]["record"]>(router)({
    ...(await createTRPCContext({ headers })),
    db: database,
  });
}
async function signIn(email: string) {
  const response = await auth.api.signInEmail({
    body: { email, password: "Test-first-payment-password-123!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  return new Headers({
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  });
}
const post = (path: string, payload: InjectOptions["payload"], apiKey = key) =>
  app.inject({
    method: "POST",
    url: path,
    headers: { "x-api-key": apiKey },
    payload,
  });
function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
// Native nested transactions keep the actual router/SQL path under a test-controlled COMMIT.
const transactionDb = (tx: CoreTransaction): DBType =>
  Object.assign(tx, { $client: db.$client });
async function waitForBlockedQuery(blockerPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${blockerPid} = ANY(pg_blocking_pids(pid))
      ) AS waiting
    `);
    if (row?.waiting) return;
  }
  throw new Error(
    "Concurrent request never reached the native PostgreSQL lock barrier",
  );
}
async function businessCounts(productId: string) {
  const [row] = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM participant WHERE product_id=${productId})::integer AS participants,
      (SELECT count(*) FROM event WHERE product_id=${productId})::integer AS events,
      (SELECT count(*) FROM referral WHERE product_id=${productId})::integer AS referrals,
      (SELECT count(*) FROM reward r JOIN program p ON p.id=r.program_id WHERE p.product_id=${productId})::integer AS rewards
  `);
  return row;
}
async function createScopedKey(
  productId: string,
  programId: string,
  operations: string[] = ["resolve", "purchase"],
) {
  const serviceId = await ensureServiceAccountForOrganization(db, ids.org);
  return (
    await auth.api.createApiKey({
      body: {
        name: "Scoped concurrency fixture",
        userId: serviceId,
        permissions: { [ids.org]: ["full_access"], referrals: operations },
        metadata: {
          organizationId: ids.org,
          referralScope: { productId, programId },
        },
      },
    })
  ).key;
}
const initialTerms: RewardConfigType = {
  firstPaidOnly: true,
  referrer: {
    type: "cash",
    valueType: "fixed",
    value: 1,
    currency: "RUB",
    basis: "payable_amount",
  },
  referee: {
    type: "discount",
    valueType: "percentage",
    value: 50,
    currency: "RUB",
  },
};
const changedTerms: RewardConfigType = {
  ...initialTerms,
  referrer: { ...initialTerms.referrer!, value: 3, basis: "base_amount" },
  referee: { ...initialTerms.referee!, value: 25 },
};
async function createFinancialFixture(
  referrerId = ids.referrer,
  terms: RewardConfigType = initialTerms,
) {
  const fixtureId = randomUUID();
  const programId = `rf-concurrent-${fixtureId}`;
  const fixtureCode = `partner${fixtureId.replaceAll("-", "").slice(0, 16)}`;
  await db.insert(schema.program).values({
    id: programId,
    productId: ids.product,
    name: "Concurrent approved terms",
    status: "draft",
    programTemplateId: "double-sided",
  });
  const admin = await caller(programRouter);
  await admin.saveTemplateConfiguration({
    id: programId,
    templateConfig: { rewardConfig: terms },
  });
  await admin.approveServerTracking({
    productId: ids.product,
    programId,
    termsFingerprint: referralTermsFingerprint(terms),
    reviewedPeriod: { startDate: null, endDate: null },
    calculationVersion: 1,
    edgeExamplesApproved: true,
    ownershipPolicyVerified: true,
  });
  await db.insert(schema.refcode).values({
    code: fixtureCode,
    productId: ids.product,
    programId,
    participantId: referrerId,
  });
  return {
    programId,
    code: fixtureCode,
    apiKey: await createScopedKey(ids.product, programId),
    current: await admin.getById({ id: programId, scope: adminIdentity }),
  };
}

type IdentityScope = Exclude<
  inferRouterInputs<typeof productRouter>["getAll"],
  void
>;
type ProductScope = inferRouterInputs<typeof eventsRouter>["getAll"]["scope"];
type ProductScopeFixture = {
  fixtureId: string;
  ownerHeaders: Headers;
  memberHeaders: Headers;
  identity: IdentityScope;
  memberIdentity: IdentityScope;
  targetProduct: typeof schema.product.$inferSelect;
  legacyProduct: typeof schema.product.$inferSelect;
  foreignProduct: typeof schema.product.$inferSelect;
  foreignOrganizationId: string;
  scope: ProductScope;
  memberScope: ProductScope;
};
type ScopedReadFixture = ProductScopeFixture & {
  programs: Record<"alpha" | "beta" | "legacy" | "foreign", string>;
  participants: Record<
    "referrer" | "alice" | "bob" | "legacy" | "foreign",
    string
  >;
  referrals: Record<"alpha" | "beta" | "legacy", string>;
  events: Record<"a" | "b" | "c" | "d" | "legacy" | "foreign", string>;
  rewards: (typeof schema.reward.$inferSelect)[];
  rule: typeof schema.rewardRule.$inferSelect;
};

async function createProductScopeFixture(): Promise<ProductScopeFixture> {
  const fixtureId = randomUUID();
  const organizationId = `rf-scope-org-${fixtureId}`;
  const foreignOrganizationId = `rf-scope-foreign-org-${fixtureId}`;
  const ownerId = `rf-scope-owner-${fixtureId}`;
  const memberId = `rf-scope-member-${fixtureId}`;
  await db.insert(schema.org).values([
    { id: organizationId, name: "Isolated product scope" },
    { id: foreignOrganizationId, name: "Isolated foreign scope" },
  ]);
  const products = await db
    .insert(schema.product)
    .values(
      [0, 1].map((index) => ({
        id: `rf-scope-product-${index}-${fixtureId}`,
        orgId: organizationId,
        name: `Distinct scope brand ${index} ${fixtureId}`,
        logo: `https://brand-${index}.example.test/logo.svg`,
        url: `https://brand-${index}.example.test`,
        metadata: JSON.stringify({ targetAudience: "professional" }),
      })),
    )
    .returning();
  const [foreignProduct] = await db
    .insert(schema.product)
    .values({
      id: `rf-scope-foreign-product-${fixtureId}`,
      orgId: foreignOrganizationId,
      name: "Foreign scope brand",
    })
    .returning();
  const password = await hashPassword("Test-first-payment-password-123!");
  const headersByUser = new Map<string, Headers>();
  for (const [userId, role] of [
    [ownerId, "owner"],
    [memberId, "member"],
  ] as const) {
    await db.insert(schema.user).values({
      id: userId,
      name: "Scope fixture",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(schema.account).values({
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    });
    await db
      .insert(schema.orgUser)
      .values({ orgId: organizationId, userId, role });
    const headers = await signIn(`${userId}@example.test`);
    const session = await auth.api.getSession({ headers });
    await db
      .update(schema.session)
      .set({ activeOrganizationId: organizationId })
      .where(eq(schema.session.id, session!.session.id));
    headersByUser.set(userId, headers);
  }
  const ownerHeaders = headersByUser.get(ownerId)!;
  const scopeMemberHeaders = headersByUser.get(memberId)!;
  const context = await createTRPCContext({ headers: ownerHeaders });
  const legacyProduct = products.find(
    (product) => product.id === context.activeProductId,
  );
  const targetProduct = products.find(
    (product) => product.id !== context.activeProductId,
  );
  if (!legacyProduct || !targetProduct || !foreignProduct)
    throw new Error(
      "Scope fixture must include the actual legacy product and another owned product",
    );
  expect(targetProduct.id).not.toBe(context.activeProductId);
  expect(
    (await createTRPCContext({ headers: scopeMemberHeaders })).activeProductId,
  ).toBe(legacyProduct.id);
  const identity = { userId: ownerId, organizationId };
  const memberIdentity = { userId: memberId, organizationId };
  await db.insert(schema.productSecrets).values(
    [...products, foreignProduct].map((product) => ({
      productId: product.id,
      clientId: `client-${product.id}`,
      clientSecret: `synthetic-secret-${product.id}`,
    })),
  );
  return {
    fixtureId,
    ownerHeaders,
    memberHeaders: scopeMemberHeaders,
    identity,
    memberIdentity,
    targetProduct,
    legacyProduct,
    foreignProduct,
    foreignOrganizationId,
    scope: { ...identity, productId: targetProduct.id },
    memberScope: { ...memberIdentity, productId: targetProduct.id },
  };
}

async function createScopedReadFixture(): Promise<ScopedReadFixture> {
  const fixture = await createProductScopeFixture();
  const { fixtureId, targetProduct, legacyProduct, foreignProduct } = fixture;
  const programs = {
    alpha: `rf-scope-alpha-${fixtureId}`,
    beta: `rf-scope-beta-${fixtureId}`,
    legacy: `rf-scope-legacy-${fixtureId}`,
    foreign: `rf-scope-foreign-${fixtureId}`,
  };
  await db.insert(schema.program).values([
    {
      id: programs.alpha,
      productId: targetProduct.id,
      name: "Scope Alpha",
      status: "draft",
      programTemplateId: "single-sided",
    },
    {
      id: programs.beta,
      productId: targetProduct.id,
      name: "Scope Beta",
      status: "draft",
      programTemplateId: "double-sided",
    },
    {
      id: programs.legacy,
      productId: legacyProduct.id,
      name: "Scope Legacy",
      status: "active",
      programTemplateId: "single-sided",
    },
    {
      id: programs.foreign,
      productId: foreignProduct.id,
      name: "Scope Foreign",
      status: "active",
      programTemplateId: "single-sided",
    },
  ]);
  const participants = {
    referrer: `rf-scope-referrer-${fixtureId}`,
    alice: `rf-scope-alice-${fixtureId}`,
    bob: `rf-scope-bob-${fixtureId}`,
    legacy: `rf-scope-legacy-participant-${fixtureId}`,
    foreign: `rf-scope-foreign-participant-${fixtureId}`,
  };
  await db.insert(schema.participant).values(
    Object.entries(participants).map(([name, id]) => ({
      id,
      name,
      email: `${name}-${fixtureId}@example.test`,
      externalId: id,
      productId:
        name === "legacy"
          ? legacyProduct.id
          : name === "foreign"
            ? foreignProduct.id
            : targetProduct.id,
    })),
  );
  const referrals = {
    alpha: `rf-scope-referral-alpha-${fixtureId}`,
    beta: `rf-scope-referral-beta-${fixtureId}`,
    legacy: `rf-scope-referral-legacy-${fixtureId}`,
  };
  await db.insert(schema.referral).values([
    {
      id: referrals.alpha,
      productId: targetProduct.id,
      programId: programs.alpha,
      referrerId: participants.referrer,
      externalId: participants.alice,
    },
    {
      id: referrals.beta,
      productId: targetProduct.id,
      programId: programs.beta,
      referrerId: participants.referrer,
      externalId: participants.bob,
    },
    {
      id: referrals.legacy,
      productId: legacyProduct.id,
      programId: programs.legacy,
      referrerId: participants.legacy,
      externalId: participants.legacy,
    },
  ]);
  const [purchaseDefinition, signupDefinition] = await db
    .insert(schema.eventDefinition)
    .values([
      {
        type: `scope-purchase-${fixtureId}`,
        name: `Scope Purchase ${fixtureId}`,
        config: { schemaVersion: 1 },
      },
      {
        type: `scope-signup-${fixtureId}`,
        name: `Scope Signup ${fixtureId}`,
        config: { schemaVersion: 1 },
      },
    ])
    .returning();
  const events = {
    a: `rf-scope-event-a-${fixtureId}`,
    b: `rf-scope-event-b-${fixtureId}`,
    c: `rf-scope-event-c-${fixtureId}`,
    d: `rf-scope-event-d-${fixtureId}`,
    legacy: `rf-scope-event-legacy-${fixtureId}`,
    foreign: `rf-scope-event-foreign-${fixtureId}`,
  };
  // Reverse insertion order makes an omitted ID tie-breaker observable.
  await db.insert(schema.event).values([
    {
      id: events.d,
      productId: targetProduct.id,
      programId: programs.alpha,
      participantId: participants.alice,
      referralId: referrals.alpha,
      eventDefinitionId: purchaseDefinition!.id,
      status: "pending",
      createdAt: new Date("2024-01-02T00:00:00Z"),
      metadata: { schemaVersion: 1, orderAmount: 1, orderId: events.d },
    },
    {
      id: events.c,
      productId: targetProduct.id,
      programId: programs.beta,
      participantId: participants.bob,
      referralId: referrals.beta,
      eventDefinitionId: signupDefinition!.id,
      status: "pending",
      createdAt: new Date("2024-01-03T00:00:00Z"),
    },
    {
      id: events.b,
      productId: targetProduct.id,
      programId: programs.alpha,
      participantId: participants.alice,
      referralId: referrals.alpha,
      eventDefinitionId: purchaseDefinition!.id,
      status: "processed",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    },
    {
      id: events.a,
      productId: targetProduct.id,
      programId: programs.alpha,
      participantId: participants.alice,
      referralId: referrals.alpha,
      eventDefinitionId: purchaseDefinition!.id,
      status: "pending",
      createdAt: new Date("2024-01-02T00:00:00Z"),
    },
    {
      id: events.legacy,
      productId: legacyProduct.id,
      programId: programs.legacy,
      participantId: participants.legacy,
      eventDefinitionId: purchaseDefinition!.id,
      status: "pending",
    },
    {
      id: events.foreign,
      productId: foreignProduct.id,
      programId: programs.foreign,
      participantId: participants.foreign,
      eventDefinitionId: purchaseDefinition!.id,
      status: "pending",
    },
  ]);
  const [rule] = await db
    .insert(schema.rewardRule)
    .values({
      programId: programs.alpha,
      name: "Scoped read rule",
      type: "referrer_purchase_reward",
      isActive: true,
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        reward: { type: "cash", amount: 1, unit: "fixed", currency: "RUB" },
      },
    })
    .returning();
  const rewardRows = [
    { amount: "1.00", currency: "RUB", rewardType: "cash", status: "approved" },
    { amount: "2.00", currency: "RUB", rewardType: "cash", status: "approved" },
    { amount: "4.00", currency: "USD", rewardType: "cash", status: "approved" },
    {
      amount: "8.00",
      currency: "RUB",
      rewardType: "cash",
      status: "pending_disbursal",
    },
    {
      amount: "16.00",
      currency: "RUB",
      rewardType: "discount",
      status: "approved",
    },
    {
      amount: "32.00",
      currency: "RUB",
      rewardType: "cash",
      status: "disbursed",
    },
    {
      amount: "64.00",
      currency: "EUR",
      rewardType: "cash",
      status: "rejected",
    },
  ];
  const rewards = await db
    .insert(schema.reward)
    .values([
      ...rewardRows.map((row, index) => ({
        ...row,
        id: `rf-scope-reward-${index}-${fixtureId}`,
        participantId: participants.referrer,
        programId: index === 6 ? programs.beta : programs.alpha,
        disbursedAt:
          row.status === "disbursed" ? new Date("2024-01-04T00:00:00Z") : null,
      })),
      {
        id: `rf-scope-reward-legacy-${fixtureId}`,
        programId: programs.legacy,
        participantId: participants.legacy,
        rewardType: "cash",
        amount: "128.00",
        currency: "RUB",
        status: "approved",
      },
      {
        id: `rf-scope-reward-foreign-${fixtureId}`,
        programId: programs.foreign,
        participantId: participants.foreign,
        rewardType: "cash",
        amount: "256.00",
        currency: "RUB",
        status: "approved",
      },
    ])
    .returning();
  return {
    ...fixture,
    programs,
    participants,
    referrals,
    events,
    rewards,
    rule: rule!,
  };
}
async function createLegacyRegressionFixture() {
  const fixtureId = randomUUID();
  const programId = `rf-regression-program-${fixtureId}`;
  const participantId = `rf-regression-participant-${fixtureId}`;
  const externalId = `rf-regression-customer-${fixtureId}`;
  await db.insert(schema.program).values({
    id: programId,
    productId: ids.product,
    name: "Isolated legacy regression",
    status: "active",
    programTemplateId: "single-sided",
  });
  await db.insert(schema.participant).values({
    id: participantId,
    productId: ids.product,
    externalId,
    name: "Retained legacy customer",
    email: `${externalId}@example.test`,
  });
  await db
    .insert(schema.eventDefinition)
    .values([
      { type: "signup", name: "Signup", config: { schemaVersion: 1 } },
      { type: "purchase", name: "Purchase", config: { schemaVersion: 1 } },
    ])
    .onConflictDoNothing();
  return { programId, participantId, externalId };
}

beforeAll(async () => {
  await db.insert(schema.org).values([
    { id: ids.org, name: "Referral fixture" },
    { id: ids.foreignOrg, name: "Foreign fixture" },
  ]);
  const password = await hashPassword("Test-first-payment-password-123!");
  for (const [userId, role] of [
    [ids.admin, "owner"],
    [ids.operator, "admin"],
    [ids.member, "member"],
    [ids.outsider, "member"],
  ] as const) {
    await db.insert(schema.user).values({
      id: userId,
      name: "Verified fixture",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(schema.account).values({
      userId,
      accountId: userId,
      providerId: "credential",
      password,
    });
    await db.insert(schema.orgUser).values({
      orgId: userId === ids.outsider ? ids.foreignOrg : ids.org,
      userId,
      role,
    });
  }
  await db.insert(schema.product).values([
    { id: ids.product, orgId: ids.org, name: "Native first-payment fixture" },
    {
      id: ids.foreignProduct,
      orgId: ids.foreignOrg,
      name: "Foreign native fixture",
    },
  ]);
  await db.insert(schema.program).values([
    {
      id: ids.program,
      productId: ids.product,
      name: "First payment fixture",
      status: "draft",
      programTemplateId: "double-sided",
    },
    {
      id: ids.legacy,
      productId: ids.product,
      name: "Unrelated legacy",
      status: "active",
      programTemplateId: "single-sided",
    },
  ]);
  for (const [userId, email] of [
    [ids.admin, `${ids.admin}@example.test`],
    [ids.operator, `${ids.operator}@example.test`],
    [ids.member, `${ids.member}@example.test`],
    [ids.outsider, `${ids.outsider}@example.test`],
  ]) {
    const headers = await signIn(email!);
    const session = await auth.api.getSession({ headers });
    await db
      .update(schema.session)
      .set({
        activeOrganizationId:
          userId === ids.outsider ? ids.foreignOrg : ids.org,
      })
      .where(eq(schema.session.id, session!.session.id));
    if (userId === ids.admin) adminHeaders = headers;
    else if (userId === ids.operator) operatorHeaders = headers;
    else if (userId === ids.member) memberHeaders = headers;
    else outsiderHeaders = headers;
  }
  const program = await caller(programRouter);
  const settings = {
    firstPaidOnly: true,
    referrer: {
      type: "cash" as const,
      valueType: "fixed" as const,
      value: 1,
      currency: "RUB" as const,
      basis: "payable_amount" as const,
    },
    referee: {
      type: "discount" as const,
      valueType: "percentage" as const,
      value: 50,
      currency: "RUB" as const,
    },
  };
  await program.saveTemplateConfiguration({
    id: ids.program,
    templateConfig: { rewardConfig: settings },
  });
  await program.approveServerTracking({
    productId: ids.product,
    programId: ids.program,
    termsFingerprint: referralTermsFingerprint(settings),
    reviewedPeriod: { startDate: null, endDate: null },
    calculationVersion: 1,
    edgeExamplesApproved: true,
    ownershipPolicyVerified: true,
  });
  await db.insert(schema.participant).values([
    {
      id: ids.referrer,
      productId: ids.product,
      externalId: `tenant-referrer-${suffix}`,
    },
    { id: ids.buyer, productId: ids.product, externalId: ids.buyerExternal },
  ]);
  await (
    await caller(payoutsRouter)
  ).verifyOwnership({
    productId: ids.product,
    participantId: ids.referrer,
    ownerUserId: ids.admin,
    evidence: `synthetic-test-verification-${suffix}`,
    externalOwnershipVerified: true,
  });
  await db.insert(schema.refcode).values({
    code,
    productId: ids.product,
    programId: ids.program,
    participantId: ids.referrer,
  });
  const serviceId = await ensureServiceAccountForOrganization(db, ids.org);
  const createKey = async (scoped: boolean) =>
    (
      await auth.api.createApiKey({
        body: {
          name: "First-payment isolated fixture",
          userId: serviceId,
          permissions: {
            [ids.org]: ["full_access"],
            ...(scoped ? { referrals: ["resolve", "purchase"] } : {}),
          },
          metadata: {
            organizationId: ids.org,
            ...(scoped
              ? {
                  referralScope: {
                    productId: ids.product,
                    programId: ids.program,
                  },
                }
              : {}),
          },
        },
      })
    ).key;
  key = await createKey(true);
  legacyKey = await createKey(false);
  app = Fastify({ logger: false });
  await app.register(coredbPlugin, { db });
  await app.register(betterAuthPlugin, { db });
  await app.register(resolveRoutes, { prefix: "/v1/referrals" });
  await app.register(purchaseRoutes, { prefix: "/v1/track/purchase" });
  await app.register(signupRoutes, { prefix: "/v1/track/signup" });
  await app.ready();
});
// Financial history is intentionally immutable. Fixtures are retained in the explicitly disposable test DB;
// no bypass trigger, destructive cleanup, or deletion of real financial records is part of the test.
afterAll(async () => {
  await app?.close();
  if (ddlDb !== db) await ddlDb.$client.end();
});

describe("native first-payment C1 and payout path", () => {
  it("keeps setup rules idempotent, RUB, and fails approval without explicit reviewed basis", async () => {
    const program = await caller(programRouter);
    const before = await db
      .select()
      .from(schema.rewardRule)
      .where(
        and(
          eq(schema.rewardRule.programId, ids.program),
          eq(schema.rewardRule.isActive, true),
        ),
      );
    const current = await program.getById({
      id: ids.program,
      scope: adminIdentity,
    });
    await program.saveTemplateConfiguration({
      id: ids.program,
      templateConfig: { rewardConfig: current.config!.rewardConfig! },
    });
    const after = await db
      .select()
      .from(schema.rewardRule)
      .where(
        and(
          eq(schema.rewardRule.programId, ids.program),
          eq(schema.rewardRule.isActive, true),
        ),
      );
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.config.reward.currency).toBe("RUB");
    await expect(
      program.approveServerTracking({
        productId: ids.product,
        programId: ids.program,
        termsFingerprint: "0".repeat(64),
        reviewedPeriod: { startDate: null, endDate: null },
        calculationVersion: 1,
        edgeExamplesApproved: true,
        ownershipPolicyVerified: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it.each(["startDate", "endDate"] as const)(
    "rejects approval of a saved %s changed after review",
    async (field) => {
      const fixture = await createFinancialFixture();
      const program = await caller(programRouter);
      const reviewed = await program.getById({
        id: fixture.programId,
        scope: adminIdentity,
      });
      const changed = new Date("2099-01-01T12:00:00.000Z");
      await db
        .update(schema.program)
        .set({ [field]: changed })
        .where(eq(schema.program.id, fixture.programId));
      await expect(
        program.approveServerTracking({
          productId: ids.product,
          programId: fixture.programId,
          termsFingerprint: reviewed.termsFingerprint!,
          reviewedPeriod: {
            startDate: reviewed.startDate?.toISOString() ?? null,
            endDate: reviewed.endDate?.toISOString() ?? null,
          },
          calculationVersion: 1,
          edgeExamplesApproved: true,
          ownershipPolicyVerified: true,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const current = await program.getById({
        id: fixture.programId,
        scope: adminIdentity,
      });
      expect(current[field]).toEqual(changed);
      expect(current.config!.serverTracking).toEqual(
        reviewed.config!.serverTracking,
      );
    },
  );
  it.each([1.001, 100_000_000])(
    "rejects unsupported buyer minimum %s on native save without altering approved terms",
    async (minPurchaseAmount) => {
      const fixture = await createFinancialFixture();
      const program = await caller(programRouter);
      await expect(
        program.saveTemplateConfiguration({
          id: fixture.programId,
          templateConfig: {
            rewardConfig: {
              ...initialTerms,
              referee: { ...initialTerms.referee!, minPurchaseAmount },
            },
          },
        }),
      ).rejects.toThrow();
      const current = await program.getById({
        id: fixture.programId,
        scope: adminIdentity,
      });
      expect(current.status).toBe("active");
      expect(current.config).toEqual(fixture.current.config);
      const response = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: `unpaid-minimum-${randomUUID()}`,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(response.statusCode).toBe(200);
      expect(
        referralCodeResolutionSchema.parse(response.json()).buyerDiscount,
      ).toEqual({
        kind: "percent",
        percentDecimal: "50",
        minPurchaseAmountMinor: null,
      });
    },
  );
  it.each([1.001, 100_000_000])(
    "rejects unsupported buyer minimum %s on native approval of previously saved terms",
    async (minPurchaseAmount) => {
      const fixture = await createFinancialFixture();
      const program = await caller(programRouter);
      const terms: RewardConfigType = {
        ...initialTerms,
        referee: { ...initialTerms.referee!, minPurchaseAmount },
      };
      // Model a configuration saved before exact minimum validation was introduced.
      await db
        .update(schema.program)
        .set({
          status: "pending_approval",
          config: {
            ...fixture.current.config!,
            rewardConfig: terms,
            serverTracking: undefined,
          },
        })
        .where(eq(schema.program.id, fixture.programId));
      await expect(
        program.approveServerTracking({
          productId: ids.product,
          programId: fixture.programId,
          termsFingerprint: referralTermsFingerprint(terms),
          reviewedPeriod: { startDate: null, endDate: null },
          calculationVersion: 1,
          edgeExamplesApproved: true,
          ownershipPolicyVerified: true,
        }),
      ).rejects.toThrow();
      const current = await program.getById({
        id: fixture.programId,
        scope: adminIdentity,
      });
      expect(current.status).toBe("pending_approval");
      expect(current.config!.serverTracking).toBeUndefined();
      const response = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: `unpaid-minimum-${randomUUID()}`,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("REFERRAL_CODE_INACTIVE");
    },
  );
  it.each([
    { minPurchaseAmount: 1.01, minPurchaseAmountMinor: 101 },
    { minPurchaseAmount: 99_999_999.99, minPurchaseAmountMinor: 9_999_999_999 },
  ])(
    "saves, approves and resolves exact buyer minimum $minPurchaseAmount",
    async ({ minPurchaseAmount, minPurchaseAmountMinor }) => {
      const fixture = await createFinancialFixture();
      const program = await caller(programRouter);
      const terms: RewardConfigType = {
        ...initialTerms,
        referee: { ...initialTerms.referee!, minPurchaseAmount },
      };
      await program.saveTemplateConfiguration({
        id: fixture.programId,
        templateConfig: { rewardConfig: terms },
      });
      const approved = await program.approveServerTracking({
        productId: ids.product,
        programId: fixture.programId,
        termsFingerprint: referralTermsFingerprint(terms),
        reviewedPeriod: { startDate: null, endDate: null },
        calculationVersion: 1,
        edgeExamplesApproved: true,
        ownershipPolicyVerified: true,
      });
      expect(approved!.status).toBe("active");
      const before = await businessCounts(ids.product);
      const response = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: `unpaid-minimum-${randomUUID()}`,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(response.statusCode).toBe(200);
      const resolution = referralCodeResolutionSchema.parse(response.json());
      expect(resolution.buyerDiscount).toEqual({
        kind: "percent",
        percentDecimal: "50",
        minPurchaseAmountMinor,
      });
      expect(resolution.commission.basis).toBe("payable_amount");
      expect(resolution.commission.rules).toHaveLength(1);
      expect(await businessCounts(ids.product)).toEqual(before);
    },
  );
  it("resolves once read-only, protects dedicated scope, code syntax and self-referral", async () => {
    const businessCounts = async () => {
      const result = await db.execute(
        sql`SELECT (SELECT count(*) FROM participant WHERE product_id=${ids.product})::integer AS participants, (SELECT count(*) FROM event WHERE product_id=${ids.product})::integer AS events, (SELECT count(*) FROM referral WHERE product_id=${ids.product})::integer AS referrals, (SELECT count(*) FROM reward r JOIN program p ON p.id=r.program_id WHERE p.product_id=${ids.product})::integer AS rewards`,
      );
      return result[0];
    };
    const before = await businessCounts();
    const body = {
      productId: ids.product,
      programId: ids.program,
      customerExternalId: ids.buyerExternal,
      code: ` ${code.toUpperCase()} `,
    };
    const resolved = await post("/v1/referrals/resolve", body);
    expect(resolved.statusCode).toBe(200);
    const terms = referralCodeResolutionSchema.parse(resolved.json());
    expect(terms.canonicalCode).toBe(code);
    expect(terms.firstPaidOnly).toBe(true);
    expect(await businessCounts()).toEqual(before);
    expect(
      (await post("/v1/referrals/resolve", body, legacyKey)).statusCode,
    ).toBe(403);
    expect(
      (
        await post("/v1/referrals/resolve", {
          ...body,
          productId: ids.foreignProduct,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await post("/v1/referrals/resolve", { ...body, code: "vanity-link" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post("/v1/referrals/resolve", { ...body, code: "zzzzzzz" }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await post("/v1/referrals/resolve", {
          ...body,
          customerExternalId: `tenant-referrer-${suffix}`,
        })
      ).statusCode,
    ).toBe(409);
    snapshot = {
      schemaVersion: 1,
      calculationVersion: 1,
      acceptedAt: new Date().toISOString(),
      offerVersion: "a".repeat(64),
      attribution: {
        productId: terms.productId,
        programId: terms.programId,
        codeId: terms.codeId,
        codeValue: terms.canonicalCode,
        referrerParticipantId: terms.referrerParticipantId,
      },
      firstPaidOnly: terms.firstPaidOnly,
      pricing: {
        planCode: "fixture",
        priceVersion: "fixture-v1",
        currency: "RUB",
        baseAmountMinor: 101,
        discountAmountMinor: 51,
        payableAmountMinor: 50,
        buyerDiscountApplicable: true,
        buyerDiscountReason: null,
      },
      buyerDiscount: terms.buyerDiscount,
      commission: terms.commission,
    };
    purchase = {
      timestamp: new Date().toISOString(),
      productId: ids.product,
      programId: ids.program,
      payload: {
        userId: ids.buyerExternal,
        orderId: `checkout-${suffix}`,
        orderAmountMinor: 50,
        currency: "RUB",
        customer: {
          name: "Original buyer profile",
          email: `buyer-${suffix}@example.test`,
        },
        referralSnapshot: snapshot,
      },
    };
  });
  it("atomically claims an existing unpaid participant, persists customer and replays concurrent purchases", async () => {
    const responses = await Promise.all([
      post("/v1/track/purchase", purchase),
      post("/v1/track/purchase", purchase),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const acks = responses.map((r) =>
      minorPurchaseResponseSchema.parse(r.json()),
    );
    ack = acks[0]!;
    expect(acks[1]!.eventId).toBe(ack.eventId);
    expect(acks.map((a) => a.duplicate).sort()).toEqual([false, true]);
    expect(ack.customerExternalId).toBe(ids.buyerExternal);
    expect(ack.participantId).toBe(ids.buyer);
    expect(ack.rewards).toHaveLength(1);
    expect(ack.rewards[0]).toMatchObject({
      amountMinor: 100,
      currency: "RUB",
      participantId: ids.referrer,
      config: snapshot.commission.rules[0]!.config,
    });
    expect(
      (await (await caller(rewardsRouter)).getById(ack.rewardIds[0]!)).metadata,
    ).not.toHaveProperty("couponCode");
    const [buyer] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, ids.buyer));
    expect(buyer).toMatchObject({
      name: "Original buyer profile",
      email: purchase.payload.customer.email,
      firstPurchaseEventId: ack.eventId,
    });
    const replay = await post("/v1/track/purchase", {
      ...purchase,
      payload: {
        ...purchase.payload,
        customer: {
          name: "Updated original buyer",
          email: `updated-${suffix}@example.test`,
        },
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().rewardIds).toEqual(ack.rewardIds);
    expect(
      (
        await db
          .select()
          .from(schema.participant)
          .where(eq(schema.participant.id, ids.buyer))
      )[0]!.name,
    ).toBe("Updated original buyer");
    expect(
      (
        await post("/v1/track/purchase", {
          ...purchase,
          payload: { ...purchase.payload, orderId: `different-${suffix}` },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await post("/v1/track/purchase", {
          ...purchase,
          payload: { ...purchase.payload, userId: `other-tenant-${suffix}` },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await post("/v1/track/purchase", {
          ...purchase,
          payload: {
            ...purchase.payload,
            referralSnapshot: { ...snapshot, calculationVersion: 2 },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post("/v1/track/purchase", {
          ...purchase,
          payload: { ...purchase.payload, orderAmountMinor: 51 },
        })
      ).statusCode,
    ).toBe(400);
    const { customer, ...withoutCustomer } = purchase.payload;
    expect(customer).toEqual({
      name: "Original buyer profile",
      email: `buyer-${suffix}@example.test`,
    });
    const missingCustomer = await post("/v1/track/purchase", {
      ...purchase,
      payload: withoutCustomer,
    });
    expect(missingCustomer.statusCode).toBe(400);
    const [afterMissingCustomer] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, ids.buyer));
    expect(afterMissingCustomer).toMatchObject({
      name: "Updated original buyer",
      email: `updated-${suffix}@example.test`,
      firstPurchaseEventId: ack.eventId,
    });
  });
  it("blocks alternate financial writers but preserves unrelated V1 major-unit tracking", async () => {
    expect(
      (
        await post(
          "/v1/track/purchase",
          {
            timestamp: purchase.timestamp,
            productId: ids.product,
            programId: ids.program,
            payload: {
              userId: ids.buyerExternal,
              orderId: `legacy-bypass-${suffix}`,
              orderAmount: 1,
              currency: "RUB",
            },
          },
          legacyKey,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          "/v1/track/signup",
          {
            timestamp: purchase.timestamp,
            productId: ids.product,
            programId: ids.program,
            payload: { userId: ids.buyerExternal, refcode: code },
          },
          legacyKey,
        )
      ).statusCode,
    ).toBe(403);
    await expect(
      (await caller(eventsRouter)).create({
        productId: ids.product,
        programId: ids.program,
        eventType: "purchase",
        participantId: ids.buyer,
        metadata: {
          schemaVersion: 1,
          orderId: "staff-bypass",
          orderAmount: 10,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      (await caller(eventsRouter)).updateStatus({
        eventId: ack.eventId,
        status: "pending",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const legacy = await post(
      "/v1/track/purchase",
      {
        timestamp: purchase.timestamp,
        productId: ids.product,
        programId: ids.legacy,
        payload: {
          userId: ids.buyerExternal,
          orderId: `legacy-valid-${suffix}`,
          orderAmount: 25.5,
          currency: "USD",
        },
      },
      legacyKey,
    );
    expect(legacy.statusCode).toBe(200);
    const [event] = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.id, legacy.json().eventId));
    expect(event!.metadata).toMatchObject({
      schemaVersion: 1,
      orderAmount: 25.5,
    });
    const [buyer] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, ids.buyer));
    expect(buyer!.name).toBe("Updated original buyer");
  });
  it("preserves native legacy web signup discount values and immutable original coupon terms", async () => {
    await db
      .insert(schema.eventDefinition)
      .values({
        type: "signup",
        name: "Signup",
        config: { schemaVersion: 1 },
      })
      .onConflictDoNothing();
    const rules = await caller(rewardRulesRouter);
    const fixed = await rules.create({
      programId: ids.legacy,
      name: `Legacy fixed discount ${suffix}`,
      type: "discount",
      config: {
        schemaVersion: 1,
        trigger: { event: "signup" },
        participantType: "referee",
        reward: {
          type: "discount",
          unit: "fixed",
          amount: 25,
          currency: "USD",
          validityDays: 7,
          minPurchaseAmount: 75,
        },
      },
    });
    const percentage = await rules.create({
      programId: ids.legacy,
      name: `Legacy percentage discount ${suffix}`,
      type: "discount",
      config: {
        ...fixed!.config!,
        reward: { ...fixed!.config!.reward, unit: "percent", amount: 10 },
      },
    });
    const events = await caller(eventsRouter);
    const rewards = await caller(rewardsRouter);
    const now = Date.now();
    const expectedExpiry = new Date(now);
    expectedExpiry.setDate(expectedExpiry.getDate() + 30);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const event = await events.create({
        productId: ids.product,
        programId: ids.legacy,
        participantId: ids.buyer,
        eventType: "signup",
        metadata: { schemaVersion: 1 },
      });
      for (const [ruleId, expectedAmount] of [
        [fixed!.id, "25.00"],
        [percentage!.id, "10.00"],
      ] as const) {
        const [issued] = await db
          .select({ id: schema.reward.id })
          .from(schema.reward)
          .where(
            and(
              eq(schema.reward.eventId, event.id),
              eq(schema.reward.rewardRuleId, ruleId),
            ),
          );
        const detail = await rewards.getById(issued!.id);
        expect(detail).toMatchObject({
          amount: expectedAmount,
          currency: "USD",
          status: "approved",
          rewardType: "discount",
        });
        expect(detail.metadata?.couponCode?.trim().length).toBeGreaterThan(0);
        expect(detail.metadata?.validUntil).toBe(expectedExpiry.toISOString());
        expect(detail.metadata?.minPurchaseAmount).toBe(
          ruleId === percentage!.id ? 50 : undefined,
        );
        const replay = await processEventForRewards(db, event.id, "web");
        expect(replay.find((row) => row.id === detail.id)?.metadata).toEqual(
          detail.metadata,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("derives own portal scope and excludes pending, discounts and legacy disbursed from withdrawable cash", async () => {
    const portal = await caller(participantPortalRouter);
    const initial = await portal.summary({
      userId: ids.admin,
      productId: ids.product,
    });
    expect(
      initial.balances.find((b) => b.currency === "RUB")!.availableMinor,
    ).toBe(0);
    await (
      await caller(rewardsRouter)
    ).updateApprovalStatus({
      productId: ids.product,
      rewardId: ack.rewardIds[0]!,
      status: "approved",
    });
    await db.insert(schema.reward).values([
      {
        participantId: ids.referrer,
        programId: ids.legacy,
        rewardType: "cash",
        amount: "5.00",
        currency: "RUB",
        status: "disbursed",
        disbursedAt: new Date(),
      },
      {
        participantId: ids.referrer,
        programId: ids.legacy,
        rewardType: "discount",
        amount: "9.00",
        currency: "RUB",
        status: "approved",
      },
      {
        participantId: ids.referrer,
        programId: ids.legacy,
        rewardType: "cash",
        amount: "2.00",
        currency: "USD",
        status: "approved",
      },
    ]);
    const summary = await portal.summary({
      userId: ids.admin,
      productId: ids.product,
    });
    expect(
      summary.balances.find((b) => b.currency === "RUB")!.availableMinor,
    ).toBe(100);
    expect(
      summary.balances.find((b) => b.currency === "USD")!.availableMinor,
    ).toBe(200);
    await expect(
      portal.summary({ userId: ids.operator, productId: ids.product }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      (await caller(participantPortalRouter, operatorHeaders)).summary({
        userId: ids.operator,
        productId: ids.product,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      portal.summary({ userId: ids.admin, productId: ids.foreignProduct }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      (await caller(payoutsRouter, outsiderHeaders)).list({
        userId: ids.outsider,
        organizationId: ids.foreignOrg,
        productId: ids.product,
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reserves partial payouts, serializes operators and preserves unknown transfer reservations", async () => {
    const portal = await caller(participantPortalRouter);
    const a = await caller(payoutsRouter);
    const b = await caller(payoutsRouter, operatorHeaders);
    const results = await Promise.allSettled([
      portal.requestPayout({
        recipient: {
          name: "Fixture recipient",
          details: "Synthetic transfer account",
        },
        userId: ids.admin,
        productId: ids.product,
        amountMinor: 60,
        currency: "RUB",
        idempotencyKey: `payout-a-${suffix}`,
      }),
      portal.requestPayout({
        recipient: {
          name: "Fixture recipient",
          details: "Synthetic transfer account",
        },
        userId: ids.admin,
        productId: ids.product,
        amountMinor: 60,
        currency: "RUB",
        idempotencyKey: `payout-b-${suffix}`,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled")
      throw new Error("No payout winner");
    const payout = winner.value;
    expect(
      (
        await portal.requestPayout({
          recipient: {
            name: "Fixture recipient",
            details: "Synthetic transfer account",
          },
          userId: ids.admin,
          productId: ids.product,
          amountMinor: 60,
          currency: "RUB",
          idempotencyKey: payout.idempotencyKey,
        })
      ).id,
    ).toBe(payout.id);
    await expect(
      portal.requestPayout({
        recipient: {
          name: "Fixture recipient",
          details: "Synthetic transfer account",
        },
        userId: ids.admin,
        productId: ids.product,
        amountMinor: 61,
        currency: "RUB",
        idempotencyKey: payout.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      (await caller(rewardsRouter)).updateApprovalStatus({
        productId: ids.product,
        rewardId: ack.rewardIds[0]!,
        status: "rejected",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      (await caller(rewardsRouter)).markAsDisbursed({
        productId: ids.product,
        rewardId: ack.rewardIds[0]!,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const claims = await Promise.allSettled([
      a.claim({ productId: ids.product, payoutId: payout.id }),
      b.claim({ productId: ids.product, payoutId: payout.id }),
    ]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const claim = claims.find((r) => r.status === "fulfilled");
    if (!claim || claim.status !== "fulfilled")
      throw new Error("No operator claim");
    const operator = claim.value.assignedTo === ids.admin ? a : b;
    await expect(
      operator.reject({
        productId: ids.product,
        payoutId: payout.id,
        reason: "Outcome unknown",
        transferNotExecutedVerified: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const before = (
      await participantBalances(db, ids.product, ids.referrer, ["RUB"])
    )[0]!;
    expect(before).toMatchObject({
      eligibleMinor: 100,
      reservedMinor: 60,
      availableMinor: 40,
    });
    const confirmation = {
      productId: ids.product,
      payoutId: payout.id,
      externalReference: `synthetic-transfer-${suffix}`,
      amountMinor: 60,
      currency: "RUB" as const,
      completedAt: new Date().toISOString(),
      idempotencyKey: `confirmation-${suffix}`,
      paymentAndNoRefundVerified: true as const,
    };
    await expect(
      operator.confirmPaid({ ...confirmation, amountMinor: 61 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await operator.confirmPaid(confirmation)).status).toBe("completed");
    expect((await operator.confirmPaid(confirmation)).id).toBe(payout.id);
    await expect(
      operator.confirmPaid({ ...confirmation, externalReference: "different" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = (
      await participantBalances(db, ids.product, ids.referrer, ["RUB"])
    )[0]!;
    expect(after).toMatchObject({
      eligibleMinor: 100,
      reservedMinor: 0,
      completedMinor: 60,
      availableMinor: 40,
    });
    expect(
      (
        await db
          .select()
          .from(schema.reward)
          .where(eq(schema.reward.id, ack.rewardIds[0]!))
      )[0]!.status,
    ).toBe("approved");
    const next = await portal.requestPayout({
      recipient: {
        name: "Fixture recipient",
        details: "Synthetic transfer account",
      },
      userId: ids.admin,
      productId: ids.product,
      amountMinor: 40,
      currency: "RUB",
      idempotencyKey: `rejected-${suffix}`,
    });
    await a.reject({
      productId: ids.product,
      payoutId: next.id,
      reason: "Fixture request cancelled before execution",
      transferNotExecutedVerified: false,
    });
    expect(
      (await participantBalances(db, ids.product, ids.referrer, ["RUB"]))[0]!
        .availableMinor,
    ).toBe(40);
    await expect(
      db.delete(schema.payout).where(eq(schema.payout.id, payout.id)),
    ).rejects.toThrow();
  });
  it("serializes two first-order keys and never acknowledges processed-without-rewards", async () => {
    const external = `concurrent-first-${suffix}`;
    const orders = await Promise.all(
      ["one", "two"].map((order) =>
        post("/v1/track/purchase", {
          ...purchase,
          payload: {
            ...purchase.payload,
            userId: external,
            orderId: `${order}-${suffix}`,
          },
        }),
      ),
    );
    expect(orders.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const brokenExternal = `incomplete-${suffix}`;
    const [buyer] = await db
      .insert(schema.participant)
      .values({
        productId: ids.product,
        externalId: brokenExternal,
        name: "Before failed replay",
      })
      .returning();
    const [definition] = await db
      .select()
      .from(schema.eventDefinition)
      .where(eq(schema.eventDefinition.type, "purchase"));
    const [attribution] = await db
      .insert(schema.referral)
      .values({
        productId: ids.product,
        programId: ids.program,
        referrerId: ids.referrer,
        externalId: brokenExternal,
        refcodeId: snapshot.attribution.codeId,
        appliedCode: code,
      })
      .returning();
    const orderId = `incomplete-order-${suffix}`;
    const [event] = await db
      .insert(schema.event)
      .values({
        productId: ids.product,
        programId: ids.program,
        participantId: buyer!.id,
        referralId: attribution!.id,
        eventDefinitionId: definition!.id,
        businessKey: orderId,
        occurredAt: new Date(purchase.timestamp),
        status: "processed",
        metadata: {
          schemaVersion: 2,
          source: "api",
          orderId,
          orderAmountMinor: 50,
          currency: "RUB",
          referralSnapshot: snapshot,
        },
      })
      .returning();
    await db
      .update(schema.participant)
      .set({ firstPurchaseEventId: event!.id })
      .where(eq(schema.participant.id, buyer!.id));
    const response = await post("/v1/track/purchase", {
      ...purchase,
      payload: { ...purchase.payload, userId: brokenExternal, orderId },
    });
    expect(response.statusCode).toBe(503);
    expect(
      await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, event!.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(schema.participant)
          .where(eq(schema.participant.id, buyer!.id))
      )[0]!.name,
    ).toBe("Before failed replay");
  });
  it("commits reciprocal first purchases without a participant FK deadlock", async () => {
    const fixtureId = randomUUID();
    const buyers = ["a", "b"].map((side) => ({
      id: `rf-reciprocal-${side}-${fixtureId}`,
      externalId: `tenant-reciprocal-${side}-${fixtureId}`,
      userId: `rf-reciprocal-owner-${side}-${fixtureId}`,
    }));
    await db.insert(schema.user).values(
      buyers.map((buyer) => ({
        id: buyer.userId,
        name: "Reciprocal verified owner",
        email: `${buyer.userId}@example.test`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.participant).values(
      buyers.map((buyer) => ({
        id: buyer.id,
        productId: ids.product,
        externalId: buyer.externalId,
      })),
    );
    const admin = await caller(payoutsRouter);
    for (const buyer of buyers) {
      await admin.verifyOwnership({
        productId: ids.product,
        participantId: buyer.id,
        ownerUserId: buyer.userId,
        evidence: `generated-reciprocal-${fixtureId}`,
        externalOwnershipVerified: true,
      });
    }
    const fixtures = [
      await createFinancialFixture(buyers[0]!.id),
      await createFinancialFixture(buyers[1]!.id),
    ];
    const requests = await Promise.all(
      buyers.map(async (buyer, index) => {
        const fixture = fixtures[1 - index]!;
        const resolution = await post(
          "/v1/referrals/resolve",
          {
            productId: ids.product,
            programId: fixture.programId,
            code: fixture.code,
            customerExternalId: buyer.externalId,
          },
          fixture.apiKey,
        );
        expect(resolution.statusCode).toBe(200);
        const terms = referralCodeResolutionSchema.parse(resolution.json());
        const acceptedAt = new Date().toISOString();
        const body: MinorPurchaseRequest = {
          ...purchase,
          timestamp: acceptedAt,
          programId: fixture.programId,
          payload: {
            ...purchase.payload,
            userId: buyer.externalId,
            orderId: `reciprocal-${buyer.id}`,
            customer: {
              name: "Reciprocal buyer",
              email: `${buyer.userId}@example.test`,
            },
            referralSnapshot: {
              ...snapshot,
              acceptedAt,
              attribution: {
                productId: terms.productId,
                programId: terms.programId,
                codeId: terms.codeId,
                codeValue: terms.canonicalCode,
                referrerParticipantId: terms.referrerParticipantId,
              },
              firstPaidOnly: terms.firstPaidOnly,
              buyerDiscount: terms.buyerDiscount,
              commission: terms.commission,
            },
          },
        };
        return {
          buyer,
          referrer: buyers[1 - index]!,
          body,
          apiKey: fixture.apiKey,
        };
      }),
    );
    const gateName = `reciprocal_pause_${fixtureId.replaceAll("-", "").slice(0, 12)}`;
    const functionName = `${gateName}_fn`;
    // A synchronization-only trigger pauses both real transactions after their buyer lock.
    await ddlDb.execute(sql`CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IN (TG_ARGV[0], TG_ARGV[1]) AND OLD.first_purchase_event_id IS NULL AND NEW.first_purchase_event_id IS NULL THEN
          PERFORM pg_advisory_xact_lock_shared(hashtextextended(TG_ARGV[2], 0));
        END IF;
        RETURN NEW;
      END $$`);
    // Identifiers and arguments below contain only the locally generated UUID/prefix.
    await ddlDb.execute(
      sql.raw(
        `CREATE TRIGGER ${gateName} AFTER UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION ${functionName}('${buyers[0]!.id}', '${buyers[1]!.id}', '${gateName}')`,
      ),
    );
    const gate = await db.$client.reserve();
    const [blocker] = await gate`SELECT pg_backend_pid() AS pid`;
    await gate`SELECT pg_advisory_lock(hashtextextended(${gateName}, 0))`;
    const inFlight = Promise.all(
      requests.map((request) =>
        post("/v1/track/purchase", request.body, request.apiKey),
      ),
    );
    let released = false;
    try {
      await vi.waitFor(
        async () => {
          const [waiting] =
            await gate`SELECT count(*)::integer AS total FROM pg_stat_activity WHERE datname = current_database() AND ${blocker!.pid} = ANY(pg_blocking_pids(pid))`;
          expect(waiting!.total).toBe(2);
        },
        { timeout: 5000, interval: 10 },
      );
      await gate`SELECT pg_advisory_unlock(hashtextextended(${gateName}, 0))`;
      released = true;
      const responses = await inFlight;
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      for (const [index, response] of responses.entries()) {
        const result = minorPurchaseResponseSchema.parse(response.json());
        const request = requests[index]!;
        const buyer = await db.query.participant.findFirst({
          where: eq(schema.participant.id, request.buyer.id),
        });
        expect(buyer?.firstPurchaseEventId).toBe(result.eventId);
        const event = await db.query.event.findFirst({
          where: eq(schema.event.id, result.eventId),
        });
        expect(event?.status).toBe("processed");
        const rewards = await db.query.reward.findMany({
          where: eq(schema.reward.eventId, result.eventId),
        });
        expect(rewards).toMatchObject([
          {
            participantId: request.referrer.id,
            amount: "1.00",
            currency: "RUB",
          },
        ]);
        expect(rewards.map((reward) => reward.id)).toEqual(result.rewardIds);
      }
    } finally {
      if (!released)
        await gate`SELECT pg_advisory_unlock(hashtextextended(${gateName}, 0))`;
      await Promise.allSettled([inFlight]);
      gate.release();
      await ddlDb.execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(gateName)} ON ${schema.participant}`,
      );
      await ddlDb.execute(
        sql`DROP FUNCTION IF EXISTS ${sql.identifier(functionName)}()`,
      );
    }
  }, 15000);
  it("replays frozen terms after archive/code disable and preserves immutable native links", async () => {
    const program = await caller(programRouter);
    const current = await program.getById({
      id: ids.program,
      scope: adminIdentity,
    });
    await program.saveTemplateConfiguration({
      id: ids.program,
      templateConfig: {
        rewardConfig: {
          ...current.config!.rewardConfig!,
          referrer: { ...current.config!.rewardConfig!.referrer!, value: 2 },
        },
      },
    });
    await db
      .update(schema.refcode)
      .set({ isActive: false })
      .where(eq(schema.refcode.code, code));
    await program.delete({ id: ids.program });
    const replay = await post("/v1/track/purchase", purchase);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().rewardIds).toEqual(ack.rewardIds);
    expect(replay.json().rewards[0].amountMinor).toBe(100);
    expect(
      (
        await post("/v1/referrals/resolve", {
          productId: ids.product,
          programId: ids.program,
          customerExternalId: `new-tenant-${suffix}`,
          code,
        })
      ).statusCode,
    ).toBe(422);
    await expect(
      db
        .update(schema.event)
        .set({
          metadata: {
            schemaVersion: 2,
            source: "api",
            orderId: purchase.payload.orderId,
            orderAmountMinor: 50,
            currency: "RUB",
            referralSnapshot: { ...snapshot, offerVersion: "c".repeat(64) },
          },
        })
        .where(eq(schema.event.id, ack.eventId)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.refcode).where(eq(schema.refcode.code, code)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.participant)
        .set({ firstPurchaseEventId: ack.eventId })
        .where(eq(schema.participant.id, ids.referrer)),
    ).rejects.toThrow();
  });
  it("archives accepted server terms before the first purchase is recorded", async () => {
    const fixture = await createFinancialFixture();
    const customerExternalId = `rf-accepted-before-event-${randomUUID()}`;
    const resolved = await post(
      "/v1/referrals/resolve",
      {
        productId: ids.product,
        programId: fixture.programId,
        customerExternalId,
        code: fixture.code,
      },
      fixture.apiKey,
    );
    expect(resolved.statusCode).toBe(200);
    const resolution = referralCodeResolutionSchema.parse(resolved.json());
    const frozen: ReferralSnapshotV1 = {
      ...snapshot,
      acceptedAt: new Date().toISOString(),
      offerVersion: randomBytes(32).toString("hex"),
      attribution: {
        productId: ids.product,
        programId: fixture.programId,
        codeId: resolution.codeId,
        codeValue: resolution.canonicalCode,
        referrerParticipantId: resolution.referrerParticipantId,
      },
      buyerDiscount: resolution.buyerDiscount,
      commission: resolution.commission,
    };
    expect(
      await db.query.event.findMany({
        where: eq(schema.event.programId, fixture.programId),
      }),
    ).toEqual([]);
    await (await caller(programRouter)).delete({ id: fixture.programId });
    expect(
      await db.query.program.findFirst({
        where: eq(schema.program.id, fixture.programId),
      }),
    ).toMatchObject({ status: "archived" });
    const completed = await post(
      "/v1/track/purchase",
      {
        ...purchase,
        timestamp: new Date().toISOString(),
        programId: fixture.programId,
        payload: {
          ...purchase.payload,
          userId: customerExternalId,
          orderId: `rf-accepted-order-${randomUUID()}`,
          referralSnapshot: frozen,
        },
      },
      fixture.apiKey,
    );
    expect(completed.statusCode).toBe(200);
    const result = minorPurchaseResponseSchema.parse(completed.json());
    expect(result.codeId).toBe(resolution.codeId);
    expect(
      result.rewards.map(({ ruleId, amountMinor, currency }) => ({
        ruleId,
        amountMinor,
        currency,
      })),
    ).toEqual([
      {
        ruleId: frozen.commission.rules[0]!.ruleId,
        amountMinor: 100,
        currency: "RUB",
      },
    ]);
  });
  it("deletes an unused legacy shell without deleting organization membership", async () => {
    const programId = `rf-unused-shell-${randomUUID()}`;
    await db.insert(schema.program).values({
      id: programId,
      productId: ids.product,
      programTemplateId: "single-sided",
      name: "Unused legacy shell",
      status: "pending_setup",
    });
    await db.insert(schema.programUser).values({
      programId,
      userId: ids.admin,
      role: "owner",
    });
    await (await caller(programRouter)).delete({ id: programId });
    expect(
      await db.query.program.findFirst({
        where: eq(schema.program.id, programId),
      }),
    ).toBeUndefined();
    expect(
      await db.query.programUser.findMany({
        where: eq(schema.programUser.programId, programId),
      }),
    ).toEqual([]);
    expect(
      await db.query.orgUser.findFirst({
        where: and(
          eq(schema.orgUser.orgId, ids.org),
          eq(schema.orgUser.userId, ids.admin),
        ),
      }),
    ).toMatchObject({ orgId: ids.org, userId: ids.admin });
  });
  it("rejects overlarge and non-JSON bodies before business handling", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/referrals/resolve",
          headers: { "x-api-key": key, "content-type": "application/json" },
          payload: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/referrals/resolve",
          headers: {
            "x-api-key": key,
            "content-type": "application/octet-stream",
          },
          payload: "not-json",
        })
      ).statusCode,
    ).toBe(415);
  });
  it("preserves native legacy rule administration under program locking", async () => {
    const programId = `rf-legacy-rules-${randomUUID()}`;
    await db.insert(schema.program).values({
      id: programId,
      productId: ids.product,
      name: "Legacy rule administration",
      status: "active",
      programTemplateId: "single-sided",
    });
    const rules = await caller(rewardRulesRouter);
    const created = await rules.create({
      programId,
      name: "Legacy cash",
      type: "referrer_purchase_reward",
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        reward: { type: "cash", amount: 1, unit: "fixed", currency: "USD" },
      },
    });
    expect(created).toMatchObject({ programId, isActive: true });
    const updated = await rules.update({
      id: created!.id,
      config: {
        ...created!.config,
        reward: { ...created!.config.reward, amount: 2 },
      },
    });
    expect(updated!.config.reward.amount).toBe(2);
    expect((await rules.toggleActive(created!.id))!.isActive).toBe(false);
    // Existing nullable legacy values retain the previous JS !null -> true behavior.
    await db
      .update(schema.rewardRule)
      .set({ isActive: null })
      .where(eq(schema.rewardRule.id, created!.id));
    expect((await rules.toggleActive(created!.id))!.isActive).toBe(true);
    expect(
      await rules.reorderPriorities({
        programId,
        ruleOrders: [{ ruleId: created!.id, priority: 17 }],
      }),
    ).toMatchObject([{ id: created!.id, priority: 17 }]);
    await rules.delete(created!.id);
    const stored = await rules.getById(created!.id);
    expect(stored).toMatchObject({
      id: created!.id,
      isActive: false,
      priority: 17,
      config: { reward: { amount: 2, currency: "USD" } },
    });
  });
  it.each([
    "create",
    "update",
    "toggleActive",
    "delete",
    "reorderPriorities",
  ] as const)(
    "rejects a stale legacy %s rule writer after server terms are saved",
    async (operation) => {
      const programId = `rf-converting-${randomUUID()}`;
      await db.insert(schema.program).values({
        id: programId,
        productId: ids.product,
        name: "Legacy conversion",
        status: "active",
        programTemplateId: "single-sided",
      });
      const admin = await caller(programRouter);
      await admin.saveTemplateConfiguration({
        id: programId,
        templateConfig: {
          rewardConfig: {
            referrer: initialTerms.referrer,
            firstPaidOnly: false,
          },
        },
      });
      const [oldRule] = await db
        .select()
        .from(schema.rewardRule)
        .where(eq(schema.rewardRule.programId, programId));
      const rules = await caller(rewardRulesRouter);
      const operations: Record<typeof operation, () => Promise<unknown>> = {
        create: () =>
          rules.create({
            programId,
            name: "Stale extra rule",
            type: oldRule!.type,
            config: oldRule!.config,
          }),
        update: () =>
          rules.update({
            id: oldRule!.id,
            config: {
              ...oldRule!.config,
              reward: { ...oldRule!.config.reward, amount: 99 },
            },
          }),
        toggleActive: () => rules.toggleActive(oldRule!.id),
        delete: () => rules.delete(oldRule!.id),
        reorderPriorities: () =>
          rules.reorderPriorities({
            programId,
            ruleOrders: [{ ruleId: oldRule!.id, priority: 999 }],
          }),
      };
      const entered = barrier<number>();
      const release = barrier<void>();
      const writer = db.transaction(async (tx) => {
        await (
          await caller(programRouter, adminHeaders, transactionDb(tx))
        ).saveTemplateConfiguration({
          id: programId,
          templateConfig: {
            rewardConfig: {
              referrer: changedTerms.referrer,
              firstPaidOnly: true,
            },
          },
        });
        const [row] = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        entered.release(row!.pid);
        await release.promise;
      });
      try {
        const blockerPid = await entered.promise;
        const mutation = operations[operation]().then(
          () => null,
          (error: unknown) => error,
        );
        await waitForBlockedQuery(blockerPid);
        release.release();
        await writer;
        expect(await mutation).toMatchObject({ code: "FORBIDDEN" });
      } finally {
        release.release();
        await writer;
      }
      const savedRules = await db
        .select()
        .from(schema.rewardRule)
        .where(eq(schema.rewardRule.programId, programId));
      expect(savedRules).toHaveLength(2);
      expect(savedRules.find((rule) => rule.id === oldRule!.id)).toMatchObject({
        isActive: false,
        priority: oldRule!.priority,
        config: oldRule!.config,
      });
      expect(savedRules.filter((rule) => rule.isActive)).toMatchObject([
        {
          config: {
            conditions: { firstPaidOnly: true },
            reward: { amount: 3, currency: "RUB" },
          },
        },
      ]);
    },
  );
  it.each([false, true])(
    "rejects a stale member config after concurrent admin save (approved=%s)",
    async (approve) => {
      const fixture = await createFinancialFixture();
      const member = await caller(programRouter, memberHeaders);
      const entered = barrier<number>();
      const release = barrier<void>();
      const writer = db.transaction(async (tx) => {
        const admin = await caller(
          programRouter,
          adminHeaders,
          transactionDb(tx),
        );
        await admin.saveTemplateConfiguration({
          id: fixture.programId,
          templateConfig: { rewardConfig: changedTerms },
        });
        if (approve)
          await admin.approveServerTracking({
            productId: ids.product,
            programId: fixture.programId,
            termsFingerprint: referralTermsFingerprint(changedTerms),
            reviewedPeriod: { startDate: null, endDate: null },
            calculationVersion: 1,
            edgeExamplesApproved: true,
            ownershipPolicyVerified: true,
          });
        const [row] = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        entered.release(row!.pid);
        await release.promise;
      });
      try {
        const blockerPid = await entered.promise;
        const update = member
          .updateConfig({
            id: fixture.programId,
            config: {
              ...fixture.current.config!,
              brandConfig: {
                primaryColor: "#123456",
                landingPageUrl: "https://member.example.test",
              },
            },
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await waitForBlockedQuery(blockerPid);
        release.release();
        await writer;
        expect(await update).toMatchObject({ code: "FORBIDDEN" });
      } finally {
        release.release();
        await writer;
      }
      const current = await (
        await caller(programRouter)
      ).getById({ id: fixture.programId, scope: adminIdentity });
      expect(current.config!.rewardConfig).toEqual(changedTerms);
      expect(current.status).toBe(approve ? "active" : "pending_approval");
      if (approve)
        expect(current.config!.serverTracking).toMatchObject({
          approvedBy: ids.admin,
          termsFingerprint: referralTermsFingerprint(changedTerms),
        });
      else expect(current.config!.serverTracking).toBeUndefined();
      const activeRules = await db
        .select()
        .from(schema.rewardRule)
        .where(
          and(
            eq(schema.rewardRule.programId, fixture.programId),
            eq(schema.rewardRule.isActive, true),
          ),
        );
      expect(activeRules).toHaveLength(1);
      expect(activeRules[0]!.config.reward).toMatchObject({
        amount: 3,
        currency: "RUB",
      });
      // The same ordinary member can still change nonfinancial settings from a fresh state.
      const notification = {
        welcomeEmail: { enabled: true, subject: "Welcome", template: "Hello" },
        installation: { completed: true },
      };
      const updated = await member.updateConfig({
        id: fixture.programId,
        config: {
          ...current.config!,
          notification,
          brandConfig: {
            primaryColor: "#654321",
            landingPageUrl: "https://fresh.example.test",
          },
        },
      });
      expect(updated.config!.rewardConfig).toEqual(changedTerms);
      expect(updated.config!.serverTracking).toEqual(
        current.config!.serverTracking,
      );
      expect(updated.config!.brandConfig!.primaryColor).toBe("#654321");
      const reloaded = await (
        await caller(programRouter)
      ).getById({ id: fixture.programId, scope: adminIdentity });
      expect(reloaded.config!.notification).toEqual(notification);
    },
  );
  it("never resolves old approved buyer terms with concurrently saved unapproved rules", async () => {
    const fixture = await createFinancialFixture();
    const body = {
      productId: ids.product,
      programId: fixture.programId,
      customerExternalId: `unpaid-concurrent-${suffix}`,
      code: fixture.code,
    };
    const before = referralCodeResolutionSchema.parse(
      (await post("/v1/referrals/resolve", body, fixture.apiKey)).json(),
    );
    expect(before.buyerDiscount).toMatchObject({
      kind: "percent",
      percentDecimal: "50",
    });
    expect(before.commission.basis).toBe("payable_amount");
    expect(before.commission.rules[0]!.config.reward.amount).toBe(1);
    const counts = await businessCounts(ids.product);
    const entered = barrier<number>();
    const release = barrier<void>();
    const writer = db.transaction(async (tx) => {
      // Blocks the pre-fix resolver's later rule SELECT, not its plain program read.
      await tx.execute(sql`LOCK TABLE reward_rule IN ACCESS EXCLUSIVE MODE`);
      await (
        await caller(programRouter, adminHeaders, transactionDb(tx))
      ).saveTemplateConfiguration({
        id: fixture.programId,
        templateConfig: { rewardConfig: changedTerms },
      });
      const [row] = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      entered.release(row!.pid);
      await release.promise;
    });
    try {
      const blockerPid = await entered.promise;
      const resolving = post(
        "/v1/referrals/resolve",
        body,
        fixture.apiKey,
      ).then((response) => response);
      await waitForBlockedQuery(blockerPid);
      release.release();
      await writer;
      const response = await resolving;
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("REFERRAL_CODE_INACTIVE");
    } finally {
      release.release();
      await writer;
    }
    const admin = await caller(programRouter);
    await admin.approveServerTracking({
      productId: ids.product,
      programId: fixture.programId,
      termsFingerprint: referralTermsFingerprint(changedTerms),
      reviewedPeriod: { startDate: null, endDate: null },
      calculationVersion: 1,
      edgeExamplesApproved: true,
      ownershipPolicyVerified: true,
    });
    const after = referralCodeResolutionSchema.parse(
      (await post("/v1/referrals/resolve", body, fixture.apiKey)).json(),
    );
    expect(after.buyerDiscount).toMatchObject({
      kind: "percent",
      percentDecimal: "25",
    });
    expect(after.commission.basis).toBe("base_amount");
    expect(after.commission.rules).toHaveLength(1);
    expect(after.commission.rules[0]!.config.reward).toMatchObject({
      amount: 3,
      currency: "RUB",
    });
    expect(after.commission.rules[0]!.ruleId).not.toBe(
      before.commission.rules[0]!.ruleId,
    );
    const rules = await db
      .select()
      .from(schema.rewardRule)
      .where(eq(schema.rewardRule.programId, fixture.programId));
    expect(
      rules.find((rule) => rule.id === before.commission.rules[0]!.ruleId),
    ).toMatchObject({
      isActive: false,
      config: before.commission.rules[0]!.config,
    });
    expect(
      rules.find((rule) => rule.id === after.commission.rules[0]!.ruleId),
    ).toMatchObject({
      isActive: true,
      config: after.commission.rules[0]!.config,
    });
    expect(await businessCounts(ids.product)).toEqual(counts);
  });
  it("rejects every V1 purchase for dedicated keys without event, reward or profile writes", async () => {
    const productId = `rf-legacy-target-${randomUUID()}`;
    const programId = `rf-legacy-program-${randomUUID()}`;
    const buyerId = `rf-legacy-buyer-${randomUUID()}`;
    const referrerId = `rf-legacy-referrer-${randomUUID()}`;
    const externalId = `legacy-customer-${randomUUID()}`;
    await db.insert(schema.product).values({
      id: productId,
      orgId: ids.org,
      name: "Same-organization legacy target",
    });
    await db.insert(schema.program).values({
      id: programId,
      productId,
      name: "Legacy target",
      status: "active",
      programTemplateId: "single-sided",
    });
    await db.insert(schema.participant).values([
      {
        id: buyerId,
        productId,
        externalId,
        name: "Unchanged buyer",
        email: "before@example.test",
      },
      { id: referrerId, productId, externalId: `legacy-referrer-${suffix}` },
    ]);
    await db
      .insert(schema.referral)
      .values({ productId, programId, referrerId, externalId });
    await db.insert(schema.rewardRule).values({
      programId,
      name: "Legacy cash",
      type: "purchase_reward",
      isActive: true,
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        reward: { type: "cash", amount: 2, unit: "fixed", currency: "USD" },
      },
    });
    const resolveOnlyKey = await createScopedKey(ids.product, ids.program, [
      "resolve",
    ]);
    const counts = await businessCounts(productId);
    const payload = {
      timestamp: new Date().toISOString(),
      productId,
      programId,
      payload: {
        userId: externalId,
        orderId: `legacy-scope-escape-${suffix}`,
        orderAmount: 25.5,
        currency: "USD",
        customer: {
          name: "Must not replace profile",
          email: "escape@example.test",
        },
      },
    };
    for (const scopedKey of [key, resolveOnlyKey]) {
      const response = await post("/v1/track/purchase", payload, scopedKey);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("FORBIDDEN");
      expect(await businessCounts(productId)).toEqual(counts);
      const [buyer] = await db
        .select()
        .from(schema.participant)
        .where(eq(schema.participant.id, buyerId));
      expect(buyer).toMatchObject({
        name: "Unchanged buyer",
        email: "before@example.test",
        firstPurchaseEventId: null,
      });
    }
    const response = await post("/v1/track/purchase", payload, legacyKey);
    expect(response.statusCode).toBe(200);
    const [event] = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.id, response.json().eventId));
    expect(event!.metadata).toMatchObject({
      schemaVersion: 1,
      orderAmount: 25.5,
    });
    const rewards = await db
      .select()
      .from(schema.reward)
      .where(eq(schema.reward.eventId, event!.id));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      participantId: referrerId,
      amount: "2.00",
      currency: "USD",
    });
    const [buyer] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, buyerId));
    expect(buyer).toMatchObject({
      name: "Unchanged buyer",
      email: "before@example.test",
    });
    const conflicting = await post(
      "/v1/track/purchase",
      {
        ...payload,
        payload: {
          ...payload.payload,
          orderAmount: 26,
          customer: { name: "Rejected update", email: "rejected@example.test" },
        },
      },
      legacyKey,
    );
    expect(conflicting.statusCode).toBe(409);
    const [unchanged] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, buyerId));
    expect(unchanged).toMatchObject({
      name: "Unchanged buyer",
      email: "before@example.test",
    });
    const replay = await post(
      "/v1/track/purchase",
      {
        ...payload,
        payload: { ...payload.payload, customer: { ignored: true } },
      },
      legacyKey,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().eventId).toBe(event!.id);
    expect(
      await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, event!.id)),
    ).toHaveLength(1);
    const [afterReplay] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, buyerId));
    expect(afterReplay).toMatchObject({
      name: "Unchanged buyer",
      email: "before@example.test",
    });
  });
});

describe("native recurring-program clarification", () => {
  it("rewards repeated confirmed purchases in another program after a buyer's first-only claim without changing that claim", async () => {
    const firstOnly = await createFinancialFixture();
    const recurring = await createFinancialFixture(ids.referrer, {
      ...initialTerms,
      firstPaidOnly: false,
      referrer: { ...initialTerms.referrer!, value: 2 },
    });
    const externalId = `rf-recurring-buyer-${randomUUID()}`;
    const acceptedPurchase = async (
      fixture: typeof firstOnly,
      orderId: string,
    ): Promise<MinorPurchaseRequest> => {
      const resolved = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: externalId,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(resolved.statusCode).toBe(200);
      const terms = referralCodeResolutionSchema.parse(resolved.json());
      const timestamp = new Date().toISOString();
      return {
        timestamp,
        productId: ids.product,
        programId: fixture.programId,
        payload: {
          userId: externalId,
          orderId,
          orderAmountMinor: 50,
          currency: "RUB",
          customer: {
            name: "Recurring buyer",
            email: `recurring-${randomUUID()}@example.test`,
          },
          referralSnapshot: {
            schemaVersion: 1,
            calculationVersion: 1,
            acceptedAt: timestamp,
            offerVersion: "a".repeat(64),
            firstPaidOnly: terms.firstPaidOnly,
            attribution: {
              productId: terms.productId,
              programId: terms.programId,
              codeId: terms.codeId,
              codeValue: terms.canonicalCode,
              referrerParticipantId: terms.referrerParticipantId,
            },
            pricing: {
              planCode: "recurring-fixture",
              priceVersion: "fixture-v1",
              currency: "RUB",
              baseAmountMinor: 101,
              discountAmountMinor: 51,
              payableAmountMinor: 50,
              buyerDiscountApplicable: true,
              buyerDiscountReason: null,
            },
            buyerDiscount: terms.buyerDiscount,
            commission: terms.commission,
          },
        },
      };
    };
    const firstRequest = await acceptedPurchase(
      firstOnly,
      `first-${randomUUID()}`,
    );
    const firstResponse = await post(
      "/v1/track/purchase",
      firstRequest,
      firstOnly.apiKey,
    );
    expect(firstResponse.statusCode).toBe(200);
    const first = minorPurchaseResponseSchema.parse(firstResponse.json());
    expect(first.rewards).toMatchObject([{ amountMinor: 100 }]);
    const eventIds: string[] = [];
    for (const order of ["one", "two"]) {
      const request = await acceptedPurchase(
        recurring,
        `recurring-${order}-${randomUUID()}`,
      );
      expect(request.payload.referralSnapshot.firstPaidOnly).toBe(false);
      const response = await post(
        "/v1/track/purchase",
        request,
        recurring.apiKey,
      );
      expect(response.statusCode).toBe(200);
      const result = minorPurchaseResponseSchema.parse(response.json());
      expect(result.participantId).toBe(first.participantId);
      expect(result.rewards).toHaveLength(1);
      expect(result.rewards[0]).toMatchObject({
        amountMinor: 200,
        currency: "RUB",
        participantId: ids.referrer,
      });
      expect(result.rewards[0]!.ruleId).not.toBe(first.rewards[0]!.ruleId);
      const replay = await post(
        "/v1/track/purchase",
        request,
        recurring.apiKey,
      );
      expect(replay.statusCode).toBe(200);
      expect(minorPurchaseResponseSchema.parse(replay.json())).toMatchObject({
        duplicate: true,
        eventId: result.eventId,
        rewardIds: result.rewardIds,
      });
      const rewards = await db.query.reward.findMany({
        where: eq(schema.reward.eventId, result.eventId),
      });
      expect(rewards).toHaveLength(1);
      expect(rewards[0]).toMatchObject({
        programId: recurring.programId,
        amount: "2.00",
        rewardRuleId: result.rewards[0]!.ruleId,
      });
      eventIds.push(result.eventId);
    }
    expect(new Set([first.eventId, ...eventIds]).size).toBe(3);
    const buyer = await db.query.participant.findFirst({
      where: eq(schema.participant.id, first.participantId),
    });
    expect(buyer?.firstPurchaseEventId).toBe(first.eventId);
    const denied = await post(
      "/v1/track/purchase",
      {
        ...firstRequest,
        payload: {
          ...firstRequest.payload,
          orderId: `not-first-${randomUUID()}`,
        },
      },
      firstOnly.apiKey,
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: "REFERRAL_NOT_FIRST_PAYMENT" });
  });
});

describe("independent buyer-discount side", () => {
  it("refuses buyer-only activation without an explicit currency", async () => {
    await expect(
      createFinancialFixture(ids.referrer, {
        firstPaidOnly: true,
        referee: { type: "discount", valueType: "percentage", value: 50 },
      }).then(({ current }) => current.status),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it.each([
    {
      currency: "RUB" as const,
      valueType: "percentage" as const,
      value: 50,
      expectedDiscount: { kind: "percent", percentDecimal: "50" },
    },
    {
      currency: "USD" as const,
      valueType: "fixed" as const,
      value: 0.51,
      expectedDiscount: { kind: "fixed", amountMinor: 51 },
    },
  ])(
    "tracks and replays a $currency $valueType buyer-only discount without inventing a cash reward",
    async ({ currency, valueType, value, expectedDiscount }) => {
      const fixture = await createFinancialFixture(ids.referrer, {
        firstPaidOnly: true,
        referee: {
          type: "discount",
          valueType,
          value,
          currency,
        },
      });
      const externalId = `buyer-only-${randomUUID()}`;
      const resolved = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: externalId,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(resolved.statusCode).toBe(200);
      const terms = referralCodeResolutionSchema.parse(resolved.json());
      expect(terms).toMatchObject({
        currency,
        commission: { basis: null, rules: [] },
        buyerDiscount: expectedDiscount,
      });
      const timestamp = new Date().toISOString();
      const request: MinorPurchaseRequest = {
        timestamp,
        productId: ids.product,
        programId: fixture.programId,
        payload: {
          userId: externalId,
          orderId: `buyer-only-order-${randomUUID()}`,
          orderAmountMinor: 50,
          currency,
          customer: {
            name: "Buyer without referrer commission",
            email: `buyer-only-${randomUUID()}@example.test`,
          },
          referralSnapshot: {
            schemaVersion: 1,
            calculationVersion: 1,
            acceptedAt: timestamp,
            offerVersion: "b".repeat(64),
            firstPaidOnly: true,
            attribution: {
              productId: ids.product,
              programId: fixture.programId,
              codeId: terms.codeId,
              codeValue: terms.canonicalCode,
              referrerParticipantId: ids.referrer,
            },
            pricing: {
              planCode: "buyer-only",
              priceVersion: "fixture-v1",
              currency,
              baseAmountMinor: 101,
              discountAmountMinor: 51,
              payableAmountMinor: 50,
              buyerDiscountApplicable: true,
              buyerDiscountReason: null,
            },
            buyerDiscount: terms.buyerDiscount,
            commission: terms.commission,
          },
        },
      };
      const response = await post(
        "/v1/track/purchase",
        request,
        fixture.apiKey,
      );
      expect(response.statusCode).toBe(200);
      const result = minorPurchaseResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        duplicate: false,
        referrerParticipantId: ids.referrer,
        rewardIds: [],
        rewards: [],
      });
      const buyer = await db.query.participant.findFirst({
        where: eq(schema.participant.id, result.participantId),
      });
      expect(buyer).toMatchObject({
        externalId,
        firstPurchaseEventId: result.eventId,
      });
      const recorded = await db.query.event.findFirst({
        where: eq(schema.event.id, result.eventId),
      });
      expect(recorded).toMatchObject({
        programId: fixture.programId,
        referralId: result.referralId,
        status: "processed",
      });
      expect(
        await db.query.reward.findMany({
          where: eq(schema.reward.eventId, result.eventId),
        }),
      ).toEqual([]);
      const counts = await businessCounts(ids.product);
      const replay = await post("/v1/track/purchase", request, fixture.apiKey);
      expect(replay.statusCode).toBe(200);
      expect(minorPurchaseResponseSchema.parse(replay.json())).toEqual({
        ...result,
        duplicate: true,
      });
      expect(await businessCounts(ids.product)).toEqual(counts);
      const nextResolve = await post(
        "/v1/referrals/resolve",
        {
          productId: ids.product,
          programId: fixture.programId,
          customerExternalId: externalId,
          code: fixture.code,
        },
        fixture.apiKey,
      );
      expect(nextResolve.statusCode).toBe(409);
      expect(nextResolve.json()).toMatchObject({
        code: "REFERRAL_NOT_FIRST_PAYMENT",
      });
    },
  );
});

describe("native follow-up legacy regressions", () => {
  it("activates a new ordinary Single-Sided setup through native V1 purchase without server opt-in", async () => {
    const productId = `rf-native-legacy-product-${randomUUID()}`;
    const referrerId = `rf-native-legacy-referrer-${randomUUID()}`;
    const externalId = `rf-native-legacy-buyer-${randomUUID()}`;
    await db.insert(schema.product).values({
      id: productId,
      orgId: ids.org,
      name: "Ordinary legacy setup",
    });
    const programs = await caller(programRouter);
    const created = await programs.create({
      name: "Ordinary Single-Sided",
      productId,
      templateId: "single-sided",
    });
    await programs.saveTemplateConfiguration({
      id: created.id,
      brandConfig: {
        primaryColor: "#123456",
        landingPageUrl: "https://legacy.example.test/join",
      },
      templateConfig: {
        rewardConfig: {
          firstPaidOnly: false,
          referrer: {
            type: "cash",
            valueType: "fixed",
            value: 1.23,
            currency: "USD",
          },
        },
      },
    });
    await db.insert(schema.participant).values({
      id: referrerId,
      productId,
      externalId: `referrer-${randomUUID()}`,
    });
    await db.insert(schema.referral).values({
      productId,
      programId: created.id,
      referrerId,
      externalId,
    });
    const signup = await post(
      "/v1/track/signup",
      {
        timestamp: new Date().toISOString(),
        productId,
        programId: created.id,
        payload: { userId: externalId },
      },
      legacyKey,
    );
    expect(signup.statusCode).toBe(200);
    const response = await post(
      "/v1/track/purchase",
      {
        timestamp: new Date().toISOString(),
        productId,
        programId: created.id,
        payload: {
          userId: externalId,
          orderId: `native-legacy-${randomUUID()}`,
          orderAmount: 100,
          currency: "USD",
        },
      },
      legacyKey,
    );
    expect(response.statusCode).toBe(200);
    const issued = await db
      .select()
      .from(schema.reward)
      .where(eq(schema.reward.eventId, response.json().eventId));
    expect(issued).toMatchObject([
      {
        participantId: referrerId,
        amount: "1.23",
        currency: "USD",
        rewardType: "cash",
      },
    ]);
    expect(issued).toHaveLength(1);
    const saved = await programs.getById({
      id: created.id,
      scope: adminIdentity,
    });
    expect(saved.status).toBe("active");
    expect(saved.config?.serverTracking).toBeUndefined();
  });

  it("retains customized widget design on a reward-only template save", async () => {
    const fixture = await createLegacyRegressionFixture();
    await db
      .update(schema.program)
      .set({
        config: {
          schemaVersion: 1,
          brandConfig: {
            primaryColor: "#112233",
            landingPageUrl: "https://legacy.example.test/invite",
          },
          widgetConfig: {
            ...defaultWidgetConfig,
            position: "bottom-left",
            title: "My retained invitation",
            triggerText: "Share our club",
            icon: "heart",
            cssVariables: { "--primary": "#abcdef", "--radius": "17px" },
            enabledPlatforms: {
              facebook: false,
              twitter: false,
              linkedin: false,
              whatsapp: false,
              email: true,
              instagram: false,
              telegram: true,
            },
          },
        },
      })
      .where(eq(schema.program.id, fixture.programId));
    const program = await caller(programRouter);
    await program.saveTemplateConfiguration({
      id: fixture.programId,
      templateConfig: {
        rewardConfig: {
          referrer: {
            type: "cash",
            valueType: "fixed",
            value: 10,
            currency: "USD",
          },
        },
      },
    });
    const saved = await program.getById({
      id: fixture.programId,
      scope: adminIdentity,
    });
    expect(saved.config?.widgetConfig).toMatchObject({
      position: "bottom-left",
      title: "My retained invitation",
      triggerText: "Share our club",
      icon: "heart",
      cssVariables: { "--primary": "#abcdef", "--radius": "17px" },
      enabledPlatforms: {
        facebook: false,
        twitter: false,
        linkedin: false,
        whatsapp: false,
        email: true,
        instagram: false,
        telegram: true,
      },
    });
  });

  it("keeps an unrelated custom rule active through template saves and rewards its real event", async () => {
    const fixture = await createLegacyRegressionFixture();
    const rules = await caller(rewardRulesRouter);
    const custom = await rules.create({
      programId: fixture.programId,
      name: "Custom welcome cash",
      type: "welcome_bonus",
      config: {
        schemaVersion: 1,
        trigger: { event: "signup" },
        participantType: "referee",
        reward: { type: "cash", unit: "fixed", amount: 5, currency: "USD" },
      },
    });
    const program = await caller(programRouter);
    const save = {
      id: fixture.programId,
      templateConfig: {
        rewardConfig: {
          referrer: {
            type: "cash" as const,
            valueType: "fixed" as const,
            value: 10,
            currency: "USD" as const,
          },
        },
      },
    };
    await program.saveTemplateConfiguration(save);
    await program.saveTemplateConfiguration(save);
    const event = await (
      await caller(eventsRouter)
    ).create({
      productId: ids.product,
      programId: fixture.programId,
      participantId: fixture.participantId,
      eventType: "signup",
      metadata: { schemaVersion: 1 },
    });
    const issued = await db
      .select()
      .from(schema.reward)
      .where(eq(schema.reward.eventId, event.id));
    expect(issued).toMatchObject([
      {
        rewardRuleId: custom!.id,
        participantId: fixture.participantId,
        amount: "5.00",
        currency: "USD",
        rewardType: "cash",
      },
    ]);
    expect(issued).toHaveLength(1);
    expect(await rules.getById(custom!.id)).toMatchObject({ isActive: true });
    const activeTemplateRules = await db
      .select()
      .from(schema.rewardRule)
      .where(
        and(
          eq(schema.rewardRule.programId, fixture.programId),
          eq(schema.rewardRule.type, "referrer_purchase_reward"),
          eq(schema.rewardRule.isActive, true),
        ),
      );
    expect(activeTemplateRules).toHaveLength(1);
  });

  it.each(
    [
      {
        name: "missing first-paid policy",
        conditions: undefined,
        amount: 1,
        currency: "RUB",
      },
      {
        name: "subcent fixed amount",
        conditions: { firstPaidOnly: true },
        amount: 0.001,
        currency: "RUB",
      },
      {
        name: "signed amount",
        conditions: { firstPaidOnly: true },
        amount: -1,
        currency: "RUB",
      },
      {
        name: "different currency",
        conditions: { firstPaidOnly: true },
        amount: 1,
        currency: "USD",
      },
    ].flatMap((config) =>
      (["save", "approve"] as const).map((operation) => ({
        ...config,
        operation,
      })),
    ),
  )(
    "rejects incompatible custom purchase $name before $operation commits",
    async ({ conditions, amount, currency, operation }) => {
      const conversionTerms: RewardConfigType = {
        firstPaidOnly: true,
        referrer: initialTerms.referrer,
      };
      const fixture = await createLegacyRegressionFixture();
      const rules = await caller(rewardRulesRouter);
      const welcome = await rules.create({
        programId: fixture.programId,
        name: "Unrelated historical welcome",
        type: "custom_signup_history",
        config: {
          schemaVersion: 1,
          trigger: { event: "signup" },
          participantType: "referee",
          reward: { type: "cash", unit: "fixed", amount: 5, currency: "USD" },
        },
      });
      const history = await (
        await caller(eventsRouter)
      ).create({
        productId: ids.product,
        programId: fixture.programId,
        participantId: fixture.participantId,
        eventType: "signup",
        metadata: { schemaVersion: 1 },
      });
      const custom = await rules.create({
        programId: fixture.programId,
        name: "Participating custom purchase",
        type: "custom_purchase_cash",
        config: {
          schemaVersion: 1,
          trigger: { event: "purchase" },
          participantType: "referrer",
          conditions,
          reward: { type: "cash", unit: "fixed", amount, currency },
        },
      });
      if (operation === "approve")
        await db
          .update(schema.program)
          .set({
            status: "pending_approval",
            config: {
              schemaVersion: 1,
              widgetConfig: defaultWidgetConfig,
              rewardConfig: conversionTerms,
            },
          })
          .where(eq(schema.program.id, fixture.programId));
      const readState = async () => ({
        program: await db
          .select()
          .from(schema.program)
          .where(eq(schema.program.id, fixture.programId)),
        rules: await db
          .select()
          .from(schema.rewardRule)
          .where(eq(schema.rewardRule.programId, fixture.programId))
          .orderBy(schema.rewardRule.id),
        events: await db
          .select()
          .from(schema.event)
          .where(eq(schema.event.programId, fixture.programId)),
        rewards: await db
          .select()
          .from(schema.reward)
          .where(eq(schema.reward.programId, fixture.programId)),
      });
      const before = await readState();
      expect(before.rewards).toMatchObject([
        { eventId: history.id, rewardRuleId: welcome!.id, amount: "5.00" },
      ]);
      const programs = await caller(programRouter);
      await expect(
        operation === "save"
          ? programs.saveTemplateConfiguration({
              id: fixture.programId,
              templateConfig: { rewardConfig: conversionTerms },
            })
          : programs.approveServerTracking({
              productId: ids.product,
              programId: fixture.programId,
              termsFingerprint: referralTermsFingerprint(conversionTerms),
              reviewedPeriod: { startDate: null, endDate: null },
              calculationVersion: 1,
              edgeExamplesApproved: true,
              ownershipPolicyVerified: true,
            }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await readState()).toEqual(before);
      if (operation === "save") {
        expect(
          await rules.update({
            id: custom!.id,
            name: "Still editable legacy purchase",
          }),
        ).toMatchObject({ id: custom!.id, isActive: true });
        expect(await rules.getById(welcome!.id)).toEqual(welcome);
      }
    },
  );

  it("retains compatible custom purchase rules and unrelated signup history through approved conversion", async () => {
    const fixture = await createLegacyRegressionFixture();
    const conversionTerms: RewardConfigType = {
      firstPaidOnly: true,
      referrer: initialTerms.referrer,
    };
    const rules = await caller(rewardRulesRouter);
    const welcome = await rules.create({
      programId: fixture.programId,
      name: "Retained welcome",
      type: "custom_retained_signup",
      config: {
        schemaVersion: 1,
        trigger: { event: "signup" },
        participantType: "referee",
        reward: { type: "cash", unit: "fixed", amount: 5, currency: "USD" },
      },
    });
    const history = await (
      await caller(eventsRouter)
    ).create({
      productId: ids.product,
      programId: fixture.programId,
      participantId: fixture.participantId,
      eventType: "signup",
      metadata: { schemaVersion: 1 },
    });
    const historicalRewards = await db
      .select()
      .from(schema.reward)
      .where(eq(schema.reward.eventId, history.id));
    const custom = await rules.create({
      programId: fixture.programId,
      name: "Retained exact commission",
      type: "custom_retained_purchase",
      config: {
        schemaVersion: 1,
        trigger: { event: "purchase" },
        participantType: "referrer",
        conditions: { firstPaidOnly: true },
        reward: { type: "cash", unit: "fixed", amount: 0.25, currency: "RUB" },
      },
    });
    const programs = await caller(programRouter);
    await programs.saveTemplateConfiguration({
      id: fixture.programId,
      templateConfig: { rewardConfig: conversionTerms },
    });
    await programs.approveServerTracking({
      productId: ids.product,
      programId: fixture.programId,
      termsFingerprint: referralTermsFingerprint(conversionTerms),
      reviewedPeriod: { startDate: null, endDate: null },
      calculationVersion: 1,
      edgeExamplesApproved: true,
      ownershipPolicyVerified: true,
    });
    expect(await rules.getById(custom!.id)).toEqual(custom);
    expect(await rules.getById(welcome!.id)).toEqual(welcome);
    expect(
      await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, history.id)),
    ).toEqual(historicalRewards);
    const fixtureCode = randomBytes(4).toString("hex").slice(0, 7);
    await db.insert(schema.refcode).values({
      code: fixtureCode,
      productId: ids.product,
      programId: fixture.programId,
      participantId: ids.referrer,
    });
    const resolved = await post(
      "/v1/referrals/resolve",
      {
        productId: ids.product,
        programId: fixture.programId,
        customerExternalId: fixture.externalId,
        code: fixtureCode,
      },
      await createScopedKey(ids.product, fixture.programId),
    );
    expect(resolved.statusCode).toBe(200);
    const terms = referralCodeResolutionSchema.parse(resolved.json());
    expect(terms.commission.rules).toHaveLength(2);
    expect(
      terms.commission.rules.find((rule) => rule.ruleId === custom!.id)?.config,
    ).toEqual(custom!.config);
  });

  it.each([
    "api-signup",
    "api-purchase",
    "web-signup",
    "web-purchase",
  ] as const)(
    "preserves signed V1 fixed and percent decimals, subcent rounding and replay through %s",
    async (transport) => {
      const fixture = await createLegacyRegressionFixture();
      const rules = await caller(rewardRulesRouter);
      const eventType = transport.endsWith("purchase") ? "purchase" : "signup";
      const specs = [
        {
          name: "fixed",
          unit: "fixed" as const,
          amount: -1.25,
          expected: "-1.25",
        },
        {
          name: "negative-native-limit",
          unit: "fixed" as const,
          amount: -99999999.99,
          expected: "-99999999.99",
        },
        {
          name: "negative-half-cent",
          unit: "fixed" as const,
          amount: -0.005,
          expected: "-0.01",
        },
        {
          name: "negative-rounded-zero",
          unit: "fixed" as const,
          amount: -0.004,
          expected: "0.00",
        },
        {
          name: "negative-exponent",
          unit: "fixed" as const,
          amount: -1e-7,
          expected: "0.00",
        },
        {
          name: "percent-unrounded-major-base",
          unit: "percent" as const,
          amount: -50,
          expected:
            eventType === "purchase"
              ? "-0.01"
              : transport === "api-signup"
                ? "0.00"
                : "-50.00",
        },
        {
          name: "percent-negative-half-cent",
          unit: "percent" as const,
          amount: -20,
          expected:
            eventType === "purchase"
              ? "-0.01"
              : transport === "api-signup"
                ? "0.00"
                : "-20.00",
        },
      ];
      const expected = new Map<string, string>();
      for (const spec of specs) {
        const rule = await rules.create({
          programId: fixture.programId,
          name: spec.name,
          type: `signed_${spec.name}`,
          config: {
            schemaVersion: 1,
            trigger: { event: eventType },
            participantType: "referee",
            reward: {
              type: "cash",
              unit: spec.unit,
              amount: spec.amount,
              currency: "USD",
            },
          },
        });
        expected.set(rule!.id, spec.expected);
      }
      let eventId: string;
      if (transport.startsWith("api-")) {
        const response = await post(
          `/v1/track/${eventType}`,
          {
            timestamp: new Date().toISOString(),
            productId: ids.product,
            programId: fixture.programId,
            payload: {
              userId: fixture.externalId,
              ...(eventType === "purchase"
                ? {
                    orderId: `signed-${randomUUID()}`,
                    orderAmount: 0.025,
                    currency: "USD",
                  }
                : {}),
            },
          },
          legacyKey,
        );
        expect(response.statusCode).toBe(200);
        eventId = response.json().eventId;
      } else {
        eventId = (
          await (
            await caller(eventsRouter)
          ).create({
            productId: ids.product,
            programId: fixture.programId,
            participantId: fixture.participantId,
            eventType,
            metadata: {
              schemaVersion: 1,
              ...(eventType === "purchase"
                ? {
                    orderId: `signed-web-${randomUUID()}`,
                    orderAmount: 0.025,
                    currency: "USD",
                  }
                : {}),
            },
          })
        ).id;
      }
      const issued = await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, eventId))
        .orderBy(schema.reward.id);
      expect(issued).toHaveLength(specs.length);
      for (const row of issued) {
        expect(row.amount).toBe(expected.get(row.rewardRuleId!));
        expect(row).toMatchObject({
          participantId: fixture.participantId,
          currency: "USD",
          rewardType: "cash",
        });
      }
      const replay = await processEventForRewards(
        db,
        eventId,
        transport.startsWith("api-") ? "api" : "web",
      );
      expect(replay.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        issued.sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(
        (
          await db
            .select()
            .from(schema.event)
            .where(eq(schema.event.id, eventId))
        )[0]?.status,
      ).toBe("processed");
    },
  );

  it.each([
    {
      transport: "api-signup",
      base: undefined,
      expected: "0.00",
      coupons: false,
    },
    { transport: "api-purchase", base: 200, expected: "20.00", coupons: false },
    {
      transport: "web-absent",
      base: undefined,
      expected: "10.00",
      coupons: true,
    },
    { transport: "web-zero", base: 0, expected: "10.00", coupons: true },
    { transport: "web-amount", base: 200, expected: "20.00", coupons: true },
  ])(
    "preserves percentage-base and coupon behavior for $transport",
    async ({ transport, base, expected, coupons }) => {
      const fixture = await createLegacyRegressionFixture();
      const rules = await caller(rewardRulesRouter);
      for (const type of ["cash", "discount"] as const) {
        await rules.create({
          programId: fixture.programId,
          name: `Percentage ${type}`,
          type: `custom_percent_${type}`,
          config: {
            schemaVersion: 1,
            trigger: {
              event: transport === "api-purchase" ? "purchase" : "signup",
            },
            participantType: "referee",
            reward: {
              type,
              unit: "percent",
              amount: 10,
              currency: "USD",
              validityDays: 7,
              minPurchaseAmount: 75,
            },
          },
        });
      }
      const earliestExpiry = new Date();
      earliestExpiry.setDate(earliestExpiry.getDate() + 30);
      let eventId: string;
      if (transport.startsWith("api-")) {
        const response = await post(
          transport === "api-purchase"
            ? "/v1/track/purchase"
            : "/v1/track/signup",
          {
            timestamp: new Date().toISOString(),
            productId: ids.product,
            programId: fixture.programId,
            payload: {
              userId: fixture.externalId,
              ...(transport === "api-purchase"
                ? {
                    orderId: `percent-order-${randomUUID()}`,
                    orderAmount: base,
                    currency: "USD",
                  }
                : {}),
            },
          },
          legacyKey,
        );
        expect(response.statusCode).toBe(200);
        eventId = response.json().eventId;
      } else {
        eventId = (
          await (
            await caller(eventsRouter)
          ).create({
            productId: ids.product,
            programId: fixture.programId,
            participantId: fixture.participantId,
            eventType: "signup",
            metadata: {
              schemaVersion: 1,
              ...(base === undefined ? {} : { orderAmount: base }),
            },
          })
        ).id;
      }
      const issued = await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, eventId));
      expect(issued).toHaveLength(2);
      expect(issued.map((row) => row.amount)).toEqual([expected, expected]);
      const coupon = issued.find((row) => row.rewardType === "discount")!;
      if (coupons) {
        const latestExpiry = new Date();
        latestExpiry.setDate(latestExpiry.getDate() + 30);
        expect(coupon.metadata).toMatchObject({ minPurchaseAmount: 50 });
        expect(coupon.metadata?.couponCode).toMatch(/^REF-/);
        const expiry = Date.parse(coupon.metadata!.validUntil!);
        expect(expiry).toBeGreaterThanOrEqual(earliestExpiry.getTime());
        expect(expiry).toBeLessThanOrEqual(latestExpiry.getTime());
      } else {
        for (const field of ["couponCode", "validUntil", "minPurchaseAmount"])
          expect(coupon.metadata).not.toHaveProperty(field);
      }
      const [storedEvent] = await db
        .select()
        .from(schema.event)
        .where(eq(schema.event.id, eventId));
      if (base === undefined)
        expect(storedEvent!.metadata).not.toHaveProperty("orderAmount");
      const replay = await processEventForRewards(
        db,
        eventId,
        transport.startsWith("api-") ? "api" : "web",
      );
      expect(replay.map((row) => row.id).sort()).toEqual(
        issued.map((row) => row.id).sort(),
      );
      expect(replay.find((row) => row.id === coupon.id)?.metadata).toEqual(
        coupon.metadata,
      );
    },
  );

  it.each(
    (["api", "web"] as const).flatMap((transport) =>
      [100000000, -100000000].map((amount) => ({ transport, amount })),
    ),
  )(
    "marks a durably inserted legacy event failed after accepted overflow $amount rejects through $transport",
    async ({ transport, amount }) => {
      const fixture = await createLegacyRegressionFixture();
      const rule = await (
        await caller(rewardRulesRouter)
      ).create({
        programId: fixture.programId,
        name: "Canonical overflowing signup reward",
        type: "custom_overflow",
        config: {
          schemaVersion: 1,
          trigger: { event: "signup" },
          participantType: "referee",
          reward: {
            type: "cash",
            unit: "fixed",
            amount,
            currency: "USD",
          },
        },
      });
      expect(rule!.config.reward.amount).toBe(amount);
      if (transport === "api") {
        const response = await post(
          "/v1/track/signup",
          {
            timestamp: new Date().toISOString(),
            productId: ids.product,
            programId: fixture.programId,
            payload: { userId: fixture.externalId },
          },
          legacyKey,
        );
        expect(response.statusCode).toBe(500);
      } else {
        await expect(
          (await caller(eventsRouter)).create({
            productId: ids.product,
            programId: fixture.programId,
            participantId: fixture.participantId,
            eventType: "signup",
            metadata: { schemaVersion: 1 },
          }),
        ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      }
      const events = await db
        .select()
        .from(schema.event)
        .where(eq(schema.event.programId, fixture.programId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: "failed",
        participantId: fixture.participantId,
      });
      expect(
        await db
          .select()
          .from(schema.reward)
          .where(eq(schema.reward.eventId, events[0]!.id)),
      ).toEqual([]);
    },
  );

  it("does not mutate a legacy customer profile when a conflicting V1 order is rejected", async () => {
    const fixture = await createLegacyRegressionFixture();
    const payload = {
      timestamp: new Date().toISOString(),
      productId: ids.product,
      programId: fixture.programId,
      payload: {
        userId: fixture.externalId,
        orderId: `profile-conflict-${randomUUID()}`,
        orderAmount: 25,
        currency: "USD",
      },
    };
    expect(
      (await post("/v1/track/purchase", payload, legacyKey)).statusCode,
    ).toBe(200);
    const conflict = await post(
      "/v1/track/purchase",
      {
        ...payload,
        payload: {
          ...payload.payload,
          orderAmount: 30,
          customer: {
            name: "Rejected mutation",
            email: "rejected@example.test",
          },
        },
      },
      legacyKey,
    );
    expect(conflict.statusCode).toBe(409);
    const [buyer] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, fixture.participantId));
    expect(buyer).toMatchObject({
      name: "Retained legacy customer",
      email: `${fixture.externalId}@example.test`,
    });
    const events = await db
      .select()
      .from(schema.event)
      .where(eq(schema.event.programId, fixture.programId));
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ orderAmount: 25 });
  });
  it("keeps legacy discount fulfillment outside the linked cash-payout contour", async () => {
    const identity = await createProductScopeFixture();
    const fixture = await createLegacyRegressionFixture();
    const rewardRows = await db
      .insert(schema.reward)
      .values([
        {
          participantId: fixture.participantId,
          programId: fixture.programId,
          rewardType: "cash",
          amount: "3.25",
          currency: "USD",
          status: "approved",
        },
        {
          participantId: fixture.participantId,
          programId: fixture.programId,
          rewardType: "discount",
          amount: "10.00",
          currency: "USD",
          status: "approved",
        },
      ])
      .returning();
    await (
      await caller(payoutsRouter)
    ).verifyOwnership({
      productId: ids.product,
      participantId: fixture.participantId,
      ownerUserId: identity.memberIdentity.userId,
      evidence: `legacy-fulfillment-owner-${randomUUID()}`,
      externalOwnershipVerified: true,
    });
    const discount = rewardRows.find((row) => row.rewardType === "discount")!;
    const cash = rewardRows.find((row) => row.rewardType === "cash")!;
    const rewards = await caller(rewardsRouter);
    const listed = await rewards.getAll({
      scope: { ...adminIdentity, productId: ids.product },
      page: 1,
      pageSize: 100,
    });
    expect(listed.data.find((row) => row.id === discount.id)).toMatchObject({
      payoutManaged: false,
      status: "approved",
    });
    expect(listed.data.find((row) => row.id === cash.id)).toMatchObject({
      payoutManaged: true,
      status: "approved",
    });
    const completed = await rewards.markAsDisbursed({
      productId: ids.product,
      rewardId: discount.id,
    });
    expect(completed.reward).toMatchObject({
      id: discount.id,
      rewardType: "discount",
      status: "disbursed",
      amount: "10.00",
    });
    expect(
      (
        await participantBalances(db, ids.product, fixture.participantId, [
          "USD",
        ])
      )[0],
    ).toMatchObject({ eligibleMinor: 325, availableMinor: 325 });
  });

  it.each([
    {
      name: "omitted rule currency and malformed purchase currency",
      ruleCurrency: undefined,
      purchaseCurrency: "not-a-currency",
      expectedCurrency: "USD",
    },
    {
      name: "malformed legacy rule currency",
      ruleCurrency: "not-a-currency",
      purchaseCurrency: "USD",
      expectedCurrency: "USD",
    },
    {
      name: "supported configured currency over purchase metadata",
      ruleCurrency: "EUR",
      purchaseCurrency: "not-a-currency",
      expectedCurrency: "EUR",
    },
  ])(
    "preserves legacy currency authority for $name",
    async ({ ruleCurrency, purchaseCurrency, expectedCurrency }) => {
      const fixture = await createLegacyRegressionFixture();
      const rule = await (
        await caller(rewardRulesRouter)
      ).create({
        programId: fixture.programId,
        name: "Legacy fixed currency",
        type: "custom_currency_regression",
        config: {
          schemaVersion: 1,
          trigger: { event: "purchase" },
          participantType: "referee",
          reward: {
            type: "cash",
            unit: "fixed",
            amount: 1.25,
            currency: ruleCurrency,
          },
        },
      });
      const response = await post(
        "/v1/track/purchase",
        {
          timestamp: new Date().toISOString(),
          productId: ids.product,
          programId: fixture.programId,
          payload: {
            userId: fixture.externalId,
            orderId: `legacy-currency-${randomUUID()}`,
            orderAmount: 25,
            currency: purchaseCurrency,
          },
        },
        legacyKey,
      );
      expect(response.statusCode).toBe(200);
      const issued = await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, response.json().eventId));
      expect(issued).toMatchObject([
        {
          rewardRuleId: rule!.id,
          participantId: fixture.participantId,
          rewardType: "cash",
          amount: "1.25",
          currency: expectedCurrency,
          status: "pending_disbursal",
        },
      ]);
    },
  );

  it.each([
    { field: "orderAmountMinor", value: 100 },
    { field: "referralSnapshot", value: { schemaVersion: 99 } },
  ])(
    "rejects mixed V1 $field without falling back to legacy writes",
    async ({ field, value }) => {
      const fixture = await createLegacyRegressionFixture();
      const before = await businessCounts(ids.product);
      const response = await post(
        "/v1/track/purchase",
        {
          timestamp: new Date().toISOString(),
          productId: ids.product,
          programId: fixture.programId,
          payload: {
            userId: fixture.externalId,
            orderId: `mixed-contract-${randomUUID()}`,
            orderAmount: 25,
            currency: "USD",
            [field]: value,
          },
        },
        legacyKey,
      );
      expect(response.statusCode).toBe(400);
      expect(await businessCounts(ids.product)).toEqual(before);
      const [buyer] = await db
        .select()
        .from(schema.participant)
        .where(eq(schema.participant.id, fixture.participantId));
      expect(buyer).toMatchObject({
        name: "Retained legacy customer",
        email: `${fixture.externalId}@example.test`,
      });
    },
  );
});

describe("native follow-up own-wallet regressions", () => {
  it.each(["native-approval", "already-approved-history"] as const)(
    "preserves signed legacy cash debt through balances, own portal and approval transitions (%s)",
    async (entry) => {
      const identity = await createProductScopeFixture();
      const fixture = await createLegacyRegressionFixture();
      await (
        await caller(payoutsRouter)
      ).verifyOwnership({
        productId: ids.product,
        participantId: fixture.participantId,
        ownerUserId: identity.memberIdentity.userId,
        evidence: `signed-ledger-owner-${randomUUID()}`,
        externalOwnershipVerified: true,
      });
      const rule = await (
        await caller(rewardRulesRouter)
      ).create({
        programId: fixture.programId,
        name: "Signed legacy ledger cash",
        type: "signed_legacy_ledger",
        config: {
          schemaVersion: 1,
          trigger: { event: "signup" },
          participantType: "referee",
          reward: {
            type: "cash",
            unit: "fixed",
            amount: -1.25,
            currency: "USD",
          },
        },
      });
      const event = await (
        await caller(eventsRouter)
      ).create({
        productId: ids.product,
        programId: fixture.programId,
        participantId: fixture.participantId,
        eventType: "signup",
        metadata: { schemaVersion: 1 },
      });
      const [reward] = await db
        .select()
        .from(schema.reward)
        .where(eq(schema.reward.eventId, event.id));
      expect(reward).toMatchObject({
        amount: "-1.25",
        status: "pending_disbursal",
        rewardRuleId: rule!.id,
      });
      const rewards = await caller(rewardsRouter);
      if (entry === "already-approved-history")
        await db
          .update(schema.reward)
          .set({ status: "approved" })
          .where(eq(schema.reward.id, reward!.id));
      else
        expect(
          await rewards.updateApprovalStatus({
            productId: ids.product,
            rewardId: reward!.id,
            status: "approved",
          }),
        ).toMatchObject({
          success: true,
          reward: { id: reward!.id, amount: "-1.25", status: "approved" },
        });
      const expectedDebt = {
        currency: "USD",
        eligibleMinor: -125,
        reservedMinor: 0,
        completedMinor: 0,
        availableMinor: -125,
      };
      expect(
        (
          await participantBalances(db, ids.product, fixture.participantId, [
            "USD",
          ])
        )[0],
      ).toEqual(expectedDebt);
      const portal = await caller(
        participantPortalRouter,
        identity.memberHeaders,
      );
      const ownScope = {
        userId: identity.memberIdentity.userId,
        productId: ids.product,
      };
      expect(
        (await portal.summary(ownScope)).balances.find(
          (balance) => balance.currency === "USD",
        ),
      ).toEqual(expectedDebt);
      const history = await portal.history({
        ...ownScope,
        page: 1,
        pageSize: 20,
      });
      expect(history.rewards).toMatchObject([
        {
          id: reward!.id,
          eventId: event.id,
          amount: "-1.25",
          status: "approved",
        },
      ]);
      const before = await businessCounts(ids.product);
      await expect(
        portal.requestPayout({
          recipient: {
            name: "Fixture recipient",
            details: "Synthetic transfer account",
          },
          ...ownScope,
          currency: "USD",
          amountMinor: 1,
          idempotencyKey: `signed-debt-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await businessCounts(ids.product)).toEqual(before);
      expect(
        (await portal.history({ ...ownScope, page: 1, pageSize: 20 })).payouts,
      ).toEqual([]);
      for (const status of [
        "pending_disbursal",
        "approved",
        "rejected",
        "approved",
      ] as const) {
        expect(
          await rewards.updateApprovalStatus({
            productId: ids.product,
            rewardId: reward!.id,
            status,
          }),
        ).toMatchObject({
          reward: {
            id: reward!.id,
            eventId: event.id,
            amount: "-1.25",
            status,
          },
        });
        expect(
          (await portal.summary(ownScope)).balances.find(
            (balance) => balance.currency === "USD",
          ),
        ).toEqual({
          ...expectedDebt,
          eligibleMinor: status === "approved" ? -125 : 0,
          availableMinor: status === "approved" ? -125 : 0,
        });
      }
      expect(await processEventForRewards(db, event.id, "web")).toMatchObject([
        {
          id: reward!.id,
          eventId: event.id,
          rewardRuleId: rule!.id,
          amount: "-1.25",
          status: "approved",
        },
      ]);
    },
  );

  it.each(["requested", "completed"] as const)(
    "blocks signed legacy approval and positive reward removal from underfunding %s payouts",
    async (obligation) => {
      const identity = await createProductScopeFixture();
      const fixture = await createLegacyRegressionFixture();
      const payouts = await caller(payoutsRouter);
      await payouts.verifyOwnership({
        productId: ids.product,
        participantId: fixture.participantId,
        ownerUserId: identity.memberIdentity.userId,
        evidence: `signed-obligation-${randomUUID()}`,
        externalOwnershipVerified: true,
      });
      const [positive, negative] = await db
        .insert(schema.reward)
        .values([
          {
            participantId: fixture.participantId,
            programId: fixture.programId,
            rewardType: "cash",
            amount: "2.00",
            currency: "USD",
            status: "approved",
          },
          {
            participantId: fixture.participantId,
            programId: fixture.programId,
            rewardType: "cash",
            amount: "-1.25",
            currency: "USD",
            status: "pending_disbursal",
          },
        ])
        .returning();
      const portal = await caller(
        participantPortalRouter,
        identity.memberHeaders,
      );
      const ownScope = {
        userId: identity.memberIdentity.userId,
        productId: ids.product,
      };
      const payout = await portal.requestPayout({
        recipient: {
          name: "Fixture recipient",
          details: "Synthetic transfer account",
        },
        ...ownScope,
        currency: "USD",
        amountMinor: 100,
        idempotencyKey: `signed-obligation-payout-${randomUUID()}`,
      });
      if (obligation === "completed") {
        await payouts.claim({ productId: ids.product, payoutId: payout.id });
        await payouts.confirmPaid({
          productId: ids.product,
          payoutId: payout.id,
          amountMinor: 100,
          currency: "USD",
          externalReference: `synthetic-signed-obligation-${randomUUID()}`,
          completedAt: new Date().toISOString(),
          idempotencyKey: `signed-obligation-confirm-${randomUUID()}`,
          paymentAndNoRefundVerified: true,
        });
      }
      const before = await portal.summary(ownScope);
      const history = await portal.history({
        ...ownScope,
        page: 1,
        pageSize: 20,
      });
      const rewards = await caller(rewardsRouter);
      for (const change of [
        { rewardId: negative!.id, status: "approved" as const },
        { rewardId: positive!.id, status: "rejected" as const },
        { rewardId: positive!.id, status: "pending_disbursal" as const },
      ]) {
        await expect(
          rewards.updateApprovalStatus({ productId: ids.product, ...change }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await portal.summary(ownScope)).toEqual(before);
        expect(
          await portal.history({ ...ownScope, page: 1, pageSize: 20 }),
        ).toEqual(history);
      }
      expect(
        before.balances.find((balance) => balance.currency === "USD"),
      ).toEqual({
        currency: "USD",
        eligibleMinor: 200,
        availableMinor: 100,
        reservedMinor: obligation === "requested" ? 100 : 0,
        completedMinor: obligation === "completed" ? 100 : 0,
      });
    },
  );

  it("keeps verified own portal and payout access after native removal leaves a stale unrelated active organization", async () => {
    const identity = await createProductScopeFixture();
    const fixture = await createLegacyRegressionFixture();
    await (
      await caller(payoutsRouter)
    ).verifyOwnership({
      productId: ids.product,
      participantId: fixture.participantId,
      ownerUserId: identity.memberIdentity.userId,
      evidence: `removed-member-ownership-${randomUUID()}`,
      externalOwnershipVerified: true,
    });
    await db.insert(schema.reward).values({
      participantId: fixture.participantId,
      programId: fixture.programId,
      rewardType: "cash",
      amount: "3.25",
      currency: "USD",
      status: "approved",
    });
    const ownScope = {
      userId: identity.memberIdentity.userId,
      productId: ids.product,
    };
    expect(
      (
        await (
          await caller(participantPortalRouter, identity.memberHeaders)
        ).summary(ownScope)
      ).balances.find((balance) => balance.currency === "USD")!.availableMinor,
    ).toBe(325);
    await auth.api.removeMember({
      headers: identity.ownerHeaders,
      body: {
        organizationId: identity.identity.organizationId,
        memberIdOrEmail: `${identity.memberIdentity.userId}@example.test`,
      },
    });
    expect(
      (await auth.api.getSession({ headers: identity.memberHeaders }))!.session
        .activeOrganizationId,
    ).toBe(identity.identity.organizationId);
    expect(
      await db
        .select()
        .from(schema.orgUser)
        .where(
          and(
            eq(schema.orgUser.orgId, identity.identity.organizationId),
            eq(schema.orgUser.userId, identity.memberIdentity.userId),
          ),
        ),
    ).toEqual([]);
    const portal = await caller(
      participantPortalRouter,
      identity.memberHeaders,
    );
    expect(await portal.memberships({ userId: ownScope.userId })).toEqual([
      { productId: ids.product, productName: "Native first-payment fixture" },
    ]);
    expect(
      (await portal.summary(ownScope)).balances.find(
        (balance) => balance.currency === "USD",
      )!,
    ).toMatchObject({ eligibleMinor: 325, availableMinor: 325 });
    const payout = await portal.requestPayout({
      recipient: {
        name: "Fixture recipient",
        details: "Synthetic transfer account",
      },
      ...ownScope,
      currency: "USD",
      amountMinor: 125,
      idempotencyKey: `removed-member-payout-${randomUUID()}`,
    });
    expect(payout).toMatchObject({
      participantId: fixture.participantId,
      status: "requested",
      amountMinor: 125,
    });
    const history = await portal.history({
      ...ownScope,
      page: 1,
      pageSize: 20,
    });
    expect(history.payouts.map((row) => row.id)).toContain(payout.id);
    expect(
      (await portal.summary(ownScope)).balances.find(
        (balance) => balance.currency === "USD",
      )!,
    ).toMatchObject({ reservedMinor: 125, availableMinor: 200 });
    await expect(
      (await caller(programRouter, identity.memberHeaders)).getAll({
        scope: identity.memberScope,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      (await caller(productSecretsRouter, identity.memberHeaders)).get({
        productId: identity.targetProduct.id,
        scope: identity.memberIdentity,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      portal.summary({
        userId: ownScope.userId,
        productId: identity.targetProduct.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps exact multi-currency balances separate across requested processing completed and rejected payouts", async () => {
    const fixture = await createProductScopeFixture();
    const participantId = `rf-balance-owner-${randomUUID()}`;
    const otherParticipantId = `rf-balance-other-${randomUUID()}`;
    const programId = `rf-balance-program-${randomUUID()}`;
    await db.insert(schema.program).values({
      id: programId,
      productId: fixture.targetProduct.id,
      name: "Grouped balance regression",
      status: "active",
      programTemplateId: "single-sided",
    });
    await db.insert(schema.participant).values([
      {
        id: participantId,
        productId: fixture.targetProduct.id,
        externalId: participantId,
      },
      {
        id: otherParticipantId,
        productId: fixture.targetProduct.id,
        externalId: otherParticipantId,
      },
    ]);
    const staff = await caller(payoutsRouter, fixture.ownerHeaders);
    await staff.verifyOwnership({
      productId: fixture.targetProduct.id,
      participantId,
      ownerUserId: fixture.identity.userId,
      evidence: `grouped-balance-ownership-${randomUUID()}`,
      externalOwnershipVerified: true,
    });
    await db.insert(schema.reward).values([
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "123.45",
        currency: "USD",
        status: "approved",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "0.55",
        currency: "USD",
        status: "approved",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "20.01",
        currency: "EUR",
        status: "approved",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "9.99",
        currency: "RUB",
        status: "approved",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "0.01",
        currency: "GBP",
        status: "approved",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "700.00",
        currency: "USD",
        status: "pending_disbursal",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "800.00",
        currency: "USD",
        status: "rejected",
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "900.00",
        currency: "USD",
        status: "disbursed",
        disbursedAt: new Date(),
      },
      {
        participantId,
        programId,
        rewardType: "cash",
        amount: "950.00",
        currency: "USD",
        status: "approved",
        disbursedAt: new Date(),
      },
      {
        participantId,
        programId,
        rewardType: "discount",
        amount: "600.00",
        currency: "USD",
        status: "approved",
      },
      {
        participantId: otherParticipantId,
        programId,
        rewardType: "cash",
        amount: "500.00",
        currency: "USD",
        status: "approved",
      },
    ]);
    const portal = await caller(participantPortalRouter, fixture.ownerHeaders);
    const scope = {
      userId: fixture.identity.userId,
      productId: fixture.targetProduct.id,
    };
    const request = (
      currency: "USD" | "EUR" | "GBP" | "RUB",
      amountMinor: number,
    ) =>
      portal.requestPayout({
        recipient: {
          name: "Fixture recipient",
          details: "Synthetic transfer account",
        },
        ...scope,
        currency,
        amountMinor,
        idempotencyKey: `multi-currency-${randomUUID()}`,
      });
    await request("USD", 60);
    const processing = await request("EUR", 50);
    await staff.claim({ productId: scope.productId, payoutId: processing.id });
    const completed = await request("RUB", 40);
    await staff.claim({ productId: scope.productId, payoutId: completed.id });
    await staff.confirmPaid({
      productId: scope.productId,
      payoutId: completed.id,
      currency: "RUB",
      amountMinor: 40,
      externalReference: `multi-currency-transfer-${randomUUID()}`,
      completedAt: new Date().toISOString(),
      idempotencyKey: `multi-currency-confirm-${randomUUID()}`,
      paymentAndNoRefundVerified: true,
    });
    const rejected = await request("GBP", 1);
    await staff.reject({
      productId: scope.productId,
      payoutId: rejected.id,
      reason: "Cancelled before execution",
      transferNotExecutedVerified: false,
    });
    const summary = await portal.summary(scope);
    expect(
      [...summary.balances].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    ).toEqual([
      {
        currency: "EUR",
        eligibleMinor: 2001,
        reservedMinor: 50,
        completedMinor: 0,
        availableMinor: 1951,
      },
      {
        currency: "GBP",
        eligibleMinor: 1,
        reservedMinor: 0,
        completedMinor: 0,
        availableMinor: 1,
      },
      {
        currency: "RUB",
        eligibleMinor: 999,
        reservedMinor: 0,
        completedMinor: 40,
        availableMinor: 959,
      },
      {
        currency: "USD",
        eligibleMinor: 12400,
        reservedMinor: 60,
        completedMinor: 0,
        availableMinor: 12340,
      },
    ]);
    await expect(request("GBP", 2)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await portal.summary(scope)).balances.find(
        (balance) => balance.currency === "GBP",
      )!,
    ).toMatchObject({ eligibleMinor: 1, reservedMinor: 0, availableMinor: 1 });
  });
});

describe("native explicit product scope acceptance", () => {
  it.each(["single-sided", "double-sided"] as const)(
    "completes the %s lifecycle on a non-first owned product with its own brand and template uniqueness",
    async (templateId) => {
      const fixture = await createProductScopeFixture();
      const program = await caller(programRouter, fixture.ownerHeaders);
      const legacy = await program.create({
        productId: fixture.legacyProduct.id,
        name: "Legacy product template",
        templateId,
      });
      const created = await program.create({
        productId: fixture.targetProduct.id,
        name: "Selected product template",
        templateId,
      });
      expect(legacy.productId).toBe(fixture.legacyProduct.id);
      expect(created.productId).toBe(fixture.targetProduct.id);
      await expect(
        program.create({
          productId: fixture.targetProduct.id,
          name: "Duplicate template",
          templateId,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        program.create({
          name: "Missing product",
          templateId,
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        program.create({
          productId: fixture.foreignProduct.id,
          name: "Foreign template",
          templateId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const members = await db
        .select()
        .from(schema.programUser)
        .where(eq(schema.programUser.programId, created.id));
      expect(members.map(({ userId, role }) => ({ userId, role }))).toEqual(
        expect.arrayContaining([
          { userId: fixture.identity.userId, role: "owner" },
          { userId: fixture.memberIdentity.userId, role: "member" },
        ]),
      );
      expect(members).toHaveLength(2);
      const terms: RewardConfigType = {
        firstPaidOnly: true,
        referrer: {
          type: "cash",
          valueType: "percentage",
          value: 25,
          currency: "RUB",
          basis: "payable_amount",
        },
        ...(templateId === "double-sided"
          ? { referee: initialTerms.referee }
          : {}),
      };
      const save = () =>
        program.saveTemplateConfiguration({
          id: created.id,
          templateConfig: { rewardConfig: terms },
          brandConfig: {
            primaryColor: "#123456",
            landingPageUrl: fixture.targetProduct.url!,
          },
        });
      await save();
      const input = { id: created.id, scope: fixture.identity };
      const configured = await program.getById(input);
      expect(configured.config).toMatchObject({
        rewardConfig: terms,
        widgetConfig: {
          productName: fixture.targetProduct.name,
          logoUrl: fixture.targetProduct.logo,
          cssVariables: { "--widget-primary": "#123456" },
          enabledPlatforms: { linkedin: true, facebook: false },
        },
      });
      expect(configured.config!.widgetConfig!.shareMessage).toContain(
        fixture.targetProduct.name,
      );
      expect(configured.config!.widgetConfig!.shareMessage).not.toContain(
        fixture.legacyProduct.name,
      );
      expect(configured.config!.rewardConfig!.referee).toEqual(
        templateId === "double-sided" ? initialTerms.referee : undefined,
      );
      const rules = await caller(rewardRulesRouter, fixture.ownerHeaders);
      const before = await rules.getByProgram({
        programId: created.id,
        scope: fixture.identity,
      });
      expect(before).toHaveLength(1);
      expect(before[0]!.config).toMatchObject({
        conditions: { firstPaidOnly: true },
        reward: { type: "cash", unit: "percent", amount: 25, currency: "RUB" },
      });
      const approve = (rewardConfig: RewardConfigType) =>
        program.approveServerTracking({
          productId: fixture.targetProduct.id,
          programId: created.id,
          termsFingerprint: referralTermsFingerprint(rewardConfig),
          reviewedPeriod: { startDate: null, endDate: null },
          calculationVersion: 1,
          edgeExamplesApproved: true,
          ownershipPolicyVerified: true,
        });
      await approve(terms);
      const approved = await program.getById(input);
      await save();
      const unchanged = await program.getById(input);
      expect(unchanged.status).toBe("active");
      expect(unchanged.config!.serverTracking).toEqual(
        approved.config!.serverTracking,
      );
      expect(
        (
          await rules.getByProgram({
            programId: created.id,
            scope: fixture.identity,
          })
        ).map((rule) => rule.id),
      ).toEqual(before.map((rule) => rule.id));
      await program.updateName({
        id: created.id,
        name: "Renamed selected program",
      });
      await program.updateConfig({
        id: created.id,
        config: {
          ...unchanged.config!,
          widgetConfig: {
            ...unchanged.config!.widgetConfig!,
            subtitle: "Selected product design edit",
          },
        },
      });
      const edited = await program.getById(input);
      expect(edited).toMatchObject({
        name: "Renamed selected program",
        config: {
          widgetConfig: {
            subtitle: "Selected product design edit",
            productName: fixture.targetProduct.name,
          },
        },
      });
      expect(await program.getSetupProgress(input)).toMatchObject({
        isComplete: false,
        steps: expect.arrayContaining([
          {
            id: "installation",
            title: expect.any(String),
            description: expect.any(String),
            isRequired: true,
            isComplete: false,
            docLink: expect.any(String),
          },
        ]),
      });
      const changed: RewardConfigType = {
        ...terms,
        referrer: { ...terms.referrer!, value: 30 },
      };
      await program.saveTemplateConfiguration({
        id: created.id,
        templateConfig: { rewardConfig: changed },
      });
      const pending = await program.getById(input);
      expect(pending.status).toBe("pending_approval");
      expect(pending.config!.serverTracking).toBeUndefined();
      expect(pending.config!.widgetConfig).toMatchObject({
        productName: fixture.targetProduct.name,
        logoUrl: fixture.targetProduct.logo,
      });
      const changedRules = await rules.getByProgram({
        programId: created.id,
        scope: fixture.identity,
      });
      expect(
        changedRules.find((rule) => rule.id === before[0]!.id)?.isActive,
      ).toBe(false);
      expect(changedRules.filter((rule) => rule.isActive)).toMatchObject([
        {
          config: { reward: { amount: 30, unit: "percent", currency: "RUB" } },
        },
      ]);
      await approve(changed);
      const reapproved = await program.getById(input);
      expect(reapproved).toMatchObject({
        status: "active",
        config: {
          serverTracking: {
            approvedBy: fixture.identity.userId,
            termsFingerprint: referralTermsFingerprint(changed),
          },
        },
      });
      await expect(
        program.updateConfig({
          id: created.id,
          config: { ...reapproved.config!, rewardConfig: terms },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const definition = await db.query.eventDefinition.findFirst({
        where: eq(schema.eventDefinition.type, "signup"),
      });
      const [history] = await db
        .insert(schema.event)
        .values({
          productId: fixture.targetProduct.id,
          programId: created.id,
          eventDefinitionId: definition!.id,
          metadata: { schemaVersion: 1 },
        })
        .returning();
      await program.delete({ id: created.id });
      expect((await program.getById(input)).status).toBe("archived");
      expect(
        await db.query.event.findFirst({
          where: eq(schema.event.id, history!.id),
        }),
      ).toMatchObject({ id: history!.id, programId: created.id });
      expect(
        (await program.getById({ id: legacy.id, scope: fixture.identity }))
          .productId,
      ).toBe(fixture.legacyProduct.id);
    },
  );

  describe("scoped native list and record boundaries", () => {
    let fixture: ScopedReadFixture;
    beforeAll(async () => {
      fixture = await createScopedReadFixture();
    });

    it("returns only selected-product program, Activity and reward rows and matching counts for ordinary members", async () => {
      const program = await caller(programRouter, fixture.memberHeaders);
      const programs = await program.getAll({ scope: fixture.memberScope });
      expect(programs.map((row) => row.id).sort()).toEqual(
        [fixture.programs.alpha, fixture.programs.beta].sort(),
      );
      for (const row of programs)
        expect(row).toMatchObject({
          productId: fixture.targetProduct.id,
          participantCount: 3,
          referralCount: 2,
        });
      const legacy = await program.getAll();
      expect(legacy.map((row) => row.id)).toEqual([fixture.programs.legacy]);
      expect(legacy[0]).toMatchObject({
        participantCount: 1,
        referralCount: 1,
      });
      const events = await (
        await caller(eventsRouter, fixture.memberHeaders)
      ).getAll({
        scope: fixture.memberScope,
        page: 1,
        pageSize: 100,
      });
      expect(Number(events.total)).toBe(4);
      expect(events.data.map((row) => row.id).sort()).toEqual(
        [
          fixture.events.a,
          fixture.events.b,
          fixture.events.c,
          fixture.events.d,
        ].sort(),
      );
      expect(
        events.data.every((row) => row.productId === fixture.targetProduct.id),
      ).toBe(true);
      const rewards = await (
        await caller(rewardsRouter, fixture.memberHeaders)
      ).getAll({
        scope: fixture.memberScope,
        page: 2,
        pageSize: 3,
        sort: { field: "amount", direction: "asc" },
      });
      expect(Number(rewards.total)).toBe(7);
      expect(rewards.data.map((row) => row.amount)).toEqual([
        "8.00",
        "16.00",
        "32.00",
      ]);
      expect(
        rewards.data.every((row) => row.productId === fixture.targetProduct.id),
      ).toBe(true);
      const filtered = await (
        await caller(rewardsRouter, fixture.memberHeaders)
      ).getAll({
        scope: fixture.memberScope,
        page: 1,
        pageSize: 100,
        filters: [
          { id: "currency", value: "RUB", variant: "text", operator: "eq" },
          { id: "rewardType", value: "cash", variant: "text", operator: "eq" },
          { id: "status", value: "approved", variant: "text", operator: "eq" },
        ],
        sort: { field: "amount", direction: "desc" },
      });
      expect(Number(filtered.total)).toBe(2);
      expect(filtered.data.map((row) => row.amount)).toEqual(["2.00", "1.00"]);
    });

    it("rejects absent, malformed and forged list scopes without falling back except for absent legacy program input", async () => {
      const program = await caller(programRouter, fixture.ownerHeaders);
      const events = await caller(eventsRouter, fixture.ownerHeaders);
      const rewards = await caller(rewardsRouter, fixture.ownerHeaders);
      const queries = [
        (scope: unknown) => program.getAll({ scope } as never),
        (scope: unknown) =>
          events.getAll({ scope, page: 1, pageSize: 10 } as never),
        (scope: unknown) =>
          rewards.getAll({ scope, page: 1, pageSize: 10 } as never),
      ];
      for (const query of queries) {
        for (const scope of [
          undefined,
          null,
          {},
          fixture.identity,
          {
            organizationId: fixture.identity.organizationId,
            productId: fixture.targetProduct.id,
          },
          { ...fixture.scope, unexpected: true },
        ])
          await expect(query(scope)).rejects.toMatchObject({
            code: "BAD_REQUEST",
          });
        for (const scope of [
          { ...fixture.scope, userId: fixture.memberIdentity.userId },
          { ...fixture.scope, organizationId: fixture.foreignOrganizationId },
          { ...fixture.scope, productId: fixture.foreignProduct.id },
          {
            ...fixture.scope,
            productId: `missing-product-${fixture.fixtureId}`,
          },
        ])
          await expect(query(scope)).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
      }
      for (const input of [
        null,
        {},
        { scope: fixture.scope, unexpected: true },
      ])
        await expect(program.getAll(input as never)).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
      expect((await program.getAll()).map((row) => row.id)).toEqual([
        fixture.programs.legacy,
      ]);
      for (const query of [
        (page: number, pageSize: number) =>
          events.getAll({ scope: fixture.scope, page, pageSize }),
        (page: number, pageSize: number) =>
          rewards.getAll({ scope: fixture.scope, page, pageSize }),
      ])
        for (const [page, pageSize] of [
          [0, 10],
          [1.5, 10],
          [1, 0],
          [1, 1.5],
          [1, 101],
        ] as const)
          await expect(query(page, pageSize)).rejects.toMatchObject({
            code: "BAD_REQUEST",
          });
    });

    it("reads the actual non-first-product code profile under verified identity and rejects missing, forged or foreign scope", async () => {
      const participants = await caller(
        participantsRouter,
        fixture.memberHeaders,
      );
      const [code] = await db
        .insert(schema.refcode)
        .values({
          participantId: fixture.participants.referrer,
          productId: fixture.targetProduct.id,
          programId: fixture.programs.alpha,
          code: randomBytes(6).toString("hex"),
        })
        .returning();
      expect(
        await participants.getById({
          id: fixture.participants.referrer,
          scope: fixture.memberIdentity,
        }),
      ).toMatchObject({
        id: fixture.participants.referrer,
        productId: fixture.targetProduct.id,
        refcode: { id: code!.id, code: code!.code, isActive: true },
      });
      for (const scope of [undefined, null])
        await expect(
          participants.getById({
            id: fixture.participants.referrer,
            scope,
          } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      for (const scope of [
        fixture.identity,
        {
          ...fixture.memberIdentity,
          organizationId: fixture.foreignOrganizationId,
        },
      ])
        await expect(
          participants.getById({ id: fixture.participants.referrer, scope }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        participants.getById({
          id: fixture.participants.foreign,
          scope: fixture.memberIdentity,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("reads identified non-first programs, setup, rules and admin secrets with clean identity scope and rejects member and foreign authority", async () => {
      const program = await caller(programRouter, fixture.ownerHeaders);
      const rules = await caller(rewardRulesRouter, fixture.ownerHeaders);
      const secrets = await caller(productSecretsRouter, fixture.ownerHeaders);
      expect(
        await program.getById({
          id: fixture.programs.alpha,
          scope: fixture.identity,
        }),
      ).toMatchObject({
        id: fixture.programs.alpha,
        productId: fixture.targetProduct.id,
      });
      expect(
        await program.getSetupProgress({
          id: fixture.programs.alpha,
          scope: fixture.identity,
        }),
      ).toMatchObject({ isComplete: false, steps: expect.any(Array) });
      expect(
        await rules.getByProgram({
          programId: fixture.programs.alpha,
          scope: fixture.identity,
        }),
      ).toMatchObject([
        { id: fixture.rule.id, programId: fixture.programs.alpha },
      ]);
      expect(
        await secrets.get({
          productId: fixture.targetProduct.id,
          scope: fixture.identity,
        }),
      ).toEqual({
        clientId: `client-${fixture.targetProduct.id}`,
        clientSecret: `synthetic-secret-${fixture.targetProduct.id}`,
      });
      const memberProgram = await caller(programRouter, fixture.memberHeaders);
      expect(
        await memberProgram.getById({
          id: fixture.programs.alpha,
          scope: fixture.memberIdentity,
        }),
      ).toMatchObject({ id: fixture.programs.alpha });
      expect(
        await memberProgram.getSetupProgress({
          id: fixture.programs.alpha,
          scope: fixture.memberIdentity,
        }),
      ).toMatchObject({ isComplete: false });
      expect(
        await (
          await caller(rewardRulesRouter, fixture.memberHeaders)
        ).getByProgram({
          programId: fixture.programs.alpha,
          scope: fixture.memberIdentity,
        }),
      ).toHaveLength(1);
      const reads = [
        {
          id: fixture.programs.alpha,
          foreignId: fixture.programs.foreign,
          key: "id",
          read: (input: unknown) => program.getById(input as never),
        },
        {
          id: fixture.programs.alpha,
          foreignId: fixture.programs.foreign,
          key: "id",
          read: (input: unknown) => program.getSetupProgress(input as never),
        },
        {
          id: fixture.programs.alpha,
          foreignId: fixture.programs.foreign,
          key: "programId",
          read: (input: unknown) => rules.getByProgram(input as never),
        },
        {
          id: fixture.targetProduct.id,
          foreignId: fixture.foreignProduct.id,
          key: "productId",
          read: (input: unknown) => secrets.get(input as never),
        },
      ];
      for (const { id, foreignId, key, read } of reads) {
        for (const input of [
          id,
          { [key]: id },
          { [key]: id, scope: null },
          {
            [key]: id,
            scope: { organizationId: fixture.identity.organizationId },
          },
          {
            [key]: id,
            scope: { ...fixture.identity, productId: fixture.targetProduct.id },
          },
          { [key]: id, scope: fixture.identity, unexpected: true },
        ])
          await expect(read(input)).rejects.toMatchObject({
            code: "BAD_REQUEST",
          });
        for (const input of [
          { [key]: foreignId, scope: fixture.identity },
          { [key]: id, scope: fixture.memberIdentity },
          {
            [key]: id,
            scope: {
              ...fixture.identity,
              organizationId: fixture.foreignOrganizationId,
            },
          },
        ])
          await expect(read(input)).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
      }
      const product = await caller(productRouter, fixture.memberHeaders);
      expect(
        (await product.getAll(fixture.memberIdentity))
          .map((row) => row.id)
          .sort(),
      ).toEqual([fixture.targetProduct.id, fixture.legacyProduct.id].sort());
      await expect(product.getAll(fixture.identity)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        (await caller(productSecretsRouter, fixture.memberHeaders)).get({
          productId: fixture.targetProduct.id,
          scope: fixture.memberIdentity,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        memberProgram.saveTemplateConfiguration({
          id: fixture.programs.alpha,
          templateConfig: { rewardConfig: initialTerms },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        memberProgram.approveServerTracking({
          productId: fixture.targetProduct.id,
          programId: fixture.programs.alpha,
          termsFingerprint: referralTermsFingerprint(initialTerms),
          reviewedPeriod: { startDate: null, endDate: null },
          calculationVersion: 1,
          edgeExamplesApproved: true,
          ownershipPolicyVerified: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        memberProgram.delete({ id: fixture.programs.alpha }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const memberRewards = await caller(rewardsRouter, fixture.memberHeaders);
      await expect(
        memberRewards.updateApprovalStatus({
          productId: fixture.targetProduct.id,
          rewardId: fixture.rewards[0]!.id,
          status: "approved",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        memberRewards.markAsDisbursed({
          productId: fixture.targetProduct.id,
          rewardId: fixture.rewards[0]!.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        (await caller(payoutsRouter, fixture.memberHeaders)).list(
          fixture.memberScope,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const mutation of [
        () =>
          program.saveTemplateConfiguration({
            id: fixture.programs.foreign,
            templateConfig: { rewardConfig: initialTerms },
          }),
        () =>
          program.updateName({
            id: fixture.programs.foreign,
            name: "Foreign rename",
          }),
        () =>
          program.updateConfig({
            id: fixture.programs.foreign,
            config: { schemaVersion: 1, widgetConfig: defaultWidgetConfig },
          }),
        () => program.delete({ id: fixture.programs.foreign }),
      ])
        await expect(mutation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await db.query.program.findFirst({
          where: eq(schema.program.id, fixture.programs.foreign),
        }),
      ).toMatchObject({
        name: "Scope Foreign",
        status: "active",
        config: null,
      });
    });

    it("applies real Activity event-name and existing filters, sorting and stable tied pagination within the selected product", async () => {
      const events = await caller(eventsRouter, fixture.ownerHeaders);
      const get = (
        filters: {
          id: string;
          value: string;
          variant: string;
          operator: string;
        }[],
      ) =>
        events.getAll({
          scope: fixture.scope,
          page: 1,
          pageSize: 100,
          filters,
        });
      for (const [id, value, expected] of [
        [
          "eventName",
          "pUrChAsE",
          [fixture.events.a, fixture.events.b, fixture.events.d],
        ],
        ["eventName", "no-matching-event-name", []],
        [
          "eventType",
          "purchase",
          [fixture.events.a, fixture.events.b, fixture.events.d],
        ],
        ["status", "processed", [fixture.events.b]],
        ["participantEmail", `bob-${fixture.fixtureId}`, [fixture.events.c]],
        ["programName", "bEtA", [fixture.events.c]],
        [
          "referralId",
          fixture.referrals.alpha,
          [fixture.events.a, fixture.events.b, fixture.events.d],
        ],
      ] as const) {
        const result = await get([
          { id, value, variant: "text", operator: "eq" },
        ]);
        expect(Number(result.total)).toBe(expected.length);
        expect(result.data.map((row) => row.id).sort()).toEqual(
          [...expected].sort(),
        );
      }
      const combined = await get([
        { id: "eventName", value: "Purchase", variant: "text", operator: "eq" },
        { id: "status", value: "pending", variant: "text", operator: "eq" },
        {
          id: "participantEmail",
          value: `alice-${fixture.fixtureId}`,
          variant: "text",
          operator: "eq",
        },
        { id: "programName", value: "Alpha", variant: "text", operator: "eq" },
        {
          id: "referralId",
          value: fixture.referrals.alpha,
          variant: "text",
          operator: "eq",
        },
      ]);
      expect(Number(combined.total)).toBe(2);
      expect(combined.data.map((row) => row.id).sort()).toEqual([
        fixture.events.a,
        fixture.events.d,
      ]);
      for (const [direction, expected] of [
        [
          "asc",
          [
            fixture.events.b,
            fixture.events.a,
            fixture.events.d,
            fixture.events.c,
          ],
        ],
        [
          "desc",
          [
            fixture.events.c,
            fixture.events.a,
            fixture.events.d,
            fixture.events.b,
          ],
        ],
      ] as const) {
        const rows: string[] = [];
        for (const page of [1, 2, 3, 4]) {
          const result = await events.getAll({
            scope: fixture.scope,
            page,
            pageSize: 1,
            sort: { field: "createdAt", direction },
          });
          expect(Number(result.total)).toBe(4);
          expect(result.data).toHaveLength(1);
          rows.push(result.data[0]!.id);
        }
        expect(rows).toEqual(expected);
      }
      const byType = await events.getAll({
        scope: fixture.scope,
        page: 1,
        pageSize: 100,
        sort: { field: "eventType", direction: "asc" },
      });
      expect(byType.data.map((row) => row.id)).toEqual([
        fixture.events.a,
        fixture.events.b,
        fixture.events.d,
        fixture.events.c,
      ]);
      const byStatus = await events.getAll({
        scope: fixture.scope,
        page: 1,
        pageSize: 100,
        sort: { field: "status", direction: "desc" },
      });
      expect(byStatus.data.map((row) => row.id)).toEqual([
        fixture.events.b,
        fixture.events.a,
        fixture.events.c,
        fixture.events.d,
      ]);
      const pastEnd = await events.getAll({
        scope: fixture.scope,
        page: 5,
        pageSize: 1,
      });
      expect(Number(pastEnd.total)).toBe(4);
      expect(pastEnd.data).toEqual([]);
    });

    it("groups non-first-program R3 statistics by currency, reward type and status without foreign or other-program totals", async () => {
      const rewards = await caller(rewardsRouter, fixture.memberHeaders);
      const result = await rewards.getStatsByProgram(fixture.programs.alpha);
      expect(result.summary).toEqual({ totalRewards: 6 });
      expect(result.groups).toHaveLength(5);
      expect(result.groups).toEqual(
        expect.arrayContaining([
          {
            currency: "RUB",
            type: "cash",
            status: "approved",
            count: 2,
            amount: "3.00",
          },
          {
            currency: "USD",
            type: "cash",
            status: "approved",
            count: 1,
            amount: "4.00",
          },
          {
            currency: "RUB",
            type: "cash",
            status: "pending_disbursal",
            count: 1,
            amount: "8.00",
          },
          {
            currency: "RUB",
            type: "discount",
            status: "approved",
            count: 1,
            amount: "16.00",
          },
          {
            currency: "RUB",
            type: "cash",
            status: "disbursed",
            count: 1,
            amount: "32.00",
          },
        ]),
      );
      await expect(
        rewards.getStatsByProgram(fixture.programs.foreign),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("allows admin V1 status changes on a non-first product but refuses member, foreign and accepted V2 rewrites", async () => {
    const fixture = await createScopedReadFixture();
    const events = await caller(eventsRouter, fixture.ownerHeaders);
    const member = await caller(eventsRouter, fixture.memberHeaders);
    await expect(
      member.updateStatus({ eventId: fixture.events.d, status: "failed" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await events.updateStatus({
        eventId: fixture.events.d,
        status: "failed",
      }),
    ).toMatchObject({
      id: fixture.events.d,
      productId: fixture.targetProduct.id,
      status: "failed",
      metadata: { schemaVersion: 1, orderAmount: 1, orderId: fixture.events.d },
    });
    await expect(
      events.updateStatus({
        eventId: fixture.events.foreign,
        status: "processed",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [refcode] = await db
      .insert(schema.refcode)
      .values({
        productId: fixture.targetProduct.id,
        programId: fixture.programs.alpha,
        participantId: fixture.participants.referrer,
        code: randomUUID().replaceAll("-", "").slice(0, 7),
      })
      .returning();
    const [referral] = await db
      .insert(schema.referral)
      .values({
        productId: fixture.targetProduct.id,
        programId: fixture.programs.alpha,
        referrerId: fixture.participants.referrer,
        externalId: fixture.participants.alice,
        refcodeId: refcode!.id,
        appliedCode: refcode!.code,
      })
      .returning();
    const frozen: ReferralSnapshotV1 = {
      schemaVersion: 1,
      calculationVersion: 1,
      acceptedAt: "2024-01-01T00:00:00Z",
      offerVersion: "a".repeat(64),
      firstPaidOnly: false,
      attribution: {
        productId: fixture.targetProduct.id,
        programId: fixture.programs.alpha,
        codeId: refcode!.id,
        codeValue: refcode!.code,
        referrerParticipantId: fixture.participants.referrer,
      },
      pricing: {
        planCode: "scope-fixture",
        priceVersion: "fixture-v1",
        currency: "RUB",
        baseAmountMinor: 100,
        discountAmountMinor: 0,
        payableAmountMinor: 100,
        buyerDiscountApplicable: false,
        buyerDiscountReason: null,
      },
      buyerDiscount: { kind: "none" },
      commission: {
        basis: "payable_amount",
        rules: [
          {
            ruleId: fixture.rule.id,
            priority: 0,
            config: {
              schemaVersion: 1,
              trigger: { event: "purchase" },
              participantType: "referrer",
              reward: {
                type: "cash",
                amount: 1,
                unit: "fixed",
                currency: "RUB",
              },
            },
          },
        ],
      },
    };
    const definition = await db.query.eventDefinition.findFirst({
      where: eq(schema.eventDefinition.type, "purchase"),
    });
    const orderId = `rf-v2-order-${fixture.fixtureId}`;
    const [accepted] = await db
      .insert(schema.event)
      .values({
        productId: fixture.targetProduct.id,
        programId: fixture.programs.alpha,
        participantId: fixture.participants.alice,
        referralId: referral!.id,
        eventDefinitionId: definition!.id,
        businessKey: orderId,
        occurredAt: new Date("2024-01-01T00:00:00Z"),
        status: "processed",
        metadata: {
          schemaVersion: 2,
          source: "api",
          orderId,
          orderAmountMinor: 100,
          currency: "RUB",
          referralSnapshot: frozen,
        },
      })
      .returning();
    for (const status of ["pending", "failed", "processed"] as const)
      await expect(
        events.updateStatus({ eventId: accepted!.id, status }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db.query.event.findFirst({
        where: eq(schema.event.id, accepted!.id),
      }),
    ).toEqual(accepted);
  });
});

describe("native RefRef-only referrer enrollment", () => {
  const personId = `rf-person-${randomUUID()}`;
  const otherPersonId = `rf-person-${randomUUID()}`;
  const unverifiedId = `rf-unverified-${randomUUID()}`;
  const serviceId = `rf-service-${randomUUID()}`;
  const foreignProgramId = `rf-foreign-program-${randomUUID()}`;
  const email = `${randomUUID()}@example.test`;
  const proof = {
    ownerUserId: personId,
    evidence: `independent-ownership-check-${randomUUID()}`,
    externalOwnershipVerified: true as const,
  };
  let fixture: { programId: string; apiKey: string };
  let personHeaders: Headers;

  beforeAll(async () => {
    await db.insert(schema.user).values([
      { id: personId, name: "RefRef-only person", email, emailVerified: true },
      {
        id: otherPersonId,
        name: "Other person",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
      },
      {
        id: unverifiedId,
        name: "Unverified person",
        email: `${randomUUID()}@example.test`,
        emailVerified: false,
      },
      {
        id: serviceId,
        name: "Service identity",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        role: "service",
      },
    ]);
    await db.insert(schema.account).values({
      userId: personId,
      accountId: personId,
      providerId: "credential",
      password: await hashPassword("Test-first-payment-password-123!"),
    });
    personHeaders = await signIn(email);
    fixture = await createFinancialFixture();
    await db.insert(schema.program).values({
      id: foreignProgramId,
      productId: ids.foreignProduct,
      name: "Foreign enrollment program",
      status: "active",
      programTemplateId: "single-sided",
    });
  });

  it("enrolls once without org/backend membership or disclosure of the global account profile", async () => {
    const admin = await caller(payoutsRouter);
    const input = {
      ...proof,
      productId: ids.product,
      programId: fixture.programId,
    };
    const [first, concurrent] = await Promise.all([
      admin.enrollReferrer(input),
      admin.enrollReferrer(input),
    ]);
    expect(concurrent).toEqual(first);
    const participants = await db
      .select()
      .from(schema.participant)
      .where(
        and(
          eq(schema.participant.productId, ids.product),
          eq(schema.participant.ownerUserId, personId),
        ),
      );
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      id: first.participantId,
      externalId: personId,
      name: null,
      email: null,
      ownershipVerifiedBy: ids.admin,
      ownershipEvidence: proof.evidence,
      payoutRecipient: null,
    });
    expect(
      await db
        .select()
        .from(schema.orgUser)
        .where(eq(schema.orgUser.userId, personId)),
    ).toHaveLength(0);
    const codes = await db
      .select()
      .from(schema.refcode)
      .where(
        and(
          eq(schema.refcode.participantId, first.participantId),
          eq(schema.refcode.programId, fixture.programId),
        ),
      );
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({
      id: first.codeId,
      code: first.code,
      productId: ids.product,
    });
    const portal = await caller(participantPortalRouter, personHeaders);
    expect(await portal.memberships({ userId: personId })).toEqual([
      { productId: ids.product, productName: expect.any(String) },
    ]);
    const summary = await portal.summary({
      userId: personId,
      productId: ids.product,
    });
    expect(summary.codes).toMatchObject([
      {
        codeId: first.codeId,
        code: first.code,
        programId: fixture.programId,
        programName: "Concurrent approved terms",
        programStatus: "active",
        isActive: true,
      },
    ]);
    expect(
      summary.balances.every((balance) => balance.availableMinor === 0),
    ).toBe(true);
    const resolution = await post(
      "/v1/referrals/resolve",
      {
        productId: ids.product,
        programId: fixture.programId,
        customerExternalId: randomUUID(),
        code: first.code,
      },
      fixture.apiKey,
    );
    expect(resolution.statusCode).toBe(200);
    expect(resolution.json()).toMatchObject({
      codeId: first.codeId,
      referrerParticipantId: first.participantId,
    });
    await expect(
      portal.summary({ userId: ids.admin, productId: ids.product }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      portal.summary({ userId: personId, productId: ids.foreignProduct }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("preserves existing ownership checks, prevents reassignment and reuses that person for another program", async () => {
    const admin = await caller(payoutsRouter);
    const enrolled = await admin.enrollReferrer({
      ...proof,
      productId: ids.product,
      programId: fixture.programId,
    });
    expect(
      await admin.verifyOwnership({
        ...proof,
        productId: ids.product,
        participantId: enrolled.participantId,
      }),
    ).toMatchObject({
      participantId: enrolled.participantId,
      verified: true,
    });
    await expect(
      admin.enrollReferrer({
        ...proof,
        evidence: `different-evidence-${randomUUID()}`,
        productId: ids.product,
        programId: fixture.programId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      admin.verifyOwnership({
        ...proof,
        productId: ids.product,
        participantId: enrolled.participantId,
        ownerUserId: otherPersonId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await createFinancialFixture();
    const secondEnrollment = await admin.enrollReferrer({
      ...proof,
      productId: ids.product,
      programId: second.programId,
    });
    expect(secondEnrollment.participantId).toBe(enrolled.participantId);
    expect(secondEnrollment.codeId).not.toBe(enrolled.codeId);
    await db
      .update(schema.refcode)
      .set({ isActive: false })
      .where(eq(schema.refcode.id, secondEnrollment.codeId));
    expect(
      await admin.enrollReferrer({
        ...proof,
        productId: ids.product,
        programId: second.programId,
      }),
    ).toMatchObject({ codeId: secondEnrollment.codeId });
    const summary = await (
      await caller(participantPortalRouter, personHeaders)
    ).summary({
      userId: personId,
      productId: ids.product,
    });
    expect(summary.codes.map((code) => code.programId).sort()).toEqual(
      [fixture.programId, second.programId].sort(),
    );
    expect(
      summary.codes.find((code) => code.codeId === secondEnrollment.codeId)
        ?.isActive,
    ).toBe(false);
  });

  it("rejects nonadmins, mixed scopes and unverified/service identities without enrollment writes", async () => {
    const admin = await caller(payoutsRouter);
    const input = {
      ...proof,
      productId: ids.product,
      programId: fixture.programId,
    };
    const [unlinked] = await db
      .insert(schema.participant)
      .values({
        productId: ids.product,
        externalId: otherPersonId,
        name: "Existing unlinked customer",
      })
      .returning();
    const before = await businessCounts(ids.product);
    for (const headers of [memberHeaders, outsiderHeaders, personHeaders]) {
      await expect(
        (await caller(payoutsRouter, headers)).enrollReferrer(input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    for (const ownerUserId of [
      unverifiedId,
      serviceId,
      `missing-${randomUUID()}`,
    ]) {
      await expect(
        admin.enrollReferrer({ ...input, ownerUserId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      admin.enrollReferrer({ ...input, productId: ids.foreignProduct }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      admin.enrollReferrer({ ...input, programId: foreignProgramId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      admin.enrollReferrer({ ...input, programId: `missing-${randomUUID()}` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      admin.enrollReferrer({ ...input, ownerUserId: otherPersonId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db.query.participant.findFirst({
        where: eq(schema.participant.id, unlinked!.id),
      }),
    ).toMatchObject({
      ownerUserId: null,
      name: "Existing unlinked customer",
    });
    expect(await businessCounts(ids.product)).toEqual(before);
    expect(
      await db
        .select()
        .from(schema.participant)
        .where(eq(schema.participant.ownerUserId, otherPersonId)),
    ).toHaveLength(0);
  });
});

describe("current administrator eligibility", () => {
  it.each([{ banned: true }, { emailVerified: false }, { role: "service" }])(
    "rejects an existing session after the administrator becomes ineligible: %j",
    async (change) => {
      const fixture = await createFinancialFixture();
      const admin = await caller(programRouter);
      const settings = await admin.partnerRules({
        id: fixture.programId,
        scope: adminIdentity,
      });
      const input = {
        productId: ids.product,
        programId: fixture.programId,
        enabled: false,
      };
      const [before] = await db
        .select()
        .from(schema.program)
        .where(eq(schema.program.id, fixture.programId));
      await db
        .update(schema.user)
        .set(change)
        .where(eq(schema.user.id, ids.admin));
      try {
        await expect(admin.setPartnerSelfService(input)).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await expect(
          admin.getById({ id: fixture.programId, scope: adminIdentity }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
          admin.publishPartnerRules({
            productId: ids.product,
            programId: fixture.programId,
            body: "Reviewed independent programme rules. Only eligible confirmed first purchases earn rewards. Recipients supply their own truthful transfer details. Approved available earnings can be requested in RefRef and are paid manually under the published conditions.",
            termsFingerprint: settings.termsFingerprint!,
            confirmReviewedRules: true,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const [after] = await db
          .select()
          .from(schema.program)
          .where(eq(schema.program.id, fixture.programId));
        expect(after).toEqual(before);
      } finally {
        await db
          .update(schema.user)
          .set({ banned: false, emailVerified: true, role: "user" })
          .where(eq(schema.user.id, ids.admin));
      }
    },
  );
});

it("self-enrolls an independent native session and rejects forged owner, product and code scopes", async () => {
  const fixture = await createFinancialFixture();
  const admin = await caller(programRouter);
  const settings = await admin.partnerRules({
    id: fixture.programId,
    scope: adminIdentity,
  });
  const body =
    "Independent programme rules for suitable self-employed professionals and businesses. Only qualifying confirmed purchases generate pending commission; approved available balances may be withdrawn. Recipients supply their own truthful details; transfers are completed manually under these published conditions.";
  const published = await admin.publishPartnerRules({
    productId: ids.product,
    programId: fixture.programId,
    body,
    termsFingerprint: settings.termsFingerprint!,
    confirmReviewedRules: true,
  });
  await admin.setPartnerSelfService({
    productId: ids.product,
    programId: fixture.programId,
    enabled: true,
  });
  const person = randomUUID();
  const email = `${person}@example.test`;
  await db.insert(schema.user).values({
    id: person,
    name: "Independent native session",
    email,
    emailVerified: true,
  });
  await db.insert(schema.account).values({
    userId: person,
    accountId: person,
    providerId: "credential",
    password: await hashPassword("Test-first-payment-password-123!"),
  });
  const portal = await caller(participantPortalRouter, await signIn(email));
  const scope = { userId: person, programId: fixture.programId };
  const displayed = await portal.participation(scope);
  expect(displayed).toMatchObject({
    state: "join",
    rules: {
      id: published.id,
      body,
      commission: settings.economics!.commission,
    },
  });
  await expect(
    portal.participation({ ...scope, userId: ids.admin }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    (await caller(participantPortalRouter, new Headers())).participation(scope),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const chosen = `PARTNER${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const input = {
    ...scope,
    code: ` ${chosen} `,
    termsId: published.id,
    acceptRules: true as const,
  };
  const [joined, retry] = await Promise.all([
    portal.join(input),
    portal.join(input),
  ]);
  expect(retry).toEqual(joined);
  expect(joined.code).toBe(chosen.toLowerCase());
  const summary = await portal.summary({
    userId: person,
    productId: ids.product,
  });
  expect(summary.recipient).toBeNull();
  expect(summary.codes.map((code) => code.codeId)).toEqual([joined.codeId]);
  expect(summary.acceptedRules).toMatchObject([
    { programId: fixture.programId, termsId: published.id },
  ]);
  expect(
    await db
      .select()
      .from(schema.orgUser)
      .where(eq(schema.orgUser.userId, person)),
  ).toEqual([]);
  await expect(
    portal.codeStats({
      userId: person,
      productId: ids.foreignProduct,
      from: new Date(Date.now() - 86400000),
      to: new Date(),
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const [foreign] = await db
    .select()
    .from(schema.refcode)
    .where(eq(schema.refcode.code, fixture.code));
  await expect(
    portal.setCodeActive({
      userId: person,
      productId: ids.product,
      codeId: foreign!.id,
      isActive: false,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    (
      await db
        .select()
        .from(schema.refcode)
        .where(eq(schema.refcode.id, foreign!.id))
    )[0]!.isActive,
  ).toBe(true);
  await expect(
    (await caller(programRouter, memberHeaders)).publishPartnerRules({
      productId: ids.product,
      programId: fixture.programId,
      body,
      termsFingerprint: settings.termsFingerprint!,
      confirmReviewedRules: true,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    (await caller(programRouter, outsiderHeaders)).setPartnerSelfService({
      productId: ids.product,
      programId: fixture.programId,
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    db
      .update(schema.programTerms)
      .set({ body: `${body} Tampered.` })
      .where(eq(schema.programTerms.id, published.id)),
  ).rejects.toThrow();
  expect(
    (
      await db
        .select()
        .from(schema.programTerms)
        .where(eq(schema.programTerms.id, published.id))
    )[0]!.body,
  ).toBe(body);
  await expect(
    db
      .delete(schema.programAcceptance)
      .where(eq(schema.programAcceptance.termsId, published.id)),
  ).rejects.toThrow();
  expect(
    (await portal.summary({ userId: person, productId: ids.product }))
      .acceptedRules,
  ).toMatchObject([{ termsId: published.id }]);
});
