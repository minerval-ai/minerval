-- Artifacts (constitution §7b, #845): a fourth kind of node, made from
-- other nodes and judged for fidelity rather than truth. Lists first.
-- claims.kind admits 'artifact'; an artifact's specification lives in
-- artifact_specs and its judgment in artifact_assessments, the fifth table
-- of judgments, kept as the other four: one current version for each node
-- and label, read through artifact_assessments_in_force. The entries are
-- ordinary claim_relationships edges with relation_type 'draws_on', so
-- nothing new is needed for them.
--
-- The two functions that name every table of judgments are made again with
-- the new one beside the others (as 0148 made them): the rule of which
-- version is in force, and the enforcement step's list of the indexes that
-- say a node has one current judgment.
CREATE TABLE "artifact_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"fidelity" text NOT NULL,
	"summary" text,
	"reasoning_trace" text NOT NULL,
	"gaps" text,
	"entry_order" uuid[] DEFAULT '{}' NOT NULL,
	"left_out" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"marginal_yield" real,
	"model" text,
	"funded_by_job_id" uuid,
	"run_id" uuid,
	"inputs_recorded" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"trigger" text,
	"trigger_context" text,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "ck_artifact_assessments_origin" CHECK ("artifact_assessments"."origin" IN ('local', 'mirror')),
	CONSTRAINT "ck_artifact_assessments_fidelity" CHECK ("artifact_assessments"."fidelity" IN ('faithful', 'incomplete', 'misleading', 'ill_specified'))
);
--> statement-breakpoint
CREATE TABLE "artifact_specs" (
	"claim_id" uuid NOT NULL,
	"subtype" text DEFAULT 'list' NOT NULL,
	"purpose" text NOT NULL,
	"inclusion" text NOT NULL,
	"exclusion" text,
	"ordering" text,
	"entry_kinds" text[] DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "artifact_specs_claim_id_sensitivity_label_origin_pk" PRIMARY KEY("claim_id","sensitivity_label","origin"),
	CONSTRAINT "ck_artifact_specs_origin" CHECK ("artifact_specs"."origin" IN ('local', 'mirror')),
	CONSTRAINT "ck_artifact_specs_subtype" CHECK ("artifact_specs"."subtype" IN ('list'))
);
--> statement-breakpoint
ALTER TABLE "claims" DROP CONSTRAINT "ck_claims_kind";--> statement-breakpoint
ALTER TABLE "judgment_inputs" DROP CONSTRAINT "ck_judgment_inputs_judgment_kind";--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD CONSTRAINT "artifact_assessments_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD CONSTRAINT "artifact_assessments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "artifact_specs_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "artifact_specs_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_artifact_assessments_current" ON "artifact_assessments" USING btree ("claim_id") WHERE "artifact_assessments"."is_current" = true;--> statement-breakpoint
CREATE INDEX "idx_artifact_assessments_claim" ON "artifact_assessments" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_assessments_funded_by_job" ON "artifact_assessments" USING btree ("funded_by_job_id") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_kind" CHECK ("claims"."kind" IN ('claim', 'quantity', 'question', 'artifact'));--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_judgment_kind" CHECK ("judgment_inputs"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment', 'artifact_assessment', 'argument_evaluation', 'left_standing'));--> statement-breakpoint
CREATE VIEW "public"."artifact_assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "fidelity", "summary", "reasoning_trace", "gaps", "entry_order", "left_out", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", minerval_version_in_force('artifact_assessments', "claim_id", "sensitivity_label") as "in_force" from "artifact_assessments" where "artifact_assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."artifact_assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "fidelity", "summary", "reasoning_trace", "gaps", "entry_order", "left_out", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "artifact_assessments" where ("artifact_assessments"."is_current" = true and minerval_version_gone_by('artifact_assessments', "artifact_assessments"."claim_id", "artifact_assessments"."sensitivity_label")));
--> statement-breakpoint
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
  ELSIF judgments = 'artifact_assessments' THEN
    SELECT array_agg(j.sensitivity_label ORDER BY j.assessed_at DESC, j.id DESC) INTO present
      FROM public.artifact_assessments j
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
    'question_assessments', 'idx_question_assessments_current', 'claim_id',
    'artifact_assessments', 'idx_artifact_assessments_current', 'claim_id'];
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
    FOR n IN 1..cardinality(one_per_node) BY 3 LOOP
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
  FOR n IN 1..cardinality(one_per_node) BY 3 LOOP
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
-- Both new tables are mirrored (mirror-manifest.ts): a mirrored row is the
-- public graph's, written by the applier alone, as 0127 guards the others.
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "artifact_specs" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "artifact_specs" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "artifact_specs" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "artifact_assessments" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "artifact_assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "artifact_assessments" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();
--> statement-breakpoint
-- The new tables and views are held as every other is where a deployment
-- has more than one label.
SELECT public.minerval_enforcement_sync();
