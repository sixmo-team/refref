// Example model schema from the Drizzle docs
// https://orm.drizzle.team/docs/sql-schema-declaration

import { relations, sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  timestamp,
  text,
  boolean,
  jsonb,
  decimal,
  unique,
  index,
  uniqueIndex,
  bigint,
  foreignKey,
  check,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { createId as createCuid } from "@paralleldrive/cuid2";
import { createId, isValidEntityType } from "@refref/id";
import type {
  ProgramConfigV1Type,
  EventDefinitionConfigV1Type,
  EventMetadata,
  RewardRuleConfigV1Type,
  RewardMetadataV1Type,
  PayoutRecipientSnapshot,
  RewardConfigType,
  FrozenCommission,
} from "@refref/types";

// Base table for common fields
export const baseFields = (entityType: string) => {
  return {
    id: text("id")
      .primaryKey()
      .$defaultFn(() =>
        entityType && isValidEntityType(entityType)
          ? createId(entityType)
          : createCuid(),
      ),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`now()`),
  };
};

export const user = pgTable("user", {
  ...baseFields("user"),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  role: text("role"),
  banned: boolean("banned"),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
});

export const session = pgTable("session", {
  ...baseFields("session"),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
  impersonatedBy: text("impersonated_by"),
});

export const account = pgTable("account", {
  ...baseFields("account"),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
});

export const verification = pgTable("verification", {
  ...baseFields("verification"),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const org = pgTable("org", {
  ...baseFields("org"),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  metadata: text("metadata"),
});

export const orgUser = pgTable("org_user", {
  ...baseFields("orgUser"),
  orgId: text("org_id")
    .notNull()
    .references(() => org.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
});

export const product = pgTable("product", {
  ...baseFields("product"),
  orgId: text("org_id").references(() => org.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  url: text("url"),
  metadata: text("metadata"),
  appType: text("app_type"),
  useCase: text("use_case"),
  paymentProvider: text("payment_provider"),
  onboardingCompleted: boolean("onboarding_completed").default(false),
  onboardingStep: integer("onboarding_step").default(1),
});

export const productUser = pgTable("product_user", {
  ...baseFields("productUser"),
  productId: text("product_id")
    .notNull()
    .references(() => product.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
});

export const invitation = pgTable("invitation", {
  ...baseFields("invitation"),
  organizationId: text("organization_id").references(() => org.id, {
    onDelete: "cascade",
  }),
  productId: text("product_id").references(() => product.id, {
    onDelete: "cascade",
  }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const apikey = pgTable(
  "apikey",
  {
    ...baseFields("apikey"),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    configId: text("config_id").notNull().default("default"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at"),
    enabled: boolean("enabled"),
    rateLimitEnabled: boolean("rate_limit_enabled"),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request"),
    expiresAt: timestamp("expires_at"),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_key_idx").on(table.key),
  ],
);

export const program = pgTable(
  "program",
  {
    ...baseFields("program"),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    programTemplateId: text("program_template_id").notNull(), // Template ID from PROGRAM_TEMPLATES constants
    name: text("name").notNull(),
    status: text("status").notNull(), // e.g., "active", "inactive", "draft"
    startDate: timestamp("start_date"),
    endDate: timestamp("end_date"),
    config: jsonb("config").$type<ProgramConfigV1Type>(),
  },
  (table) => [
    unique("program_product_id_unique").on(table.productId, table.id),
  ],
);

export const programUser = pgTable("program_user", {
  ...baseFields("programUser"),
  programId: text("program_id")
    .notNull()
    .references(() => program.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
});

export const eventDefinition = pgTable("event_definition", {
  ...baseFields("eventDefinition"),
  name: text("name").notNull(),
  type: text("type").notNull().unique(),
  description: text("description"),
  config: jsonb("config").$type<EventDefinitionConfigV1Type>(),
});

export const participant = pgTable(
  "participant",
  {
    ...baseFields("participant"),
    name: text("name"),
    email: text("email"),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    firstPurchaseEventId: text("first_purchase_event_id"),
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    ownershipVerifiedBy: text("ownership_verified_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    ownershipVerifiedAt: timestamp("ownership_verified_at", {
      withTimezone: true,
    }),
    ownershipEvidence: text("ownership_evidence"),
    payoutRecipient: jsonb("payout_recipient").$type<PayoutRecipientSnapshot>(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique().on(table.productId, table.externalId),
    unique("participant_product_id_unique").on(table.productId, table.id),
    unique("participant_product_id_owner_unique").on(
      table.productId,
      table.id,
      table.ownerUserId,
    ),
    uniqueIndex("participant_verified_owner_unique")
      .on(table.productId, table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    foreignKey({
      name: "participant_first_purchase_scope_fk",
      columns: [table.productId, table.id, table.firstPurchaseEventId],
      foreignColumns: [event.productId, event.participantId, event.id],
    }).onDelete("restrict"),
    check(
      "participant_verified_ownership_check",
      sql`(${table.ownerUserId} IS NULL AND ${table.ownershipVerifiedBy} IS NULL AND ${table.ownershipVerifiedAt} IS NULL AND ${table.ownershipEvidence} IS NULL AND ${table.payoutRecipient} IS NULL) OR (${table.ownerUserId} IS NOT NULL AND ${table.ownershipVerifiedBy} IS NOT NULL AND ${table.ownershipVerifiedAt} IS NOT NULL AND (${table.ownershipEvidence} IS NULL OR length(${table.ownershipEvidence})>0) AND (${table.payoutRecipient} IS NULL OR jsonb_typeof(${table.payoutRecipient})='object'))`,
    ),
  ],
);
// General participant views do not expose verified payout identity or recipient details.
export const participantProfileColumns = {
  id: participant.id,
  createdAt: participant.createdAt,
  updatedAt: participant.updatedAt,
  name: participant.name,
  email: participant.email,
  productId: participant.productId,
  externalId: participant.externalId,
};

// Note: event table moved after referral table to fix forward reference

export const rewardRule = pgTable(
  "reward_rule",
  {
    ...baseFields("rewardRule"),
    programId: text("program_id")
      .notNull()
      .references(() => program.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull(),
    config: jsonb("config").notNull().$type<RewardRuleConfigV1Type>(),
    priority: integer("priority").default(0),
    isActive: boolean("is_active").default(true),
  },
  (table) => [
    unique("reward_rule_program_id_unique").on(table.programId, table.id),
    // Indexes for performance
    index("reward_rule_program_id_idx").on(table.programId),
    index("reward_rule_type_idx").on(table.type),
    index("reward_rule_is_active_idx").on(table.isActive),
  ],
);

export const reward = pgTable(
  "reward",
  {
    ...baseFields("reward"),
    participantId: text("participant_id")
      .notNull()
      .references(() => participant.id, { onDelete: "restrict" }),
    programId: text("program_id")
      .notNull()
      .references(() => program.id, { onDelete: "restrict" }),
    rewardRuleId: text("reward_rule_id").references(() => rewardRule.id),
    eventId: text("event_id").references(() => event.id),
    rewardType: text("reward_type").notNull(), // e.g., "cash", "discount", "gift_card"
    amount: decimal("amount", { precision: 10, scale: 2 }), // Example precision/scale
    currency: text("currency"), // e.g., "USD", "EUR"
    status: text("status").notNull(), // e.g., "pending_disbursal", "disbursed"
    disbursedAt: timestamp("disbursed_at"),
    metadata: jsonb("metadata").$type<RewardMetadataV1Type>(),
  },
  (table) => [
    foreignKey({
      name: "reward_rule_scope_fk",
      columns: [table.programId, table.rewardRuleId],
      foreignColumns: [rewardRule.programId, rewardRule.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "reward_event_program_scope_fk",
      columns: [table.programId, table.eventId],
      foreignColumns: [event.programId, event.id],
    }).onDelete("restrict"),
    // Indexes for performance
    index("reward_participant_id_idx").on(table.participantId),
    index("reward_program_id_idx").on(table.programId),
    index("reward_rule_id_idx").on(table.rewardRuleId),
    index("reward_event_id_idx").on(table.eventId),
    index("reward_status_idx").on(table.status),
    index("reward_created_at_idx").on(table.createdAt),
    uniqueIndex("reward_event_rule_participant_unique_idx").on(
      table.eventId,
      table.rewardRuleId,
      table.participantId,
    ),
  ],
);

// Product secrets for JWT generation
export const productSecrets = pgTable("product_secret", {
  ...baseFields("productSecrets"),
  productId: text("product_id")
    .notNull()
    .references(() => product.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
});

export const refcode = pgTable(
  "refcode",
  {
    ...baseFields("refcode"),
    isActive: boolean("is_active").notNull().default(true),
    // Generated suggestion or chosen tracking code, canonical lowercase ASCII.
    code: text("code").notNull(),
    // Core relationships
    participantId: text("participant_id")
      .notNull()
      .references(() => participant.id, { onDelete: "restrict" }),
    programId: text("program_id")
      .notNull()
      .references(() => program.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
  },
  (table) => [
    unique("refcode_scope_unique").on(
      table.productId,
      table.programId,
      table.participantId,
      table.id,
    ),
    foreignKey({
      name: "refcode_participant_scope_fk",
      columns: [table.productId, table.participantId],
      foreignColumns: [participant.productId, participant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "refcode_program_scope_fk",
      columns: [table.productId, table.programId],
      foreignColumns: [program.productId, program.id],
    }).onDelete("restrict"),
    // Unique index for globally unique codes
    uniqueIndex("refcode_code_unique_idx").on(table.code),
    // Index for participant lookups
    index("refcode_participant_id_idx").on(table.participantId),
    // Index for program lookups
    index("refcode_program_id_idx").on(table.programId),
    // Index for product lookups
    index("refcode_product_id_idx").on(table.productId),
  ],
);

export const reflink = pgTable(
  "reflink",
  {
    ...baseFields("reflink"),
    // Vanity URL slug (e.g., "john-doe", "ceo", "founder-2024")
    slug: text("slug").notNull(),
    // Reference to the underlying refcode
    refcodeId: text("refcode_id")
      .notNull()
      .references(() => refcode.id, { onDelete: "cascade" }),
    // Product scoping for vanity links
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Unique vanity slug per product
    uniqueIndex("reflink_slug_product_unique_idx").on(
      table.slug,
      table.productId,
    ),
    // Index for fast slug lookups (hot path for referral redirects)
    index("reflink_slug_idx").on(table.slug),
    // Index for refcode lookups
    index("reflink_refcode_id_idx").on(table.refcodeId),
    // Index for product lookups
    index("reflink_product_id_idx").on(table.productId),
  ],
);

// Relations for refcode
export const refcodeRelations = relations(refcode, ({ one, many }) => ({
  participant: one(participant, {
    fields: [refcode.participantId],
    references: [participant.id],
  }),
  program: one(program, {
    fields: [refcode.programId],
    references: [program.id],
  }),
  product: one(product, {
    fields: [refcode.productId],
    references: [product.id],
  }),
  reflinks: many(reflink),
}));

// Relations for reflink
export const reflinkRelations = relations(reflink, ({ one }) => ({
  refcode: one(refcode, {
    fields: [reflink.refcodeId],
    references: [refcode.id],
  }),
  product: one(product, {
    fields: [reflink.productId],
    references: [product.id],
  }),
}));

// Relations for participant
export const participantRelations = relations(participant, ({ one, many }) => ({
  product: one(product, {
    fields: [participant.productId],
    references: [product.id],
  }),
  refcodes: many(refcode),
}));

export const referral = pgTable(
  "referral",
  {
    ...baseFields("referral"),
    productId: text("product_id").references(() => product.id, {
      onDelete: "restrict",
    }),
    refcodeId: text("refcode_id").references(() => refcode.id, {
      onDelete: "restrict",
    }),
    appliedCode: text("applied_code"),
    referrerId: text("referrer_id")
      .notNull()
      .references(() => participant.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    programId: text("program_id").references(() => program.id, {
      onDelete: "restrict",
    }),
    email: text("email"),
    name: text("name"),
  },
  (table) => [
    index("referral_program_id_idx").on(table.programId),
    unique("referral_product_id_unique").on(table.productId, table.id),
    unique("referral_product_program_id_unique").on(
      table.productId,
      table.programId,
      table.id,
    ),
    unique("referral_scope_unique").on(
      table.productId,
      table.programId,
      table.referrerId,
      table.id,
    ),
    foreignKey({
      name: "referral_referrer_scope_fk",
      columns: [table.productId, table.referrerId],
      foreignColumns: [participant.productId, participant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "referral_program_scope_fk",
      columns: [table.productId, table.programId],
      foreignColumns: [program.productId, program.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "referral_code_scope_fk",
      columns: [
        table.productId,
        table.programId,
        table.referrerId,
        table.refcodeId,
      ],
      foreignColumns: [
        refcode.productId,
        refcode.programId,
        refcode.participantId,
        refcode.id,
      ],
    }).onDelete("restrict"),
    check(
      "referral_code_pair_check",
      sql`(${table.refcodeId} IS NULL)=(${table.appliedCode} IS NULL) AND (${table.refcodeId} IS NULL OR (${table.productId} IS NOT NULL AND ${table.programId} IS NOT NULL))`,
    ),
  ],
);

// Event table (moved here to fix forward reference to referral table)
export const event = pgTable(
  "event",
  {
    ...baseFields("event"),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    programId: text("program_id").references(() => program.id, {
      onDelete: "restrict",
    }),
    participantId: text("participant_id").references(() => participant.id),
    referralId: text("referral_id").references(() => referral.id),
    eventDefinitionId: text("event_definition_id")
      .notNull()
      .references(() => eventDefinition.id),
    status: text("status").notNull().default("pending"),
    businessKey: text("business_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<EventMetadata>(),
  },
  (table) => [
    unique("event_owner_unique").on(
      table.productId,
      table.participantId,
      table.id,
    ),
    unique("event_product_id_unique").on(table.productId, table.id),
    unique("event_program_id_unique").on(table.programId, table.id),
    foreignKey({
      name: "event_program_scope_fk",
      columns: [table.productId, table.programId],
      foreignColumns: [program.productId, program.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_participant_scope_fk",
      columns: [table.productId, table.participantId],
      foreignColumns: [participant.productId, participant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_referral_scope_fk",
      columns: [table.productId, table.programId, table.referralId],
      foreignColumns: [referral.productId, referral.programId, referral.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "event_referral_product_scope_fk",
      columns: [table.productId, table.referralId],
      foreignColumns: [referral.productId, referral.id],
    }).onDelete("restrict"),
    check(
      "event_metadata_version_check",
      sql`${table.metadata} IS NULL OR COALESCE(jsonb_typeof(${table.metadata})='object' AND (${table.metadata}->'schemaVersion'='1'::jsonb OR ${table.metadata}->'schemaVersion'='2'::jsonb),false)`,
    ),
    check(
      "purchase_v2_pricing_check",
      sql`${table.metadata}->>'schemaVersion'<>'2' OR COALESCE((${table.metadata}#>>'{referralSnapshot,pricing,baseAmountMinor}')::bigint - (${table.metadata}#>>'{referralSnapshot,pricing,discountAmountMinor}')::bigint = (${table.metadata}#>>'{referralSnapshot,pricing,payableAmountMinor}')::bigint AND (${table.metadata}#>>'{referralSnapshot,pricing,discountAmountMinor}')::bigint >=0,false)`,
    ),
    check(
      "purchase_v2_projection_check",
      sql`${table.metadata}->>'schemaVersion'<>'2' OR COALESCE(${table.metadata}->>'source'='api' AND ${table.metadata}->>'orderId'=${table.businessKey} AND (${table.metadata}->>'orderAmountMinor')::bigint>0 AND ${table.metadata}->>'currency'=${table.metadata}#>>'{referralSnapshot,pricing,currency}' AND ${table.metadata}->>'orderAmountMinor'=${table.metadata}#>>'{referralSnapshot,pricing,payableAmountMinor}' AND ${table.metadata}#>>'{referralSnapshot,schemaVersion}'='1' AND ${table.metadata}#>>'{referralSnapshot,calculationVersion}'='1' AND ${table.metadata}#>>'{referralSnapshot,attribution,productId}'=${table.productId} AND ${table.metadata}#>>'{referralSnapshot,attribution,programId}'=${table.programId} AND ${table.participantId} IS NOT NULL AND ${table.referralId} IS NOT NULL AND ${table.occurredAt} IS NOT NULL,false)`,
    ),
    // Indexes for performance
    index("event_product_id_idx").on(table.productId),
    index("event_program_id_idx").on(table.programId),
    index("event_participant_id_idx").on(table.participantId),
    index("event_referral_id_idx").on(table.referralId),
    index("event_definition_id_idx").on(table.eventDefinitionId),
    index("event_status_idx").on(table.status),
    index("event_created_at_idx").on(table.createdAt),
    uniqueIndex("event_business_key_unique_idx").on(
      table.productId,
      table.eventDefinitionId,
      table.businessKey,
    ),
  ],
);

export const referralRelations = relations(referral, ({ one }) => ({
  referrer: one(participant, {
    fields: [referral.referrerId],
    references: [participant.id],
  }),
}));

export const payout = pgTable(
  "payout",
  {
    ...baseFields("payout"),
    productId: text("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participant.id, { onDelete: "restrict" }),
    currency: text("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    status: text("status").notNull().default("requested"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assignedTo: text("assigned_to").references(() => user.id, {
      onDelete: "restrict",
    }),
    confirmedBy: text("confirmed_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    recipient: jsonb("recipient").notNull().$type<PayoutRecipientSnapshot>(),
    executionMethod: text("execution_method"),
    provider: text("provider"),
    executionNamespace: text("execution_namespace"),
    externalReference: text("external_reference"),
    confirmationKey: text("confirmation_key"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    audit: jsonb("audit")
      .notNull()
      .$type<
        Array<{ status: string; actorId: string; at: string; reason?: string }>
      >(),
  },
  (table) => [
    foreignKey({
      name: "payout_owner_scope_fk",
      columns: [table.productId, table.participantId],
      foreignColumns: [participant.productId, participant.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "payout_request_owner_fk",
      columns: [table.productId, table.participantId, table.requestedBy],
      foreignColumns: [
        participant.productId,
        participant.id,
        participant.ownerUserId,
      ],
    }).onDelete("restrict"),
    check(
      "payout_currency_check",
      sql`${table.currency} IN ('USD','EUR','GBP','RUB')`,
    ),
    check(
      "payout_amount_minor_check",
      sql`${table.amountMinor}>0 AND ${table.amountMinor}<=9007199254740991`,
    ),
    check(
      "payout_status_check",
      sql`${table.status} IN ('requested','processing','completed','rejected')`,
    ),
    check(
      "payout_recipient_check",
      sql`jsonb_typeof(${table.recipient})='object'`,
    ),
    check(
      "payout_audit_check",
      sql`jsonb_typeof(${table.audit})='array' AND jsonb_array_length(${table.audit})<=4`,
    ),
    check(
      "payout_completed_fields_check",
      sql`${table.status}<>'completed' OR (${table.assignedTo} IS NOT NULL AND ${table.confirmedBy} IS NOT NULL AND ${table.executionMethod} IS NOT NULL AND ${table.provider} IS NOT NULL AND ${table.executionNamespace} IS NOT NULL AND ${table.externalReference} IS NOT NULL AND ${table.confirmationKey} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "payout_processing_actor_check",
      sql`${table.status} NOT IN ('processing','completed') OR ${table.assignedTo} IS NOT NULL`,
    ),
    uniqueIndex("payout_request_unique_idx").on(
      table.productId,
      table.participantId,
      table.idempotencyKey,
    ),
    uniqueIndex("payout_external_reference_unique_idx").on(
      table.executionNamespace,
      table.provider,
      table.externalReference,
    ),
    index("payout_owner_currency_status_date_idx").on(
      table.productId,
      table.participantId,
      table.currency,
      table.status,
      table.createdAt,
    ),
  ],
);

// Published rules and their actual economic terms are immutable financial facts.
export const programTerms = pgTable(
  "program_terms",
  {
    ...baseFields("programTerms"),
    productId: text("product_id").notNull(),
    programId: text("program_id").notNull(),
    body: text("body").notNull(),
    rewardConfig: jsonb("reward_config").notNull().$type<RewardConfigType>(),
    commission: jsonb("commission").notNull().$type<FrozenCommission>(),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    termsFingerprint: text("terms_fingerprint").notNull(),
    publishedBy: text("published_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    unique("program_terms_scope_unique").on(
      table.productId,
      table.programId,
      table.id,
    ),
    foreignKey({
      name: "program_terms_program_scope_fk",
      columns: [table.productId, table.programId],
      foreignColumns: [program.productId, program.id],
    }).onDelete("restrict"),
    check(
      "program_terms_body_check",
      sql`length(trim(${table.body})) BETWEEN 200 AND 30000`,
    ),
  ],
);

export const programAcceptance = pgTable(
  "program_acceptance",
  {
    ...baseFields("programAcceptance"),
    productId: text("product_id").notNull(),
    programId: text("program_id").notNull(),
    participantId: text("participant_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    termsId: text("terms_id").notNull(),
  },
  (table) => [
    unique("program_acceptance_user_version_unique").on(
      table.userId,
      table.programId,
      table.termsId,
    ),
    foreignKey({
      name: "program_acceptance_terms_scope_fk",
      columns: [table.productId, table.programId, table.termsId],
      foreignColumns: [
        programTerms.productId,
        programTerms.programId,
        programTerms.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "program_acceptance_owner_scope_fk",
      columns: [table.productId, table.participantId, table.userId],
      foreignColumns: [
        participant.productId,
        participant.id,
        participant.ownerUserId,
      ],
    }).onDelete("restrict"),
  ],
);
