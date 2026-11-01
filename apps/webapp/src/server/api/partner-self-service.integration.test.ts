import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  ownParticipant,
  requestParticipantPayout,
  schema,
} from "@refref/coredb";
import * as core from "@refref/coredb";
import {
  defaultWidgetConfig,
  inputRefcodeSchema,
  createTemplateRuleSpecs,
  type RewardConfigType,
  type ReferralSnapshotV1,
  type CurrencyType,
} from "@refref/types";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to a dedicated test database");
}
const db = createDb(url);
const ids = {
  org: randomUUID(),
  product: randomUUID(),
  user: randomUUID(),
  foreignProduct: randomUUID(),
  foreignUser: randomUUID(),
  program: randomUUID(),
  payoutUser: randomUUID(),
};
let ownerId: string;

beforeAll(async () => {
  await db
    .insert(schema.org)
    .values({ id: ids.org, name: "Independent partners test" });
  await db.insert(schema.product).values([
    { id: ids.product, orgId: ids.org, name: "Partner product" },
    { id: ids.foreignProduct, orgId: ids.org, name: "Different product" },
  ]);
  await db.insert(schema.user).values([
    {
      id: ids.user,
      name: "Independent partner",
      email: `${ids.user}@example.test`,
      emailVerified: true,
    },
    {
      id: ids.foreignUser,
      name: "Other partner",
      email: `${ids.foreignUser}@example.test`,
      emailVerified: true,
    },
    {
      id: ids.payoutUser,
      name: "Payout partner",
      email: `${ids.payoutUser}@example.test`,
      emailVerified: true,
    },
  ]);
  await db
    .insert(schema.eventDefinition)
    .values({
      type: "purchase",
      name: "Purchase",
      config: { schemaVersion: 1 },
    })
    .onConflictDoNothing();
  await db.insert(schema.program).values({
    id: ids.program,
    productId: ids.product,
    name: "Owned results",
    status: "active",
    programTemplateId: "single-sided",
    config: { schemaVersion: 1, widgetConfig: defaultWidgetConfig },
  });
});
afterAll(async () => {
  await db.$client.end();
});

describe("independent partner ownership and payout input", () => {
  it("allows a verified session owner to access its participant without bank details", async () => {
    const [created] = await db
      .insert(schema.participant)
      .values({
        productId: ids.product,
        externalId: ids.user,
        ownerUserId: ids.user,
        ownershipVerifiedBy: ids.user,
        ownershipVerifiedAt: new Date(),
      })
      .returning();
    expect(created).toBeDefined();
    ownerId = created!.id;
    const own = await ownParticipant(db, ids.user, ids.product);
    expect(own.id).toBe(ownerId);
    expect(own.payoutRecipient).toBeNull();
    await expect(
      ownParticipant(db, ids.foreignUser, ids.product),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      ownParticipant(db, ids.user, ids.foreignProduct),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("freezes recipient per request and rejects changed content under the same idempotency key", async () => {
    const [owner] = await db
      .insert(schema.participant)
      .values({
        productId: ids.product,
        externalId: ids.payoutUser,
        ownerUserId: ids.payoutUser,
        ownershipVerifiedBy: ids.payoutUser,
        ownershipVerifiedAt: new Date(),
        ownershipEvidence: "Independent payout fixture",
        payoutRecipient: {
          name: "Recipient A",
          details: "Account A",
          providedBy: ids.payoutUser,
          providedAt: new Date().toISOString(),
        },
      })
      .returning();
    await db.insert(schema.reward).values({
      programId: ids.program,
      participantId: owner!.id,
      rewardType: "cash",
      amount: "10.00",
      currency: "RUB",
      status: "approved",
    });
    const key = randomUUID();
    const input = {
      productId: ids.product,
      amountMinor: 300,
      currency: "RUB" as const,
      idempotencyKey: key,
      recipient: { name: "Recipient A", details: "Account A" },
    };
    await expect(
      requestParticipantPayout(db, ids.payoutUser, {
        ...input,
        recipient: { name: "Recipient A", details: "" },
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await db
        .select()
        .from(schema.payout)
        .where(eq(schema.payout.productId, ids.product)),
    ).toEqual([]);
    const payout = await requestParticipantPayout(db, ids.payoutUser, input);
    expect(payout.recipient).toMatchObject({
      ...input.recipient,
      providedBy: ids.payoutUser,
    });
    expect((await requestParticipantPayout(db, ids.payoutUser, input)).id).toBe(
      payout.id,
    );
    await expect(
      requestParticipantPayout(db, ids.payoutUser, {
        ...input,
        recipient: { name: "Recipient B", details: "Account B" },
      }),
    ).rejects.toMatchObject({ code: "PAYOUT_CONFLICT", statusCode: 409 });
    const second = await requestParticipantPayout(db, ids.payoutUser, {
      ...input,
      idempotencyKey: randomUUID(),
      recipient: { name: "Recipient B", details: "Account B" },
    });
    expect(second.recipient.name).toBe("Recipient B");
    const [original] = await db
      .select()
      .from(schema.payout)
      .where(eq(schema.payout.id, payout.id));
    expect(original!.recipient.name).toBe("Recipient A");
    const [updatedOwner] = await db
      .select()
      .from(schema.participant)
      .where(eq(schema.participant.id, owner!.id));
    expect(updatedOwner!.payoutRecipient!.name).toBe("Recipient B");
    await expect(
      requestParticipantPayout(db, ids.foreignUser, input),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

it.each([
  [" ANNA10 ", "anna10"],
  ["a1b", "a1b"],
  ["A".repeat(32), "a".repeat(32)],
])(
  "normalizes a meaningful buyer code %s using the canonical contract",
  (input, expected) => {
    expect(inputRefcodeSchema.parse(input)).toBe(expected);
  },
);
it.each([
  "ab",
  "a".repeat(33),
  "анна10",
  "anna-10",
  "anna 10",
  "health",
  "Kaa",
])("rejects an invalid or reserved buyer code %s", (input) => {
  expect(inputRefcodeSchema.safeParse(input).success).toBe(false);
});

async function selfServiceFixture(
  currency: CurrencyType = "RUB",
  productId = randomUUID(),
) {
  const programId = randomUUID();
  const terms: RewardConfigType = {
    firstPaidOnly: true,
    referrer: {
      type: "cash",
      valueType: "fixed",
      value: 1,
      currency,
      basis: "payable_amount",
    },
  };
  const config = {
    schemaVersion: 1 as const,
    widgetConfig: defaultWidgetConfig,
    rewardConfig: terms,
    serverTracking: {
      calculationVersion: 1 as const,
      approvedBy: ids.user,
      approvedAt: new Date().toISOString(),
      termsFingerprint: core.referralTermsFingerprint(terms),
      ownershipVerified: true as const,
    },
  };
  await db
    .insert(schema.product)
    .values({
      id: productId,
      orgId: ids.org,
      name: "Isolated self-service product",
    })
    .onConflictDoNothing();
  await db.insert(schema.program).values({
    id: programId,
    productId,
    name: "Independent programme",
    programTemplateId: "double-sided",
    status: "active",
    config,
  });
  const ruleSpecs = createTemplateRuleSpecs("double-sided", terms);
  await db
    .insert(schema.rewardRule)
    .values(ruleSpecs.map((spec) => ({ ...spec, programId })));
  const economics = await core.approvedReferralEconomics(db, {
    id: programId,
    config,
  });
  const rules = await core.publishPartnerTerms(db, ids.user, {
    productId,
    programId,
    body: "Independent partner rules. Only eligible confirmed first purchases earn a pending reward; approved earnings may be requested by eligible independent businesses. Recipients provide truthful details. Manual transfers follow the published programme conditions.",
    termsFingerprint: core.partnerTermsFingerprint(
      { config, startDate: null, endDate: null },
      economics.commission,
    ),
    confirmReviewedRules: true,
  });
  await db
    .update(schema.program)
    .set({
      config: { ...config, selfService: { enabled: true, termsId: rules.id } },
    })
    .where(eq(schema.program.id, programId));
  return {
    productId,
    programId,
    rules,
    config,
    code: `anna${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
}

describe("atomic self-service programme participation", () => {
  it("joins once under parallel requests, without bank details, memberships or an AI account", async () => {
    const fixture = await selfServiceFixture();
    const input = {
      programId: fixture.programId,
      termsId: fixture.rules.id,
      acceptRules: true as const,
      code: fixture.code,
    };
    const [first, retry] = await Promise.all([
      core.joinPartnerProgram(db, ids.foreignUser, input),
      core.joinPartnerProgram(db, ids.foreignUser, input),
    ]);
    expect(retry).toEqual(first);
    const own = await ownParticipant(db, ids.foreignUser, fixture.productId);
    expect(own.payoutRecipient).toBeNull();
    expect(own.ownershipEvidence).toBeNull();
    const codes = await db
      .select()
      .from(schema.refcode)
      .where(eq(schema.refcode.participantId, own.id));
    expect(codes.map((row) => row.code)).toEqual([fixture.code]);
    const memberships = await db
      .select()
      .from(schema.orgUser)
      .where(eq(schema.orgUser.userId, ids.foreignUser));
    expect(memberships).toEqual([]);
    await expect(
      core.joinPartnerProgram(db, ids.user, input),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      ownParticipant(db, ids.user, fixture.productId),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects disabled programmes, unverified accounts and a stale displayed rules version", async () => {
    const fixture = await selfServiceFixture();
    const input = {
      programId: fixture.programId,
      termsId: fixture.rules.id,
      acceptRules: true as const,
      code: fixture.code,
    };
    const unverified = randomUUID();
    await db.insert(schema.user).values({
      id: unverified,
      name: "Not yet verified",
      email: `${unverified}@example.test`,
      emailVerified: false,
    });
    await expect(
      core.joinPartnerProgram(db, unverified, input),
    ).rejects.toMatchObject({ statusCode: 403 });
    await db
      .update(schema.program)
      .set({
        config: {
          ...fixture.config,
          selfService: { enabled: false, termsId: fixture.rules.id },
        },
      })
      .where(eq(schema.program.id, fixture.programId));
    await expect(
      core.joinPartnerProgram(db, ids.user, input),
    ).rejects.toMatchObject({ statusCode: 403 });
    await db
      .update(schema.program)
      .set({
        config: {
          ...fixture.config,
          selfService: { enabled: true, termsId: fixture.rules.id },
        },
      })
      .where(eq(schema.program.id, fixture.programId));
    const next = await core.publishPartnerTerms(db, ids.user, {
      productId: fixture.productId,
      programId: fixture.programId,
      body: `${fixture.rules.body} This is a revised text.`,
      termsFingerprint: fixture.rules.termsFingerprint,
      confirmReviewedRules: true,
    });
    await expect(
      core.joinPartnerProgram(db, ids.user, input),
    ).rejects.toMatchObject({ statusCode: 409 });
    const result = await core.joinPartnerProgram(db, ids.user, {
      ...input,
      termsId: next.id,
    });
    expect(result.code).toBe(fixture.code);
    await expect(
      core.joinPartnerProgram(db, ids.user, {
        ...input,
        termsId: next.id,
        acceptRules: false,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("keeps additional codes owner-scoped and rejects another owner's code collision", async () => {
    const fixture = await selfServiceFixture();
    const first = await core.joinPartnerProgram(db, ids.user, {
      programId: fixture.programId,
      termsId: fixture.rules.id,
      acceptRules: true,
      code: fixture.code,
    });
    const other = await core.joinPartnerProgram(db, ids.foreignUser, {
      programId: fixture.programId,
      termsId: fixture.rules.id,
      acceptRules: true,
      code: `blog${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    });
    const input = {
      programId: fixture.programId,
      code: `video${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    };
    const extra = await core.createPartnerCode(db, ids.user, input);
    expect((await core.createPartnerCode(db, ids.user, input)).codeId).toBe(
      extra.codeId,
    );
    await expect(
      core.createPartnerCode(db, ids.foreignUser, input),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      core.setPartnerCodeActive(db, ids.foreignUser, {
        productId: fixture.productId,
        codeId: first.codeId,
        isActive: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      (
        await core.setPartnerCodeActive(db, ids.user, {
          productId: fixture.productId,
          codeId: extra.codeId,
          isActive: false,
        })
      ).isActive,
    ).toBe(false);
    expect(await core.createPartnerCode(db, ids.user, input)).toMatchObject({
      codeId: extra.codeId,
      isActive: false,
    });
    const [unchanged] = await db
      .select()
      .from(schema.refcode)
      .where(eq(schema.refcode.id, other.codeId));
    expect(unchanged!.isActive).toBe(true);
  });
});

it.each([
  { reason: "banned", patch: { banned: true } },
  { reason: "unverified", patch: { emailVerified: false } },
  { reason: "service", patch: { role: "service" } },
])("refuses new applications for a $reason code owner", async ({ patch }) => {
  const fixture = await selfServiceFixture();
  await core.joinPartnerProgram(db, ids.user, {
    programId: fixture.programId,
    termsId: fixture.rules.id,
    acceptRules: true,
    code: fixture.code,
  });
  const [account] = await db
    .select({
      banned: schema.user.banned,
      emailVerified: schema.user.emailVerified,
      role: schema.user.role,
    })
    .from(schema.user)
    .where(eq(schema.user.id, ids.user));
  if (!account) throw new Error("Missing isolated code owner");
  try {
    await db.update(schema.user).set(patch).where(eq(schema.user.id, ids.user));
    await expect(
      core.resolveReferralCode(db, {
        productId: fixture.productId,
        programId: fixture.programId,
        customerExternalId: randomUUID(),
        code: fixture.code,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await db
      .update(schema.user)
      .set(account)
      .where(eq(schema.user.id, ids.user));
  }
});

it("counts actual paid purchases once across multiple reward rules and accepts a late payment after code disable and owner ban", async () => {
  const fixture = await selfServiceFixture();
  const [secondRule] = createTemplateRuleSpecs("double-sided", {
    ...fixture.config.rewardConfig,
    referrer: { ...fixture.config.rewardConfig.referrer!, value: 0.5 },
  });
  await db.insert(schema.rewardRule).values({
    ...secondRule!,
    name: "Second independent rule",
    programId: fixture.programId,
  });
  const [program] = await db
    .select()
    .from(schema.program)
    .where(eq(schema.program.id, fixture.programId));
  const economics = await core.approvedReferralEconomics(db, program!);
  const rules = await core.publishPartnerTerms(db, ids.user, {
    productId: fixture.productId,
    programId: fixture.programId,
    body: fixture.rules.body,
    termsFingerprint: core.partnerTermsFingerprint(
      program!,
      economics.commission,
    ),
    confirmReviewedRules: true,
  });
  const joined = await core.joinPartnerProgram(db, ids.user, {
    programId: fixture.programId,
    termsId: rules.id,
    acceptRules: true,
    code: fixture.code,
  });
  const buyer = randomUUID();
  const resolution = await core.resolveReferralCode(db, {
    productId: fixture.productId,
    programId: fixture.programId,
    customerExternalId: buyer,
    code: fixture.code,
  });
  const acceptedAt = "2026-10-15T12:00:00.000Z";
  const snapshot: ReferralSnapshotV1 = {
    schemaVersion: 1,
    calculationVersion: 1,
    acceptedAt,
    offerVersion: "a".repeat(64),
    firstPaidOnly: true,
    attribution: {
      productId: fixture.productId,
      programId: fixture.programId,
      codeId: joined.codeId,
      codeValue: fixture.code,
      referrerParticipantId: joined.participantId,
    },
    pricing: {
      planCode: "confirmed",
      priceVersion: "test-version",
      currency: "RUB",
      baseAmountMinor: 1000,
      discountAmountMinor: 0,
      payableAmountMinor: 1000,
      buyerDiscountApplicable: false,
      buyerDiscountReason: "no_discount",
    },
    buyerDiscount: resolution.buyerDiscount,
    commission: resolution.commission,
  };
  await core.setPartnerCodeActive(db, ids.user, {
    productId: fixture.productId,
    codeId: joined.codeId,
    isActive: false,
  });
  await expect(
    core.resolveReferralCode(db, {
      productId: fixture.productId,
      programId: fixture.programId,
      customerExternalId: buyer,
      code: fixture.code,
    }),
  ).rejects.toMatchObject({ code: "REFERRAL_CODE_INACTIVE" });
  const purchase = {
    productId: fixture.productId,
    programId: fixture.programId,
    timestamp: "2026-10-15T12:01:00.000Z",
    payload: {
      userId: buyer,
      orderId: randomUUID(),
      currency: "RUB" as const,
      orderAmountMinor: 1000,
      customer: { name: "Private buyer", email: `${buyer}@example.test` },
      referralSnapshot: snapshot,
    },
  };
  const [account] = await db
    .select({ banned: schema.user.banned })
    .from(schema.user)
    .where(eq(schema.user.id, ids.user));
  if (!account) throw new Error("Missing isolated code owner");
  let first: Awaited<ReturnType<typeof core.recordMinorPurchase>>;
  try {
    await db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, ids.user));
    first = await core.recordMinorPurchase(db, purchase);
    expect((await core.recordMinorPurchase(db, purchase)).eventId).toBe(
      first.eventId,
    );
  } finally {
    await db
      .update(schema.user)
      .set(account)
      .where(eq(schema.user.id, ids.user));
  }
  const rewardToApprove = first.rewards.find(
    (reward) => reward.amountMinor === 100,
  );
  expect(rewardToApprove).toBeDefined();
  await db
    .update(schema.reward)
    .set({ status: "approved" })
    .where(eq(schema.reward.id, rewardToApprove!.id));
  const range = {
    productId: fixture.productId,
    from: new Date("2026-10-01T00:00:00.000Z"),
    to: new Date("2026-11-01T00:00:00.000Z"),
  };
  const report = await core.partnerCodeStats(db, ids.user, range);
  expect(report).toEqual([
    {
      codeId: joined.codeId,
      code: fixture.code,
      programId: fixture.programId,
      programName: "Independent programme",
      isActive: false,
      metrics: [
        {
          currency: "RUB",
          paidPurchases: 1,
          paidAmountMinor: 1000,
          pendingMinor: 50,
          approvedMinor: 100,
          rejectedMinor: 0,
          disbursedMinor: 0,
        },
      ],
    },
  ]);
  expect(JSON.stringify(report)).not.toContain(buyer);
  await expect(
    core.partnerCodeStats(db, ids.foreignUser, range),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    core.partnerCodeStats(db, ids.user, {
      ...range,
      from: new Date("2020-01-01T00:00:00Z"),
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const excluded = await core.partnerCodeStats(db, ids.user, {
    ...range,
    from: new Date("2026-10-16T00:00:00Z"),
    to: new Date("2026-10-17T00:00:00Z"),
  });
  expect(excluded[0]!.metrics).toEqual([]);
  const usd = await selfServiceFixture("USD", fixture.productId);
  const usdJoined = await core.joinPartnerProgram(db, ids.user, {
    programId: usd.programId,
    termsId: usd.rules.id,
    acceptRules: true,
    code: usd.code,
  });
  const usdBuyer = randomUUID();
  const usdResolution = await core.resolveReferralCode(db, {
    productId: usd.productId,
    programId: usd.programId,
    customerExternalId: usdBuyer,
    code: usd.code,
  });
  const usdTimestamp = "2026-10-15T12:01:01.000Z";
  const usdSnapshot: ReferralSnapshotV1 = {
    ...snapshot,
    attribution: {
      productId: usd.productId,
      programId: usd.programId,
      codeId: usdJoined.codeId,
      codeValue: usd.code,
      referrerParticipantId: usdJoined.participantId,
    },
    pricing: {
      ...snapshot.pricing,
      currency: "USD",
      baseAmountMinor: 5000,
      payableAmountMinor: 5000,
    },
    buyerDiscount: usdResolution.buyerDiscount,
    commission: usdResolution.commission,
  };
  await core.recordMinorPurchase(db, {
    productId: usd.productId,
    programId: usd.programId,
    timestamp: usdTimestamp,
    payload: {
      userId: usdBuyer,
      orderId: randomUUID(),
      currency: "USD",
      orderAmountMinor: 5000,
      customer: {
        name: "Another private buyer",
        email: `${usdBuyer}@example.test`,
      },
      referralSnapshot: usdSnapshot,
    },
  });
  const mixed = await core.partnerCodeStats(db, ids.user, range);
  expect(mixed.find((row) => row.codeId === joined.codeId)!.metrics).toEqual(
    report[0]!.metrics,
  );
  expect(mixed.find((row) => row.codeId === usdJoined.codeId)!.metrics).toEqual(
    [
      {
        currency: "USD",
        paidPurchases: 1,
        paidAmountMinor: 5000,
        pendingMinor: 100,
        approvedMinor: 0,
        rejectedMinor: 0,
        disbursedMinor: 0,
      },
    ],
  );
  const left = await core.partnerCodeStats(db, ids.user, {
    ...range,
    from: new Date(purchase.timestamp),
    to: new Date(usdTimestamp),
  });
  expect(
    left.find((row) => row.codeId === joined.codeId)!.metrics[0]!.paidPurchases,
  ).toBe(1);
  expect(left.find((row) => row.codeId === usdJoined.codeId)!.metrics).toEqual(
    [],
  );
  const right = await core.partnerCodeStats(db, ids.user, {
    ...range,
    from: new Date(usdTimestamp),
    to: new Date("2026-10-15T12:01:02.000Z"),
  });
  expect(right.find((row) => row.codeId === joined.codeId)!.metrics).toEqual(
    [],
  );
  expect(
    right.find((row) => row.codeId === usdJoined.codeId)!.metrics[0]!
      .paidPurchases,
  ).toBe(1);
});

it("rejects publication when the programme's reviewed period changed", async () => {
  const fixture = await selfServiceFixture();
  await db
    .update(schema.program)
    .set({ endDate: new Date("2027-01-01T00:00:00Z") })
    .where(eq(schema.program.id, fixture.programId));
  await expect(
    core.publishPartnerTerms(db, ids.user, {
      productId: fixture.productId,
      programId: fixture.programId,
      body: `${fixture.rules.body} Reviewed before the period changed.`,
      termsFingerprint: fixture.rules.termsFingerprint,
      confirmReviewedRules: true,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it("closing new enrollment keeps existing members' code management and rules acceptance available", async () => {
  const fixture = await selfServiceFixture();
  const joined = await core.joinPartnerProgram(db, ids.user, {
    programId: fixture.programId,
    termsId: fixture.rules.id,
    acceptRules: true,
    code: fixture.code,
  });
  await core.setPartnerSelfService(db, {
    productId: fixture.productId,
    programId: fixture.programId,
    enabled: false,
  });
  const extra = await core.createPartnerCode(db, ids.user, {
    programId: fixture.programId,
    code: `closed${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  });
  expect(extra.participantId).toBe(joined.participantId);
  await expect(
    core.joinPartnerProgram(db, ids.foreignUser, {
      programId: fixture.programId,
      termsId: fixture.rules.id,
      acceptRules: true,
      code: `other${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  const revised = await core.publishPartnerTerms(db, ids.user, {
    productId: fixture.productId,
    programId: fixture.programId,
    body: `${fixture.rules.body} A new version for existing members.`,
    termsFingerprint: fixture.rules.termsFingerprint,
    confirmReviewedRules: true,
  });
  expect(
    (await core.partnerParticipation(db, ids.user, fixture.programId)).state,
  ).toBe("join");
  const buyer = randomUUID();
  const resolve = {
    productId: fixture.productId,
    programId: fixture.programId,
    customerExternalId: buyer,
    code: fixture.code,
  };
  await expect(core.resolveReferralCode(db, resolve)).rejects.toMatchObject({
    statusCode: 422,
  });
  await core.joinPartnerProgram(db, ids.user, {
    programId: fixture.programId,
    termsId: revised.id,
    acceptRules: true,
    code: fixture.code,
  });
  expect(
    (await core.partnerParticipation(db, ids.user, fixture.programId)).state,
  ).toBe("joined");
  expect((await core.resolveReferralCode(db, resolve)).codeId).toBe(
    joined.codeId,
  );
});

it("requires reviewed effective custom commissions and freezes every accepted commission rule", async () => {
  const fixture = await selfServiceFixture();
  const [custom] = createTemplateRuleSpecs("double-sided", {
    ...fixture.config.rewardConfig,
    referrer: { ...fixture.config.rewardConfig.referrer!, value: 0.25 },
  });
  await db.insert(schema.rewardRule).values({
    ...custom!,
    name: "Additional custom cash commission",
    programId: fixture.programId,
  });
  const join = {
    programId: fixture.programId,
    termsId: fixture.rules.id,
    acceptRules: true,
    code: fixture.code,
  };
  await expect(
    core.joinPartnerProgram(db, ids.user, join),
  ).rejects.toMatchObject({ statusCode: 409 });
  const [program] = await db
    .select()
    .from(schema.program)
    .where(eq(schema.program.id, fixture.programId));
  const economics = await core.approvedReferralEconomics(db, program!);
  const published = await core.publishPartnerTerms(db, ids.user, {
    productId: fixture.productId,
    programId: fixture.programId,
    body: `${fixture.rules.body} Both displayed commission rules apply.`,
    termsFingerprint: core.partnerTermsFingerprint(
      program!,
      economics.commission,
    ),
    confirmReviewedRules: true,
  });
  expect(
    published.commission.rules.map((rule) => rule.config.reward.amount).sort(),
  ).toEqual([0.25, 1]);
  const shown = await core.partnerParticipation(
    db,
    ids.user,
    fixture.programId,
  );
  expect(shown).toMatchObject({
    state: "join",
    rules: { id: published.id, commission: published.commission },
  });
  const joined = await core.joinPartnerProgram(db, ids.user, {
    ...join,
    termsId: published.id,
  });
  const resolution = await core.resolveReferralCode(db, {
    productId: fixture.productId,
    programId: fixture.programId,
    customerExternalId: randomUUID(),
    code: joined.code,
  });
  expect(resolution.commission).toEqual(economics.commission);
});
