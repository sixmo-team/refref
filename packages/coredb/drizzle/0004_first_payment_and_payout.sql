-- Native custom Drizzle migration. Ambiguous preexisting scope is an operator remediation,
-- never deletion/re-attribution of financial history. No backend database references.
-- Old template saves cast valueType without converting the literal "percentage".
-- Both old engines treated that unknown unit as a flat amount, not a percentage.
UPDATE reward_rule r SET config=jsonb_set(r.config,'{reward,unit}','"fixed"'::jsonb)
FROM program p
WHERE p.id=r.program_id AND p.program_template_id IN ('single-sided','double-sided')
 AND r.config->>'schemaVersion'='1' AND r.config#>>'{reward,unit}'='percentage'
 AND (
  (r.type='referrer_purchase_reward' AND r.config#>>'{trigger,event}'='purchase'
   AND r.config->>'participantType'='referrer' AND r.config#>>'{reward,type}'='cash')
  OR
  (r.type='referee_signup_discount' AND r.config#>>'{trigger,event}'='signup'
   AND r.config->>'participantType'='referee' AND r.config#>>'{reward,type}'='discount')
 );
--> statement-breakpoint
ALTER TABLE participant ADD COLUMN first_purchase_event_id text,
 ADD COLUMN owner_user_id text CONSTRAINT participant_owner_user_id_user_id_fk REFERENCES "user"(id) ON DELETE RESTRICT,
 ADD COLUMN ownership_verified_by text CONSTRAINT participant_ownership_verified_by_user_id_fk REFERENCES "user"(id) ON DELETE RESTRICT,
 ADD COLUMN ownership_verified_at timestamptz, ADD COLUMN ownership_evidence text,
 ADD COLUMN payout_recipient jsonb;
--> statement-breakpoint
ALTER TABLE refcode ADD COLUMN is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE referral ADD COLUMN product_id text, ADD COLUMN refcode_id text, ADD COLUMN applied_code text;
--> statement-breakpoint
ALTER TABLE event ADD COLUMN occurred_at timestamptz;
--> statement-breakpoint
UPDATE referral r SET product_id=p.product_id FROM participant p WHERE p.id=r.referrer_id;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM referral r JOIN program p ON p.id=r.program_id WHERE r.product_id IS DISTINCT FROM p.product_id) THEN
 RAISE EXCEPTION 'Ambiguous legacy referral scope; repair with reviewed evidence before migration'; END IF;
 IF EXISTS(SELECT 1 FROM reward r JOIN program g ON g.id=r.program_id JOIN participant p ON p.id=r.participant_id LEFT JOIN event e ON e.id=r.event_id WHERE p.product_id IS DISTINCT FROM g.product_id OR (r.event_id IS NOT NULL AND (e.product_id IS DISTINCT FROM g.product_id OR e.program_id IS DISTINCT FROM r.program_id))) THEN
 RAISE EXCEPTION 'Ambiguous legacy reward scope; repair with reviewed evidence before migration'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE participant ADD CONSTRAINT participant_product_id_unique UNIQUE(product_id,id),
 ADD CONSTRAINT participant_product_id_owner_unique UNIQUE(product_id,id,owner_user_id);
--> statement-breakpoint
ALTER TABLE program ADD CONSTRAINT program_product_id_unique UNIQUE(product_id,id);
--> statement-breakpoint
ALTER TABLE reward_rule ADD CONSTRAINT reward_rule_program_id_unique UNIQUE(program_id,id);
--> statement-breakpoint
ALTER TABLE refcode ADD CONSTRAINT refcode_scope_unique UNIQUE(product_id,program_id,participant_id,id);
--> statement-breakpoint
ALTER TABLE referral ADD CONSTRAINT referral_product_id_unique UNIQUE(product_id,id),
 ADD CONSTRAINT referral_product_program_id_unique UNIQUE(product_id,program_id,id),
 ADD CONSTRAINT referral_scope_unique UNIQUE(product_id,program_id,referrer_id,id),
 ADD CONSTRAINT referral_product_id_product_id_fk FOREIGN KEY(product_id) REFERENCES product(id) ON DELETE RESTRICT,
 ADD CONSTRAINT referral_refcode_id_refcode_id_fk FOREIGN KEY(refcode_id) REFERENCES refcode(id) ON DELETE RESTRICT,
 ADD CONSTRAINT referral_referrer_scope_fk FOREIGN KEY(product_id,referrer_id) REFERENCES participant(product_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT referral_program_scope_fk FOREIGN KEY(product_id,program_id) REFERENCES program(product_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT referral_code_scope_fk FOREIGN KEY(product_id,program_id,referrer_id,refcode_id) REFERENCES refcode(product_id,program_id,participant_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT referral_code_pair_check CHECK ((refcode_id IS NULL)=(applied_code IS NULL) AND (refcode_id IS NULL OR (product_id IS NOT NULL AND program_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE event ADD CONSTRAINT event_owner_unique UNIQUE(product_id,participant_id,id),
 ADD CONSTRAINT event_product_id_unique UNIQUE(product_id,id),
 ADD CONSTRAINT event_program_id_unique UNIQUE(program_id,id),
 ADD CONSTRAINT event_program_scope_fk FOREIGN KEY(product_id,program_id) REFERENCES program(product_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT event_participant_scope_fk FOREIGN KEY(product_id,participant_id) REFERENCES participant(product_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT event_referral_scope_fk FOREIGN KEY(product_id,program_id,referral_id) REFERENCES referral(product_id,program_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT event_referral_product_scope_fk FOREIGN KEY(product_id,referral_id) REFERENCES referral(product_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE participant ADD CONSTRAINT participant_first_purchase_scope_fk FOREIGN KEY(product_id,id,first_purchase_event_id) REFERENCES event(product_id,participant_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE refcode ADD CONSTRAINT refcode_participant_scope_fk FOREIGN KEY(product_id,participant_id) REFERENCES participant(product_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT refcode_program_scope_fk FOREIGN KEY(product_id,program_id) REFERENCES program(product_id,id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE reward ADD CONSTRAINT reward_rule_scope_fk FOREIGN KEY(program_id,reward_rule_id) REFERENCES reward_rule(program_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT reward_event_program_scope_fk FOREIGN KEY(program_id,event_id) REFERENCES event(program_id,id) ON DELETE RESTRICT;
-- Replace native cascading financial edges with RESTRICT, preserving actual FK names.
--> statement-breakpoint
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conname, conrelid::regclass AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE contype='f' AND conrelid IN ('reward'::regclass,'event'::regclass,'referral'::regclass,'refcode'::regclass) AND confdeltype='c'
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname);
 EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.tbl,r.conname,replace(r.def,'ON DELETE CASCADE','ON DELETE RESTRICT')); END LOOP;
END $$;
-- Native legacy insertions derive their only provable product without fabricating code ownership.
--> statement-breakpoint
CREATE FUNCTION referral_scope_fill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.product_id IS NULL THEN SELECT product_id INTO NEW.product_id FROM participant WHERE id=NEW.referrer_id; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER referral_scope_fill BEFORE INSERT OR UPDATE ON referral FOR EACH ROW EXECUTE FUNCTION referral_scope_fill();
--> statement-breakpoint
CREATE FUNCTION reward_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p text; BEGIN
 SELECT product_id INTO p FROM program WHERE id=NEW.program_id;
 IF NOT EXISTS(SELECT 1 FROM participant WHERE id=NEW.participant_id AND product_id=p) OR
 (NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM event WHERE id=NEW.event_id AND product_id=p AND program_id=NEW.program_id)) THEN RAISE EXCEPTION 'Reward scope mismatch'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER reward_scope_guard BEFORE INSERT OR UPDATE ON reward FOR EACH ROW EXECUTE FUNCTION reward_scope_guard();
--> statement-breakpoint
ALTER TABLE participant ADD CONSTRAINT participant_verified_ownership_check CHECK (
 (owner_user_id IS NULL AND ownership_verified_by IS NULL AND ownership_verified_at IS NULL AND ownership_evidence IS NULL AND payout_recipient IS NULL)
 OR (owner_user_id IS NOT NULL AND ownership_verified_by IS NOT NULL AND ownership_verified_at IS NOT NULL AND ownership_evidence IS NOT NULL AND payout_recipient IS NOT NULL AND length(ownership_evidence)>0 AND jsonb_typeof(payout_recipient)='object'));
--> statement-breakpoint
CREATE UNIQUE INDEX participant_verified_owner_unique ON participant(product_id,owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE payout (
 id text PRIMARY KEY, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 product_id text NOT NULL CONSTRAINT payout_product_id_product_id_fk REFERENCES product(id) ON DELETE RESTRICT,
 participant_id text NOT NULL CONSTRAINT payout_participant_id_participant_id_fk REFERENCES participant(id) ON DELETE RESTRICT, currency text NOT NULL CHECK(currency IN ('USD','EUR','GBP','RUB')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','processing','completed','rejected')),
 idempotency_key text NOT NULL, requested_by text NOT NULL CONSTRAINT payout_requested_by_user_id_fk REFERENCES "user"(id) ON DELETE RESTRICT,
 assigned_to text CONSTRAINT payout_assigned_to_user_id_fk REFERENCES "user"(id) ON DELETE RESTRICT, confirmed_by text CONSTRAINT payout_confirmed_by_user_id_fk REFERENCES "user"(id) ON DELETE RESTRICT,
 recipient jsonb NOT NULL CHECK(jsonb_typeof(recipient)='object'), execution_method text,
 provider text, execution_namespace text, external_reference text, confirmation_key text, completed_at timestamptz,
 audit jsonb NOT NULL CHECK(jsonb_typeof(audit)='array' AND jsonb_array_length(audit)<=4),
 CONSTRAINT payout_owner_scope_fk FOREIGN KEY(product_id,participant_id) REFERENCES participant(product_id,id) ON DELETE RESTRICT,
 CONSTRAINT payout_request_owner_fk FOREIGN KEY(product_id,participant_id,requested_by) REFERENCES participant(product_id,id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT payout_completed_fields_check CHECK(status<>'completed' OR (assigned_to IS NOT NULL AND confirmed_by IS NOT NULL AND execution_method IS NOT NULL AND provider IS NOT NULL AND execution_namespace IS NOT NULL AND external_reference IS NOT NULL AND confirmation_key IS NOT NULL AND completed_at IS NOT NULL)),
 CONSTRAINT payout_processing_actor_check CHECK(status NOT IN ('processing','completed') OR assigned_to IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payout_request_unique_idx ON payout(product_id,participant_id,idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX payout_external_reference_unique_idx ON payout(execution_namespace,provider,external_reference);
--> statement-breakpoint
CREATE INDEX payout_owner_currency_status_date_idx ON payout(product_id,participant_id,currency,status,created_at);
--> statement-breakpoint
CREATE FUNCTION financial_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='payout' THEN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payout history cannot be deleted'; END IF;
 IF OLD.status IN ('completed','rejected') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal payout is immutable'; END IF;
 IF ROW(NEW.product_id,NEW.participant_id,NEW.amount_minor,NEW.currency,NEW.idempotency_key,NEW.requested_by,NEW.recipient) IS DISTINCT FROM ROW(OLD.product_id,OLD.participant_id,OLD.amount_minor,OLD.currency,OLD.idempotency_key,OLD.requested_by,OLD.recipient) THEN RAISE EXCEPTION 'Payout terms are immutable'; END IF;
 IF OLD.status='processing' AND ROW(NEW.assigned_to,NEW.execution_method,NEW.provider,NEW.execution_namespace) IS DISTINCT FROM ROW(OLD.assigned_to,OLD.execution_method,OLD.provider,OLD.execution_namespace) THEN RAISE EXCEPTION 'Claimed payout executor is immutable'; END IF;
 IF NEW.status<>OLD.status AND NOT ((OLD.status='requested' AND NEW.status IN ('processing','rejected')) OR (OLD.status='processing' AND NEW.status IN ('completed','rejected'))) THEN RAISE EXCEPTION 'Invalid payout transition'; END IF;
 ELSIF TG_TABLE_NAME='event' AND OLD.metadata->>'schemaVersion'='2' THEN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Purchase financial history cannot be deleted'; END IF;
 IF ROW(NEW.product_id,NEW.program_id,NEW.participant_id,NEW.referral_id,NEW.event_definition_id,NEW.business_key,NEW.metadata,NEW.occurred_at) IS DISTINCT FROM ROW(OLD.product_id,OLD.program_id,OLD.participant_id,OLD.referral_id,OLD.event_definition_id,OLD.business_key,OLD.metadata,OLD.occurred_at) THEN RAISE EXCEPTION 'Accepted purchase terms are immutable'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER payout_history_guard BEFORE UPDATE OR DELETE ON payout FOR EACH ROW EXECUTE FUNCTION financial_history_guard();
--> statement-breakpoint
CREATE TRIGGER purchase_history_guard BEFORE UPDATE OR DELETE ON event FOR EACH ROW EXECUTE FUNCTION financial_history_guard();
--> statement-breakpoint
ALTER TABLE event ADD CONSTRAINT purchase_v2_projection_check CHECK (
 metadata->>'schemaVersion'<>'2' OR COALESCE(
 metadata->>'source'='api' AND metadata->>'orderId'=business_key AND
 (metadata->>'orderAmountMinor')::bigint>0 AND
 metadata->>'currency'=metadata#>>'{referralSnapshot,pricing,currency}' AND
 metadata->>'orderAmountMinor'=metadata#>>'{referralSnapshot,pricing,payableAmountMinor}' AND
 metadata#>>'{referralSnapshot,schemaVersion}'='1' AND metadata#>>'{referralSnapshot,calculationVersion}'='1' AND
 metadata#>>'{referralSnapshot,attribution,productId}'=product_id AND
 metadata#>>'{referralSnapshot,attribution,programId}'=program_id AND participant_id IS NOT NULL AND referral_id IS NOT NULL AND occurred_at IS NOT NULL,false));
--> statement-breakpoint
ALTER TABLE event ADD CONSTRAINT event_metadata_version_check CHECK (metadata IS NULL OR COALESCE(jsonb_typeof(metadata)='object' AND (metadata->'schemaVersion'='1'::jsonb OR metadata->'schemaVersion'='2'::jsonb),false));
--> statement-breakpoint
ALTER TABLE event ADD CONSTRAINT purchase_v2_pricing_check CHECK (metadata->>'schemaVersion'<>'2' OR COALESCE((metadata#>>'{referralSnapshot,pricing,baseAmountMinor}')::bigint - (metadata#>>'{referralSnapshot,pricing,discountAmountMinor}')::bigint = (metadata#>>'{referralSnapshot,pricing,payableAmountMinor}')::bigint AND (metadata#>>'{referralSnapshot,pricing,discountAmountMinor}')::bigint >=0,false));

--> statement-breakpoint
CREATE FUNCTION participant_financial_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.first_purchase_event_id IS NOT NULL AND OLD.first_purchase_event_id IS NULL AND NOT EXISTS(SELECT 1 FROM event e JOIN event_definition d ON d.id=e.event_definition_id WHERE e.id=NEW.first_purchase_event_id AND e.product_id=NEW.product_id AND e.participant_id=NEW.id AND d.type='purchase') THEN RAISE EXCEPTION 'First-purchase claim must reference its native purchase'; END IF;
 IF OLD.first_purchase_event_id IS NOT NULL AND ROW(NEW.first_purchase_event_id,NEW.product_id,NEW.external_id) IS DISTINCT FROM ROW(OLD.first_purchase_event_id,OLD.product_id,OLD.external_id) THEN RAISE EXCEPTION 'First-purchase claim is immutable'; END IF;
 IF OLD.owner_user_id IS NOT NULL AND ROW(NEW.owner_user_id,NEW.ownership_verified_by,NEW.ownership_verified_at,NEW.ownership_evidence,NEW.payout_recipient,NEW.product_id,NEW.external_id) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.ownership_verified_by,OLD.ownership_verified_at,OLD.ownership_evidence,OLD.payout_recipient,OLD.product_id,OLD.external_id) THEN RAISE EXCEPTION 'Verified financial ownership is immutable'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER participant_financial_identity_guard BEFORE UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION participant_financial_identity_guard();
--> statement-breakpoint
CREATE FUNCTION refcode_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.code,NEW.product_id,NEW.program_id,NEW.participant_id) IS DISTINCT FROM ROW(OLD.code,OLD.product_id,OLD.program_id,OLD.participant_id) THEN RAISE EXCEPTION 'Code identity cannot be reassigned'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER refcode_identity_guard BEFORE UPDATE ON refcode FOR EACH ROW EXECUTE FUNCTION refcode_identity_guard();
--> statement-breakpoint
CREATE FUNCTION referral_financial_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.refcode_id IS NOT NULL AND ROW(NEW.product_id,NEW.program_id,NEW.referrer_id,NEW.external_id,NEW.refcode_id,NEW.applied_code) IS DISTINCT FROM ROW(OLD.product_id,OLD.program_id,OLD.referrer_id,OLD.external_id,OLD.refcode_id,OLD.applied_code) THEN RAISE EXCEPTION 'Accepted code attribution is immutable'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER referral_financial_identity_guard BEFORE UPDATE ON referral FOR EACH ROW EXECUTE FUNCTION referral_financial_identity_guard();
