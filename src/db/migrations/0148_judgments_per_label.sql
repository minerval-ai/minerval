CREATE TABLE "steward_slots" (
	"claim_id" uuid NOT NULL,
	"steward_state" text DEFAULT 'done' NOT NULL,
	"steward_trigger" text,
	"steward_error" text,
	"steward_error_reason" text,
	"stewarded_at" timestamp with time zone,
	"steward_requeued" boolean DEFAULT false NOT NULL,
	"steward_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "steward_slots_claim_id_sensitivity_label_pk" PRIMARY KEY("claim_id","sensitivity_label")
);
--> statement-breakpoint
DROP VIEW "public"."argument_evaluations_in_force";--> statement-breakpoint
DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
DROP VIEW "public"."question_assessments_in_force";--> statement-breakpoint
ALTER TABLE "judgment_inputs" DROP CONSTRAINT "ck_judgment_inputs_judgment_kind";--> statement-breakpoint
ALTER TABLE "judgment_inputs" DROP CONSTRAINT "ck_judgment_inputs_input_kind";--> statement-breakpoint
ALTER TABLE "judgment_inputs" DROP CONSTRAINT "ck_judgment_inputs_shape";--> statement-breakpoint
DROP INDEX "uq_orders_open_per_claim";--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD COLUMN "input_label" text;--> statement-breakpoint
ALTER TABLE "steward_slots" ADD CONSTRAINT "steward_slots_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_slots" ADD CONSTRAINT "steward_slots_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_steward_slots_pending" ON "steward_slots" USING btree ("sensitivity_label","updated_at") WHERE steward_state = 'pending';--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "judgment_inputs_input_label_labels_name_fk" FOREIGN KEY ("input_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_judgment_inputs_beside" ON "judgment_inputs" USING btree ("input_judgment_id") WHERE "judgment_inputs"."input_kind" = 'beside';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_open_per_claim" ON "assessment_orders" USING btree ("user_id","claim_id","sensitivity_label") WHERE status IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_judgment_kind" CHECK ("judgment_inputs"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment', 'argument_evaluation'));--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_input_kind" CHECK ("judgment_inputs"."input_kind" IN ('premise', 'source', 'beside'));--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_shape" CHECK (("judgment_inputs"."input_kind" = 'premise' AND "judgment_inputs"."node_id" IS NOT NULL AND "judgment_inputs"."relation_type" IS NOT NULL AND "judgment_inputs"."source_id" IS NULL)
        OR ("judgment_inputs"."input_kind" = 'source' AND "judgment_inputs"."source_id" IS NOT NULL AND "judgment_inputs"."node_id" IS NULL)
        OR ("judgment_inputs"."input_kind" = 'beside' AND "judgment_inputs"."input_judgment_id" IS NOT NULL AND "judgment_inputs"."input_label" IS NOT NULL AND "judgment_inputs"."node_id" IS NULL AND "judgment_inputs"."source_id" IS NULL));--> statement-breakpoint
-- A judgment at each label.
--
-- A node may carry one current judgment at each label, written by work at
-- that label and replaced only by it. The four judgment tables keep the
-- index they have, one current row for each node: on a deployment with one
-- label it still holds, and it is what tells the planner that a node has at
-- most one current row. Where a deployment has a second label the step
-- below drops it and creates the index that is one for each node and label
-- (<index>_at_label), and swaps them back when the last other label goes.
-- So this migration changes no index on a judgment table on the public
-- graph. This part
-- of the migration is written by hand: the one definition of which versions
-- are in force for whoever is reading, the functions the *_in_force and
-- *_versions views call, what the guards refuse now, and the step that turns
-- it all on where a deployment has a second label.
--
-- On the public graph, where 'public' is the only label, a node has one
-- version and nothing here runs: the two functions the views call are the
-- constant true, which the planner folds into the query, so each view is
-- planned exactly as the "where is_current" it was.
--
-- Whether a current version is in force for the connection reading it, and
-- whether it is the one a read that wants a single row for the node goes by.
--
--   0  beside: another current version this connection reads was made at a
--      label that reads this one's label, with sight of everything this one
--      saw and more
--   1  in force
--   2  in force, and the one a one-row read takes: where several are in
--      force (labels that do not read each other), the most recently made
--
-- The connection's clearance is its setting where it is the application's
-- (minerval_cleared), and the signed clearance of read-only SQL otherwise,
-- which for the tables' owner is every label. The function runs with its
-- owner's rights because read-only SQL has no right on the tables; it
-- applies the clearance itself, so it shows nothing the policies would not.
CREATE OR REPLACE FUNCTION minerval_version_standing(judgments text, node uuid, version_label text) RETURNS smallint
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  reads text[];
  present text[];
  standing text[];
BEGIN
  IF session_user = 'minerval_cleared' THEN
    reads := public.minerval_clearance();
  ELSE
    reads := public.minerval_sql_clearance();
  END IF;
  -- The labels with a current version on this node that the connection
  -- reads, most recently made first.
  IF judgments = 'assessments' THEN
    SELECT array_agg(j.sensitivity_label ORDER BY j.assessed_at DESC, j.id DESC) INTO present
      FROM public.assessments j
     WHERE j.claim_id = node AND j.is_current AND j.sensitivity_label = ANY (reads);
  ELSIF judgments = 'quantity_estimates' THEN
    SELECT array_agg(j.sensitivity_label ORDER BY j.assessed_at DESC, j.id DESC) INTO present
      FROM public.quantity_estimates j
     WHERE j.claim_id = node AND j.is_current AND j.sensitivity_label = ANY (reads);
  ELSIF judgments = 'question_assessments' THEN
    SELECT array_agg(j.sensitivity_label ORDER BY j.assessed_at DESC, j.id DESC) INTO present
      FROM public.question_assessments j
     WHERE j.claim_id = node AND j.is_current AND j.sensitivity_label = ANY (reads);
  ELSIF judgments = 'argument_evaluations' THEN
    SELECT array_agg(j.sensitivity_label ORDER BY j.created_at DESC, j.id DESC) INTO present
      FROM public.argument_evaluations j
     WHERE j.argument_id = node AND j.is_current AND j.sensitivity_label = ANY (reads);
  ELSE
    RAISE EXCEPTION 'minerval_version_standing: "%" is not a table of judgments', judgments;
  END IF;
  IF present IS NULL OR NOT (version_label = ANY (present)) THEN
    RETURN 0;
  END IF;
  IF cardinality(present) = 1 THEN
    RETURN 2;
  END IF;
  -- In force: no other version here was made at a label that reads this
  -- one's. Two labels that read each other stand level.
  SELECT array_agg(p.label ORDER BY p.ord) INTO standing
    FROM unnest(present) WITH ORDINALITY AS p(label, ord)
   WHERE NOT EXISTS (
           SELECT 1 FROM unnest(present) AS o(label)
            WHERE o.label <> p.label
              AND p.label = ANY (public.minerval_labels_readable_from(ARRAY[o.label]))
              AND NOT (o.label = ANY (public.minerval_labels_readable_from(ARRAY[p.label]))));
  IF standing IS NULL OR NOT (version_label = ANY (standing)) THEN
    RETURN 0;
  END IF;
  RETURN CASE WHEN standing[1] = version_label THEN 2 ELSE 1 END;
END
$$;
--> statement-breakpoint
-- What the views call. Each is the constant true while 'public' is the only
-- label, and is pointed at the rule above by the step that turns
-- enforcement on (minerval_enforcement_sync, below), which also points it
-- back when the last other label goes. A function of this form is folded
-- into the query that calls it, so on the public graph it costs nothing and
-- changes no plan.
CREATE OR REPLACE FUNCTION minerval_version_gone_by(judgments text, node uuid, version_label text) RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT true $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_version_in_force(judgments text, node uuid, version_label text) RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT true $$;
--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_versions" WITH (security_invoker = true) AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label", minerval_version_in_force('argument_evaluations', "argument_id", "sensitivity_label") as "in_force" from "argument_evaluations" where "argument_evaluations"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", minerval_version_in_force('assessments', "claim_id", "sensitivity_label") as "in_force" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", minerval_version_in_force('quantity_estimates', "claim_id", "sensitivity_label") as "in_force" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."question_assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", minerval_version_in_force('question_assessments', "claim_id", "sensitivity_label") as "in_force" from "question_assessments" where "question_assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_in_force" WITH (security_invoker = true) AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label" from "argument_evaluations" where ("argument_evaluations"."is_current" = true and minerval_version_gone_by('argument_evaluations', "argument_evaluations"."argument_id", "argument_evaluations"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label" from "assessments" where ("assessments"."is_current" = true and minerval_version_gone_by('assessments', "assessments"."claim_id", "assessments"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label" from "quantity_estimates" where ("quantity_estimates"."is_current" = true and minerval_version_gone_by('quantity_estimates', "quantity_estimates"."claim_id", "quantity_estimates"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."question_assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label" from "question_assessments" where ("question_assessments"."is_current" = true and minerval_version_gone_by('question_assessments', "question_assessments"."claim_id", "question_assessments"."sensitivity_label")));
-- Whether material at a label bears on a node: a source at that label
-- attached to it (by a live instance, or by a reading of an instrument), a
-- node at that label under it, or a node under it that carries a version at
-- that label. It reads the graph's structure as it stands, which is what a
-- judgment's recorded inputs are taken from the moment it is written
-- (judgment_inputs), so it says what that record will say.
--
-- This is the backstop behind a rule and decides nothing about the claim: a
-- version on a node that carries another label rests on material at the
-- version's own label, or is not stored. Whether a source really bears is
-- the Steward's judgment. The rule is only that it names one.
CREATE OR REPLACE FUNCTION minerval_material_at(node uuid, at_label text) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM public.claim_instances i
                   JOIN public.sources s ON s.id = i.source_id
                  WHERE i.claim_id = node AND i.detached_at IS NULL AND s.sensitivity_label = at_label)
      OR EXISTS (SELECT 1 FROM public.quantity_readings q
                   JOIN public.sources s ON s.id = q.source_id
                  WHERE q.claim_id = node AND s.sensitivity_label = at_label)
      OR EXISTS (SELECT 1 FROM public.claim_relationships r
                   JOIN public.claims c ON c.id = r.child_claim_id
                  WHERE r.parent_claim_id = node
                    AND (c.sensitivity_label = at_label
                         OR EXISTS (SELECT 1 FROM public.assessments j
                                     WHERE j.claim_id = c.id AND j.is_current AND j.sensitivity_label = at_label)
                         OR EXISTS (SELECT 1 FROM public.quantity_estimates j
                                     WHERE j.claim_id = c.id AND j.is_current AND j.sensitivity_label = at_label)
                         OR EXISTS (SELECT 1 FROM public.question_assessments j
                                     WHERE j.claim_id = c.id AND j.is_current AND j.sensitivity_label = at_label)))
$$;
--> statement-breakpoint
-- The ledger key of work on something several labels can work on (a node, a
-- document, a partition of the graph), at a label. Work at 'public' keeps
-- the key it always had. Work at another label has its own, so that it
-- neither waits on nor reopens another label's row. A space cannot occur in
-- a node's id, an address or a label's name, so the two never collide.
CREATE OR REPLACE FUNCTION minerval_group_at(base text, at_label text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE WHEN at_label = 'public' THEN base ELSE base || ' @' || at_label END $$;
--> statement-breakpoint
-- Each label's own version, and what it rests on.
--
-- On a cleared connection a version is retired, or brought back, only by
-- work at its own label: no label's work takes another's version out of
-- force. And a new version on a node that carries another label is recorded
-- only where material at the version's own label bears on the node
-- (minerval_material_at): with none there is nothing at that label to
-- judge, and the version this label reads stands for its readers. For an
-- argument's evaluation the node is the argument, and the material is what
-- bears on the argument's claim. A node's own label needs no such material:
-- a private node's first judgment is simply its judgment. The owner's
-- connection is not held to either.
CREATE OR REPLACE FUNCTION minerval_judgment_label_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  own text := COALESCE(NULLIF(current_setting('minerval.label', true), ''), 'public');
  node_column text := TG_ARGV[0];
  node uuid;
  claim uuid;
  node_label text;
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_current IS DISTINCT FROM NEW.is_current AND OLD.sensitivity_label <> own THEN
      RAISE EXCEPTION 'this version of the node''s judgment was recorded at another label, and this work may neither retire it nor bring it back'
        USING ERRCODE = 'MVL02',
              HINT = 'Each label keeps its own version of a node''s judgment, and a version is replaced only by work at its own label. Nothing was changed.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_current THEN
    EXECUTE format('SELECT ($1).%I', node_column) INTO node USING NEW;
    IF TG_TABLE_NAME = 'argument_evaluations' THEN
      SELECT a.sensitivity_label, a.claim_id INTO node_label, claim FROM public.arguments a WHERE a.id = node;
    ELSE
      claim := node;
      SELECT c.sensitivity_label INTO node_label FROM public.claims c WHERE c.id = node;
    END IF;
    IF node_label IS DISTINCT FROM NEW.sensitivity_label
       AND NOT public.minerval_material_at(claim, NEW.sensitivity_label) THEN
      RAISE EXCEPTION 'this version was not recorded: nothing at the label "%" bears on the node, which carries the label "%"',
          NEW.sensitivity_label, node_label
        USING ERRCODE = 'MVL07',
              HINT = 'A version on a node that carries another label rests on material at the version''s own label: a source at that label attached to the node, a node at that label under it, or a node under it with a version at that label. With none, the version this label reads stands for its readers. Nothing was recorded.';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A row's label does not change, with no exception.
--
-- The ledger used to move a finished row to the label of the work that
-- reopened it, because a group had one row whatever the label. Work on
-- something several labels can work on now has a key for each label
-- (minerval_group_at), so a row is only ever reopened by work at its own
-- label and the exception is gone.
CREATE OR REPLACE FUNCTION minerval_label_fixed_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a row''s label does not change: this row is at "%" and the update would have made it "%"',
      OLD.sensitivity_label, NEW.sensitivity_label
    USING ERRCODE = 'MVL04',
          TABLE = TG_TABLE_NAME,
          HINT = 'A row stays at the label it was written at. Moving one to a label more people read is a release, which is not built yet. Nothing was changed.';
END
$$;
--> statement-breakpoint
-- Work changes and deletes only rows at its own label.
--
-- The policy lets a cleared connection change any row it reads. With a
-- version of a judgment, a slot and a ledger row for each label, work at one
-- label has no need to change a row at another, and a change it did make
-- would be read by that row's readers as their own label's work: an
-- internal run rewording a public node. So on a cleared connection an
-- update or a delete of a row at a label other than the connection's own is
-- refused, and says so. It is a trigger and not a policy because a policy
-- would leave such a row out of the statement without a word, and the
-- caller would take nothing-changed for done.
--
-- What it lets through, and why:
--   - Settling money. What a run costs is split across every allocation
--     that pays for it, at whatever label each was placed, so settlement
--     changes the money columns of rows at other labels: on an allocation
--     its amount, what of it is spent and when it was released; on a
--     regrant its amount and what came back, and the delete that returns
--     one in full. No other column, and no other table.
--   - What follows from a foreign key. A row deleted or emptied because the
--     row it hangs from was deleted is the database's own act (the trigger
--     is then fired from inside another), as it was before.
-- The owner's connection is not held to it.
CREATE OR REPLACE FUNCTION minerval_own_label_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'minerval_cleared'
     OR OLD.sensitivity_label = public.minerval_write_label()
     OR pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'action_allocations' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - 'amount_micro_usd' - 'spent_micro_usd' - 'released_at')
       = (to_jsonb(NEW) - 'amount_micro_usd' - 'spent_micro_usd' - 'released_at') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'regrants' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF (to_jsonb(OLD) - 'amount_micro_usd' - 'refunded_micro_usd')
       = (to_jsonb(NEW) - 'amount_micro_usd' - 'refunded_micro_usd') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'this was not changed: the row is at the label "%" and this work is at "%"',
      OLD.sensitivity_label, public.minerval_write_label()
    USING ERRCODE = 'MVL06',
          TABLE = TG_TABLE_NAME,
          HINT = 'Work changes and deletes only rows at its own label. What another label holds is that label''s to change: record what this label has to say as a row of its own. Nothing was changed.';
END
$$;
--> statement-breakpoint
--> statement-breakpoint
-- The one step that turns enforcement on and off, as the enforcement
-- migration wrote it, with what a judgment at each label adds: the trigger
-- that holds a cleared connection's updates and deletes to rows at its own
-- label (own_label_guard) on every labelled table; the index that says a
-- node has one current judgment, which is one for each node and label
-- while a second label exists and one for each node otherwise; the node of
-- a judgment, read from that index; and the two functions the *_in_force
-- and *_versions views call, pointed at the rule in the one case and at
-- the constant true in the other.
CREATE OR REPLACE FUNCTION minerval_enforcement_sync(want boolean DEFAULT NULL) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  enforce boolean;
  t record;
  clearance_test constant text :=
    'sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[])';
  sql_test constant text :=
    'sensitivity_label = ANY ((SELECT public.minerval_sql_clearance())::text[])';
  -- What a clearance is made of, and what says who a request is (a key or
  -- a token is as good as the account it names): read by a cleared
  -- connection, written by the owner alone.
  -- The indexes that say a node has one current judgment: table, index and
  -- the node's column. One for each node holds where there is one label and
  -- gives the planner what it has always had there. Where there are more,
  -- it is one for each node and label, in an index of its own name.
  one_per_node constant text[] := ARRAY[
    'assessments', 'idx_assessments_current', 'claim_id',
    'argument_evaluations', 'idx_argument_evaluations_current', 'argument_id',
    'quantity_estimates', 'idx_quantity_estimates_current', 'claim_id',
    'question_assessments', 'idx_question_assessments_current', 'claim_id'];
  n int;
  wall constant text[] := ARRAY['labels', 'label_reads', 'permission_grants', 'account_groups',
                                'api_keys', 'oauth_tokens', 'oauth_clients', 'oauth_authorization_requests'];
  -- The administrators' log: read and added to, never changed.
  append_only constant text[] := ARRAY['administrative_events'];
BEGIN
  -- One at a time: several API tasks start together, and each runs this.
  PERFORM pg_advisory_xact_lock(hashtext('minerval:enforcement'));

  enforce := EXISTS (SELECT 1 FROM public.labels WHERE name <> 'public')
          OR want IS TRUE
          OR (want IS NULL AND public.minerval_enforcement_on());

  IF NOT enforce THEN
    FOR t IN
      SELECT c.relname, c.relrowsecurity,
             EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_clearance') AS has_clearance,
             EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_sql_read') AS has_sql,
             EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_own_insert') AS has_own,
             EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'judgment_label_guard') AS has_guard,
             EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'unseen_collision_guard') AS has_collision_guard,
             EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'label_fixed_guard') AS has_fixed_guard,
             EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'own_label_guard') AS has_own_guard
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
       ORDER BY c.relname
    LOOP
      IF t.has_clearance THEN
        EXECUTE format('DROP POLICY label_clearance ON public.%I', t.relname);
      END IF;
      IF t.has_sql THEN
        EXECUTE format('DROP POLICY label_sql_read ON public.%I', t.relname);
      END IF;
      IF t.has_own THEN
        EXECUTE format('DROP POLICY label_own_insert ON public.%I', t.relname);
      END IF;
      IF t.has_guard THEN
        EXECUTE format('DROP TRIGGER judgment_label_guard ON public.%I', t.relname);
      END IF;
      IF t.has_collision_guard THEN
        EXECUTE format('DROP TRIGGER unseen_collision_guard ON public.%I', t.relname);
      END IF;
      IF t.has_fixed_guard THEN
        EXECUTE format('DROP TRIGGER label_fixed_guard ON public.%I', t.relname);
      END IF;
      IF t.has_own_guard THEN
        EXECUTE format('DROP TRIGGER own_label_guard ON public.%I', t.relname);
      END IF;
      IF t.relrowsecurity THEN
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.relname);
        RETURN NEXT format('- %s: row-level security off', t.relname);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
                WHERE g.tgrelid = 'public.contributors'::pg_catalog.regclass AND g.tgname = 'identity_fixed_guard') THEN
      DROP TRIGGER identity_fixed_guard ON public.contributors;
    END IF;
    -- One label, one version of each judgment: a node has one current row
    -- again, and the index that says so is put back in place of the one
    -- that allowed a row for each label.
    FOR n IN 1..12 BY 3 LOOP
      IF to_regclass(format('public.%I', one_per_node[n + 1])) IS NULL THEN
        EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I USING btree (%I) WHERE is_current = true',
                       one_per_node[n + 1], one_per_node[n], one_per_node[n + 2]);
        RETURN NEXT format('- %s: one current judgment for each node again', one_per_node[n]);
      END IF;
      IF to_regclass(format('public.%I', one_per_node[n + 1] || '_at_label')) IS NOT NULL THEN
        EXECUTE format('DROP INDEX public.%I', one_per_node[n + 1] || '_at_label');
      END IF;
    END LOOP;
    -- And the views' test is the constant true again, folded into every
    -- query that reads them.
    IF (SELECT p.prosrc FROM pg_catalog.pg_proc p
         WHERE p.oid = 'public.minerval_version_gone_by(text, uuid, text)'::pg_catalog.regprocedure) !~ '^\s*SELECT true\s*$' THEN
      CREATE OR REPLACE FUNCTION public.minerval_version_gone_by(judgments text, node uuid, version_label text) RETURNS boolean
        LANGUAGE sql STABLE AS 'SELECT true';
      CREATE OR REPLACE FUNCTION public.minerval_version_in_force(judgments text, node uuid, version_label text) RETURNS boolean
        LANGUAGE sql STABLE AS 'SELECT true';
      RETURN NEXT '- versions in force: one label, so every current version is in force';
    END IF;
    RETURN;
  END IF;

  -- More than one label: a node may carry a current judgment at each, so
  -- the index is one for each node and label, and the one that allowed one
  -- for each node goes. This is done before the tables are covered below,
  -- so that the guard against unseen collisions is built on the index that
  -- is there.
  FOR n IN 1..12 BY 3 LOOP
    IF to_regclass(format('public.%I', one_per_node[n + 1] || '_at_label')) IS NULL THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I USING btree (%I, sensitivity_label) WHERE is_current = true',
                     one_per_node[n + 1] || '_at_label', one_per_node[n], one_per_node[n + 2]);
      RETURN NEXT format('+ %s: one current judgment for each node and label', one_per_node[n]);
    END IF;
    IF to_regclass(format('public.%I', one_per_node[n + 1])) IS NOT NULL THEN
      EXECUTE format('DROP INDEX public.%I', one_per_node[n + 1]);
    END IF;
  END LOOP;

  -- Which current versions of a judgment are in force depends on who is
  -- reading (minerval_version_standing).
  IF (SELECT p.prosrc FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.minerval_version_gone_by(text, uuid, text)'::pg_catalog.regprocedure) !~ 'minerval_version_standing' THEN
    CREATE OR REPLACE FUNCTION public.minerval_version_gone_by(judgments text, node uuid, version_label text) RETURNS boolean
      LANGUAGE sql STABLE AS 'SELECT public.minerval_version_standing($1, $2, $3) = 2';
    CREATE OR REPLACE FUNCTION public.minerval_version_in_force(judgments text, node uuid, version_label text) RETURNS boolean
      LANGUAGE sql STABLE AS 'SELECT public.minerval_version_standing($1, $2, $3) >= 1';
    RETURN NEXT '+ versions in force: read by each connection''s clearance';
  END IF;

  IF NOT has_schema_privilege('minerval_cleared', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO minerval_cleared;
  END IF;
  IF NOT has_schema_privilege('minerval_sql_views', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO minerval_sql_views;
  END IF;
  IF NOT has_schema_privilege('minerval_cleared', 'minerval_readable', 'USAGE') THEN
    GRANT USAGE ON SCHEMA minerval_readable TO minerval_cleared;
  END IF;
  IF NOT has_schema_privilege('minerval_cleared', 'minerval_whole', 'USAGE') THEN
    GRANT USAGE ON SCHEMA minerval_whole TO minerval_cleared;
  END IF;

  -- Tables: cover, then grant.
  FOR t IN
    SELECT c.oid, c.relname, c.relrowsecurity,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped) AS labelled,
           EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_clearance') AS has_clearance,
           EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_sql_read') AS has_sql,
           EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_own_insert') AS has_own,
           EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'judgment_label_guard') AS has_guard,
           EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'label_fixed_guard') AS has_fixed_guard,
           EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'own_label_guard') AS has_own_guard,
           -- The node a judgment is of: the first column of the unique index
           -- over the current rows, which is one for each node and label.
           -- Null on a table that holds no judgments.
           (SELECT a.attname::text
              FROM pg_catalog.pg_index i
              JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
             WHERE i.indrelid = c.oid AND i.indisunique AND i.indnatts = 2 AND i.indpred IS NOT NULL
               AND pg_get_expr(i.indpred, i.indrelid) LIKE '%is_current%'
               AND (SELECT l.attname FROM pg_catalog.pg_attribute l
                     WHERE l.attrelid = i.indrelid AND l.attnum = i.indkey[1]) = 'sensitivity_label'
             ORDER BY i.indexrelid
             LIMIT 1) AS judged_node,
           -- The unique indexes a collision could happen on, as the guard
           -- takes them: columns, then predicate, for each. Indexes over
           -- expressions and a lone id are left out.
           (SELECT array_agg(part ORDER BY ix.relname, ord)
              FROM pg_catalog.pg_index i
              JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
              CROSS JOIN LATERAL (
                VALUES (1, (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord)
                              FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                              JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                             WHERE k.ord <= i.indnkeyatts)),
                       (2, COALESCE(pg_get_expr(i.indpred, i.indrelid), ''))
              ) AS parts(ord, part)
             WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid
               AND NOT (0 = ANY (i.indkey::int2[]))
               AND NOT (i.indnkeyatts = 1 AND i.indpred IS NULL
                        AND (SELECT a.attname FROM pg_catalog.pg_attribute a
                              WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id')
           ) AS collision_keys,
           (SELECT array_remove(string_to_array(encode(g.tgargs, 'escape'), '\000'), NULL)
              FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'unseen_collision_guard') AS guarded_keys
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  LOOP
    IF t.labelled THEN
      IF NOT t.relrowsecurity THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
        RETURN NEXT format('+ %s: row-level security on', t.relname);
      END IF;
      IF NOT t.has_clearance THEN
        EXECUTE format(
          'CREATE POLICY label_clearance ON public.%I AS PERMISSIVE FOR ALL TO minerval_cleared USING (%s) WITH CHECK (%s)',
          t.relname, clearance_test, clearance_test);
      END IF;
      IF NOT t.has_sql THEN
        EXECUTE format(
          'CREATE POLICY label_sql_read ON public.%I AS PERMISSIVE FOR SELECT TO minerval_sql_views USING (%s)',
          t.relname, sql_test);
      END IF;
      IF NOT t.has_own THEN
        EXECUTE format(
          'CREATE POLICY label_own_insert ON public.%I AS RESTRICTIVE FOR INSERT TO minerval_cleared '
          'WITH CHECK (sensitivity_label = public.minerval_write_label())',
          t.relname);
      END IF;
      IF NOT t.has_fixed_guard THEN
        EXECUTE format(
          'CREATE TRIGGER label_fixed_guard BEFORE UPDATE OF sensitivity_label ON public.%I '
          'FOR EACH ROW WHEN (OLD.sensitivity_label IS DISTINCT FROM NEW.sensitivity_label) '
          'EXECUTE FUNCTION public.minerval_label_fixed_guard()',
          t.relname);
      END IF;
      IF NOT t.has_own_guard THEN
        EXECUTE format(
          'CREATE TRIGGER own_label_guard BEFORE UPDATE OR DELETE ON public.%I '
          'FOR EACH ROW EXECUTE FUNCTION public.minerval_own_label_guard()',
          t.relname);
      END IF;
      IF t.judged_node IS NOT NULL AND NOT t.has_guard THEN
        EXECUTE format(
          'CREATE TRIGGER judgment_label_guard BEFORE INSERT OR UPDATE OF is_current ON public.%I '
          'FOR EACH ROW EXECUTE FUNCTION public.minerval_judgment_label_guard(%L)',
          t.relname, t.judged_node);
      END IF;
      -- The trigger's arguments end with an empty one in the catalog's form.
      IF t.collision_keys IS DISTINCT FROM t.guarded_keys[1:cardinality(t.guarded_keys) - 1] THEN
        IF t.guarded_keys IS NOT NULL THEN
          EXECUTE format('DROP TRIGGER unseen_collision_guard ON public.%I', t.relname);
        END IF;
        IF t.collision_keys IS NOT NULL THEN
          EXECUTE format(
            'CREATE TRIGGER unseen_collision_guard BEFORE INSERT ON public.%I '
            'FOR EACH ROW EXECUTE FUNCTION public.minerval_unseen_collision_guard(%s)',
            t.relname,
            (SELECT string_agg(quote_literal(k), ', ' ORDER BY ord) FROM unnest(t.collision_keys) WITH ORDINALITY AS u(k, ord)));
        END IF;
      END IF;
    END IF;
    IF t.relname = ANY (wall) OR t.relname = ANY (append_only) THEN
      IF NOT has_table_privilege('minerval_cleared', t.oid, 'SELECT') THEN
        EXECUTE format('GRANT SELECT ON public.%I TO minerval_cleared', t.relname);
        RETURN NEXT format('+ %s: minerval_cleared may read it', t.relname);
      END IF;
      IF t.relname = ANY (append_only) AND NOT has_table_privilege('minerval_cleared', t.oid, 'INSERT') THEN
        EXECUTE format('GRANT INSERT ON public.%I TO minerval_cleared', t.relname);
      END IF;
      IF has_table_privilege('minerval_cleared', t.oid, 'UPDATE')
         OR has_table_privilege('minerval_cleared', t.oid, 'DELETE')
         OR has_table_privilege('minerval_cleared', t.oid, 'TRUNCATE')
         OR (t.relname = ANY (wall) AND has_table_privilege('minerval_cleared', t.oid, 'INSERT')) THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM minerval_cleared', t.relname);
        IF t.relname = ANY (append_only) THEN
          EXECUTE format('GRANT INSERT ON public.%I TO minerval_cleared', t.relname);
        END IF;
        RETURN NEXT format('+ %s: minerval_cleared may no longer change it', t.relname);
      END IF;
    ELSIF NOT (has_table_privilege('minerval_cleared', t.oid, 'SELECT')
            AND has_table_privilege('minerval_cleared', t.oid, 'INSERT')
            AND has_table_privilege('minerval_cleared', t.oid, 'UPDATE')
            AND has_table_privilege('minerval_cleared', t.oid, 'DELETE')) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO minerval_cleared', t.relname);
      RETURN NEXT format('+ %s: granted to minerval_cleared', t.relname);
    END IF;
    IF NOT has_table_privilege('minerval_sql_views', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO minerval_sql_views', t.relname);
    END IF;
  END LOOP;

  -- The column that says which sign-in an account is.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
                  WHERE g.tgrelid = 'public.contributors'::pg_catalog.regclass AND g.tgname = 'identity_fixed_guard') THEN
    CREATE TRIGGER identity_fixed_guard BEFORE UPDATE OF external_id ON public.contributors
      FOR EACH ROW WHEN (OLD.external_id IS DISTINCT FROM NEW.external_id)
      EXECUTE FUNCTION public.minerval_identity_fixed_guard();
  END IF;

  -- Sequences the tables draw from.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
     ORDER BY c.relname
  LOOP
    IF NOT has_sequence_privilege('minerval_cleared', t.oid, 'USAGE') THEN
      EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO minerval_cleared', t.relname);
    END IF;
  END LOOP;

  -- Views in public read their tables with their caller's rights.
  FOR t IN
    SELECT c.oid, c.relname,
           COALESCE((SELECT option_value = 'true' FROM pg_catalog.pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), false) AS invoker
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    IF NOT t.invoker THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', t.relname);
      RETURN NEXT format('+ view %s: reads with its caller''s rights', t.relname);
    END IF;
    IF NOT has_table_privilege('minerval_cleared', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO minerval_cleared', t.relname);
    END IF;
    IF NOT has_table_privilege('minerval_sql_views', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO minerval_sql_views', t.relname);
    END IF;
  END LOOP;

  -- The views that apply the clearance themselves.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'minerval_readable' AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    IF NOT has_table_privilege('minerval_cleared', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON minerval_readable.%I TO minerval_cleared', t.relname);
    END IF;
  END LOOP;

  -- The views that show the ledger's money whole, to read and to settle through.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'minerval_whole' AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    IF NOT has_table_privilege('minerval_cleared', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON minerval_whole.%I TO minerval_cleared', t.relname);
    END IF;
    -- Never the whole row: only the columns that settling money writes.
    IF has_table_privilege('minerval_cleared', t.oid, 'UPDATE')
       OR has_table_privilege('minerval_cleared', t.oid, 'INSERT')
       OR has_table_privilege('minerval_cleared', t.oid, 'TRUNCATE')
       OR (has_table_privilege('minerval_cleared', t.oid, 'DELETE') AND t.relname <> 'regrant_money') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON minerval_whole.%I FROM minerval_cleared', t.relname);
      RETURN NEXT format('+ minerval_whole.%s: minerval_cleared may change its money columns only', t.relname);
    END IF;
    IF t.relname = 'allocation_money'
       AND NOT (has_column_privilege('minerval_cleared', t.oid, 'amount_micro_usd', 'UPDATE')
                AND has_column_privilege('minerval_cleared', t.oid, 'spent_micro_usd', 'UPDATE')
                AND has_column_privilege('minerval_cleared', t.oid, 'released_at', 'UPDATE')) THEN
      GRANT UPDATE (amount_micro_usd, spent_micro_usd, released_at) ON minerval_whole.allocation_money TO minerval_cleared;
    END IF;
    IF t.relname = 'regrant_money' THEN
      IF NOT (has_column_privilege('minerval_cleared', t.oid, 'amount_micro_usd', 'UPDATE')
              AND has_column_privilege('minerval_cleared', t.oid, 'refunded_micro_usd', 'UPDATE')) THEN
        GRANT UPDATE (amount_micro_usd, refunded_micro_usd) ON minerval_whole.regrant_money TO minerval_cleared;
      END IF;
      IF NOT has_table_privilege('minerval_cleared', t.oid, 'DELETE') THEN
        GRANT DELETE ON minerval_whole.regrant_money TO minerval_cleared;
      END IF;
    END IF;
  END LOOP;

  -- Temporary tables: the database owner's alone. Where this function's
  -- owner does not own the database the revoke does nothing but warn, and
  -- the enforcement check at startup reports it.
  IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    IF NOT has_database_privilege('public', current_database(), 'TEMPORARY') THEN
      RETURN NEXT '+ temporary tables: no longer anyone''s to make but the database owner''s';
    END IF;
  END IF;

  -- Read-only SQL: the views it reads are owned by a role the policies bind.
  FOR t IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public_read' AND c.relkind = 'v'
       AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'minerval_sql_views')
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER VIEW public_read.%I OWNER TO minerval_sql_views', t.relname);
    RETURN NEXT format('+ public_read.%s: owned by minerval_sql_views', t.relname);
  END LOOP;
  RETURN;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION minerval_enforcement_sync(boolean) FROM PUBLIC;
--> statement-breakpoint
-- Read-only SQL: is_current now says which version a reader goes by.
--
-- public_read.assessments has always served every assessment with a flag
-- for the current one, and a query written against it takes "is_current" to
-- pick the one row a node is judged by. With a version at each label, the
-- flag is true for the version the session's clearance goes by (the same
-- rule as the views in public) and false for the rest, another label's
-- current version included, so such a query still gets one row. The
-- columns are unchanged. On the public graph the test is the constant true
-- and the view is what it was.
CREATE OR REPLACE VIEW public_read.assessments AS
SELECT a.id, a.claim_id AS node_id, a.status, a.confidence, a.claim_credence AS credence, a.marginal_yield,
       (a.is_current AND public.minerval_version_gone_by('assessments', a.claim_id, a.sensitivity_label)) AS is_current,
       a.assessed_at, a.trigger, a.summary, left(a.reasoning_trace, 500) AS reasoning_head,
       a.relabeled_from
  FROM assessments a;
--> statement-breakpoint
-- Ledger rows that work at a label other than 'public' opened before each
-- label had its own key: the row, the money placed on it and a scoped
-- ingest's focus move to that label's key together. The public graph has no
-- such row and nothing is scanned there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.labels WHERE name <> 'public') THEN
    UPDATE public.action_allocations al
       SET exclusion_group = public.minerval_group_at(al.exclusion_group, a.sensitivity_label)
      FROM (SELECT DISTINCT exclusion_group, sensitivity_label FROM public.actions
             WHERE sensitivity_label <> 'public'
               AND kind IN ('assess', 'reassess', 'curate', 'formalize', 'ingest', 'consistency_sweep')
               AND exclusion_group NOT LIKE '% @%') a
     WHERE al.exclusion_group = a.exclusion_group;
    UPDATE public.ingest_focuses f
       SET exclusion_group = public.minerval_group_at(f.exclusion_group, f.sensitivity_label)
     WHERE f.sensitivity_label <> 'public' AND f.exclusion_group NOT LIKE '% @%';
    UPDATE public.actions
       SET exclusion_group = public.minerval_group_at(exclusion_group, sensitivity_label)
     WHERE sensitivity_label <> 'public'
       AND kind IN ('assess', 'reassess', 'curate', 'formalize', 'ingest', 'consistency_sweep')
       AND exclusion_group NOT LIKE '% @%';
  END IF;
END $$;
--> statement-breakpoint
-- Run the step: on a database that already has a second label it installs
-- the new trigger, points the views' functions at the rule and hands the
-- replaced public_read view to the role the policies bind. On the public
-- graph it finds one label and changes nothing.
SELECT public.minerval_enforcement_sync();
