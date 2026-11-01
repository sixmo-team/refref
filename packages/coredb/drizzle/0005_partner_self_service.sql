CREATE TABLE "program_acceptance" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" text NOT NULL,
	"program_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"terms_id" text NOT NULL,
	CONSTRAINT "program_acceptance_user_version_unique" UNIQUE("user_id","program_id","terms_id")
);
--> statement-breakpoint
CREATE TABLE "program_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" text NOT NULL,
	"program_id" text NOT NULL,
	"body" text NOT NULL,
	"reward_config" jsonb NOT NULL,
	"terms_fingerprint" text NOT NULL,
	"published_by" text NOT NULL,
	CONSTRAINT "program_terms_scope_unique" UNIQUE("product_id","program_id","id"),
	CONSTRAINT "program_terms_body_check" CHECK (length(trim("program_terms"."body")) BETWEEN 200 AND 30000)
);
--> statement-breakpoint
ALTER TABLE "participant" DROP CONSTRAINT "participant_verified_ownership_check";--> statement-breakpoint
ALTER TABLE "program_acceptance" ADD CONSTRAINT "program_acceptance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_acceptance" ADD CONSTRAINT "program_acceptance_terms_scope_fk" FOREIGN KEY ("product_id","program_id","terms_id") REFERENCES "public"."program_terms"("product_id","program_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_acceptance" ADD CONSTRAINT "program_acceptance_owner_scope_fk" FOREIGN KEY ("product_id","participant_id","user_id") REFERENCES "public"."participant"("product_id","id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_terms" ADD CONSTRAINT "program_terms_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_terms" ADD CONSTRAINT "program_terms_program_scope_fk" FOREIGN KEY ("product_id","program_id") REFERENCES "public"."program"("product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_verified_ownership_check" CHECK (("participant"."owner_user_id" IS NULL AND "participant"."ownership_verified_by" IS NULL AND "participant"."ownership_verified_at" IS NULL AND "participant"."ownership_evidence" IS NULL AND "participant"."payout_recipient" IS NULL) OR ("participant"."owner_user_id" IS NOT NULL AND "participant"."ownership_verified_by" IS NOT NULL AND "participant"."ownership_verified_at" IS NOT NULL AND ("participant"."ownership_evidence" IS NULL OR length("participant"."ownership_evidence")>0) AND ("participant"."payout_recipient" IS NULL OR jsonb_typeof("participant"."payout_recipient")='object')));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION participant_financial_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.first_purchase_event_id IS NOT NULL AND OLD.first_purchase_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM event e JOIN event_definition d ON d.id=e.event_definition_id WHERE e.id=NEW.first_purchase_event_id AND e.product_id=NEW.product_id AND e.participant_id=NEW.id AND d.type='purchase') THEN RAISE EXCEPTION 'First-purchase claim must reference its native purchase'; END IF;
 IF OLD.first_purchase_event_id IS NOT NULL AND ROW(NEW.first_purchase_event_id,NEW.product_id,NEW.external_id) IS DISTINCT FROM ROW(OLD.first_purchase_event_id,OLD.product_id,OLD.external_id) THEN RAISE EXCEPTION 'First-purchase claim is immutable'; END IF;
 IF OLD.owner_user_id IS NOT NULL AND ROW(NEW.owner_user_id,NEW.ownership_verified_by,NEW.ownership_verified_at,NEW.ownership_evidence,NEW.product_id,NEW.external_id) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.ownership_verified_by,OLD.ownership_verified_at,OLD.ownership_evidence,OLD.product_id,OLD.external_id) THEN RAISE EXCEPTION 'Verified financial ownership is immutable'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE FUNCTION program_rules_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Published programme rules and acceptances are immutable';
 END $$;
--> statement-breakpoint
CREATE TRIGGER program_terms_history_guard BEFORE UPDATE OR DELETE ON program_terms FOR EACH ROW EXECUTE FUNCTION program_rules_history_guard();
--> statement-breakpoint
CREATE TRIGGER program_acceptance_history_guard BEFORE UPDATE OR DELETE ON program_acceptance FOR EACH ROW EXECUTE FUNCTION program_rules_history_guard();