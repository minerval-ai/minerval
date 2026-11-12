-- The mirror (docs/mirror.md, services/mirror-manifest.ts). A private
-- deployment keeps a read-only copy of the public graph in the same tables
-- as its own rows, fed by signed batches. This adds what that needs and
-- changes no behavior: every row that exists is 'local', the new tables are
-- empty, and the triggers below fire only for rows whose origin is 'mirror'.
--
--  - "origin" on the nineteen replicated tables: 'local' (the default, and
--    every row on the public graph) or 'mirror' (written by the applier).
--  - mirror_feed_batches and mirror_feed_rows, for a deployment that
--    publishes the feed; mirror_applied_batches, mirror_snapshot_rows and
--    mirror_refusals, for one that applies it.
--  - mirror_row_guard, at the end: nothing but the applier may write a
--    mirrored row's replicated columns.
CREATE TABLE "mirror_applied_batches" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"feed_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"part_first" bigint NOT NULL,
	"part_last" boolean NOT NULL,
	"migration_number" integer NOT NULL,
	"cut_at" timestamp with time zone NOT NULL,
	"previous_hash" text NOT NULL,
	"batch_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"publisher_web_base_url" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_from" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_feed_batches" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"feed_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"part_first" bigint NOT NULL,
	"part_last" boolean NOT NULL,
	"migration_number" integer NOT NULL,
	"migration_tag" text NOT NULL,
	"shape" text NOT NULL,
	"cut_at" timestamp with time zone NOT NULL,
	"previous_hash" text NOT NULL,
	"batch_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"row_count" integer NOT NULL,
	"removal_count" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mirror_feed_batches_kind" CHECK ("mirror_feed_batches"."kind" IN ('snapshot', 'changes'))
);
--> statement-breakpoint
CREATE TABLE "mirror_feed_rows" (
	"table_name" text NOT NULL,
	"row_key" text NOT NULL,
	"row_hash" text NOT NULL,
	"sequence" bigint NOT NULL,
	CONSTRAINT "mirror_feed_rows_table_name_row_key_pk" PRIMARY KEY("table_name","row_key")
);
--> statement-breakpoint
CREATE TABLE "mirror_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint,
	"batch_hash" text,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"received_from" text,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_snapshot_rows" (
	"table_name" text NOT NULL,
	"row_key" text NOT NULL,
	CONSTRAINT "mirror_snapshot_rows_table_name_row_key_pk" PRIMARY KEY("table_name","row_key")
);
--> statement-breakpoint
DROP VIEW "public"."argument_evaluations_in_force";--> statement-breakpoint
DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
DROP VIEW "public"."question_assessments_in_force";--> statement-breakpoint
ALTER TABLE "answer_relations" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_evaluations" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "arguments" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_links" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_interests" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_segments" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "origin" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mirror_feed_batches_hash" ON "mirror_feed_batches" USING btree ("batch_hash");--> statement-breakpoint
CREATE INDEX "idx_mirror_refusals_at" ON "mirror_refusals" USING btree ("refused_at");--> statement-breakpoint
ALTER TABLE "answer_relations" ADD CONSTRAINT "ck_answer_relations_origin" CHECK ("answer_relations"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "argument_evaluations" ADD CONSTRAINT "ck_argument_evaluations_origin" CHECK ("argument_evaluations"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "ck_argument_instances_origin" CHECK ("argument_instances"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "ck_argument_subclaims_origin" CHECK ("argument_subclaims"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "ck_arguments_origin" CHECK ("arguments"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessments_origin" CHECK ("assessments"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "ck_claim_instances_origin" CHECK ("claim_instances"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "ck_claim_links_origin" CHECK ("claim_links"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "ck_claim_relationships_origin" CHECK ("claim_relationships"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_origin" CHECK ("claims"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_origin" CHECK ("judgment_inputs"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "ck_quantity_cuts_origin" CHECK ("quantity_cuts"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD CONSTRAINT "ck_quantity_definitions_origin" CHECK ("quantity_definitions"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD CONSTRAINT "ck_quantity_estimates_origin" CHECK ("quantity_estimates"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD CONSTRAINT "ck_quantity_readings_origin" CHECK ("quantity_readings"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "question_assessments" ADD CONSTRAINT "ck_question_assessments_origin" CHECK ("question_assessments"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "source_interests" ADD CONSTRAINT "ck_source_interests_origin" CHECK ("source_interests"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "source_segments" ADD CONSTRAINT "ck_source_segments_origin" CHECK ("source_segments"."origin" IN ('local', 'mirror'));--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "ck_sources_origin" CHECK ("sources"."origin" IN ('local', 'mirror'));--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_in_force" AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label", "origin" from "argument_evaluations" where "argument_evaluations"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", "origin" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."question_assessments_in_force" AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "question_assessments" where "question_assessments"."is_current" = true);--> statement-breakpoint
-- The guard on mirrored rows. A row with origin 'mirror' is the public
-- graph's: nothing in this deployment may insert one, delete one, change its
-- origin, or change any column the feed carries. The applier says who it is
-- for the length of its transaction (set_config('minerval.mirror_applier',
-- 'on', true) in services/mirror-apply-service.ts) and is let through.
--
-- An update is allowed when only the columns named in the trigger's
-- arguments differ: those are this deployment's own working state on the
-- row (a claim's place in the Steward's queue, its tagging lease), and a
-- generated column, which a BEFORE trigger cannot yet see the new value of.
-- The arguments are the local and generated columns of
-- services/mirror-manifest.ts; tests/db/mirror-guard.test.ts fails when the
-- two differ. Every column not named is guarded, so a column added later is
-- guarded until someone decides otherwise.
--
-- Each trigger has a WHEN on the row's origin, so the function is not called
-- for a local row at all.
--
-- This stops a code path that forgets a row is mirrored. It does not stop
-- someone with SQL access who sets the setting by hand; holding sessions to
-- database roles comes with clearance.
CREATE FUNCTION mirror_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unguarded text[] := '{}';
  changed text;
BEGIN
  IF current_setting('minerval.mirror_applier', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a row with origin ''mirror'' can be written to "%" only by the mirror''s applier', TG_TABLE_NAME
      USING ERRCODE = 'MIR01', HINT = 'Rows this deployment makes are ''local'', which is the default.';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'this row of "%" is mirrored from the public graph and can be deleted only by the mirror''s applier', TG_TABLE_NAME
      USING ERRCODE = 'MIR01';
  END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'the origin of a row of "%" cannot be changed', TG_TABLE_NAME
      USING ERRCODE = 'MIR01';
  END IF;
  -- TG_ARGV is not an array that can be handed to an operator when the
  -- trigger has no arguments, so the names are gathered one by one.
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    unguarded := unguarded || TG_ARGV[i];
  END LOOP;
  SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO changed
    FROM jsonb_each(to_jsonb(NEW) - unguarded) n
   WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'this row of "%" is mirrored from the public graph, and only the mirror''s applier may change: %', TG_TABLE_NAME, changed
      USING ERRCODE = 'MIR01', HINT = 'A local view of a public claim is a judgment of this deployment''s own, never an edit of the mirrored row.';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "claims" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "claims" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard('queue_priority', 'steward_state', 'steward_trigger', 'steward_context', 'steward_error', 'steward_error_reason', 'stewarded_at', 'steward_requeued', 'steward_attempts', 'tagged_at', 'tagging_leased_at', 'tagging_attempts', 'updated_at', 'text_search');--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "claims" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "quantity_definitions" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "quantity_definitions" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "quantity_definitions" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "quantity_cuts" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "quantity_cuts" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "quantity_cuts" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "claim_relationships" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "claim_relationships" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "claim_relationships" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "claim_links" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "claim_links" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "claim_links" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "answer_relations" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "answer_relations" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "answer_relations" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "sources" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "sources" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "sources" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "source_segments" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "source_segments" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "source_segments" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "arguments" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "arguments" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "arguments" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "argument_subclaims" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "argument_subclaims" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "argument_subclaims" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "claim_instances" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "claim_instances" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "claim_instances" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "argument_instances" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "argument_instances" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "argument_instances" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "quantity_readings" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "quantity_readings" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "quantity_readings" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "assessments" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "quantity_estimates" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "quantity_estimates" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "quantity_estimates" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "question_assessments" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "question_assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "question_assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "argument_evaluations" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "argument_evaluations" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "argument_evaluations" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "source_interests" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "source_interests" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "source_interests" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "judgment_inputs" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "judgment_inputs" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "judgment_inputs" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();
