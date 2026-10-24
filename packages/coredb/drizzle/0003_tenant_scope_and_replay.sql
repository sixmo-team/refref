-- Preserve existing account distinctions when upgrading older schema-push databases.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "banned" boolean;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_reason" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp;
--> statement-breakpoint
ALTER TABLE "apikey" RENAME COLUMN "user_id" TO "reference_id";
--> statement-breakpoint
ALTER TABLE "apikey" RENAME CONSTRAINT "apikey_user_id_user_id_fk" TO "apikey_reference_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "config_id" text NOT NULL DEFAULT 'default';
--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "apikey" ("reference_id");
--> statement-breakpoint
CREATE INDEX "apikey_config_id_idx" ON "apikey" ("config_id");
--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN "program_id" text CONSTRAINT "referral_program_id_program_id_fk" REFERENCES "program"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "referral_program_id_idx" ON "referral" ("program_id");
--> statement-breakpoint
-- Only existing, unambiguous and product-consistent associations prove a program.
UPDATE "referral" AS r SET "program_id" = proven.program_id
FROM (
  SELECT e.referral_id, min(e.program_id) AS program_id
  FROM "event" AS e
  JOIN "program" AS p ON p.id = e.program_id AND p.product_id = e.product_id
  JOIN "referral" AS r0 ON r0.id = e.referral_id
  JOIN "participant" AS referrer ON referrer.id = r0.referrer_id AND referrer.product_id = e.product_id
  GROUP BY e.referral_id
  HAVING count(DISTINCT e.program_id) = 1
) AS proven
WHERE r.id = proven.referral_id;
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "business_key" text;
--> statement-breakpoint
UPDATE "event" AS e SET "business_key" = e.metadata->>'orderId'
FROM "event_definition" AS d
WHERE d.id = e.event_definition_id AND d.type = 'purchase'
  AND length(e.metadata->>'orderId') BETWEEN 1 AND 200;
--> statement-breakpoint
-- Existing duplicate orders/rewards deliberately fail this migration: reconcile them,
-- never silently delete ledger entries or pretend repeated payouts are harmless.
CREATE UNIQUE INDEX "event_business_key_unique_idx" ON "event" ("product_id", "event_definition_id", "business_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "reward_event_rule_participant_unique_idx" ON "reward" ("event_id", "reward_rule_id", "participant_id");
