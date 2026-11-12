-- Holding reads and writes to a clearance (src/db/clearance.ts).
--
-- Everything here is inert until a deployment defines a second label. On the
-- public graph, where 'public' is the only label, no table has row-level
-- security, no policy exists, nothing connects as the roles below, and the
-- one thing that runs is the column default, which answers 'public'.
--
-- What this migration adds:
--
--  1. Three settings a connection may carry, read by the functions below:
--     minerval.clearance (the labels it may read, as an array literal),
--     minerval.label (the label it writes at), and minerval.sql_clearance
--     (a signed clearance for read-only SQL).
--  2. The default of every sensitivity_label column becomes
--     minerval_default_label(): the connection's label, so a forgotten stamp
--     lands where the stamp would have put it.
--  3. Two roles with no login. minerval_cleared is the role every
--     connection that is held to a clearance logs in as; it owns nothing,
--     so row-level security binds it. minerval_sql_views comes to own the
--     public_read views, so that read-only SQL is held too.
--  4. minerval_enforcement_sync(), the one step that turns enforcement on
--     and off: on every table with a sensitivity_label column it enables
--     row-level security and creates the policies, or removes them. It
--     reads the catalog, so a table added by a later migration is covered
--     the next time it runs, and it changes nothing that is already right.
--  5. A trigger on labels that runs the step when a label is added or
--     removed, so a second label cannot exist without enforcement.
--
-- The table owner is not bound by the policies (row-level security is
-- enabled, not forced). The owner is the role migrations run as and the
-- role named system work connects as (withSystemClearance), and both must
-- see every row.
CREATE OR REPLACE FUNCTION minerval_clearance() RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  -- 'public' is readable on every connection, whatever the setting says,
  -- and is all a connection reads when it carries no setting.
  SELECT ARRAY['public'] || COALESCE(NULLIF(current_setting('minerval.clearance', true), '')::text[], '{}'::text[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_default_label() RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  own text := NULLIF(current_setting('minerval.label', true), '');
BEGIN
  IF own IS NOT NULL THEN
    RETURN own;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.labels WHERE name <> 'public') THEN
    RETURN 'public';
  END IF;
  RAISE EXCEPTION 'a row was written without a label, on a connection that carries none'
    USING ERRCODE = 'MVL01',
          HINT = 'This deployment has more than one label, so a row is never public by omission. Name sensitivity_label in the insert, or run the work at a label (runAtLabel).';
END
$$;
--> statement-breakpoint
-- Every label readable from the ones given: the labels themselves, each
-- label one of them reads, and so on to the end of label_reads. 'public' is
-- always in the answer. The one definition of what a clearance is, for a
-- person's grants (services/permission-service.ts) and for a run's label
-- (db/clearance.ts) alike.
CREATE OR REPLACE FUNCTION minerval_labels_readable_from(held text[]) RETURNS text[]
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE reach(label) AS (
    SELECT 'public'
    UNION
    SELECT unnest(held)
    UNION
    SELECT lr.reads FROM public.label_reads lr JOIN reach r ON lr.label = r.label
  )
  SELECT COALESCE(array_agg(label), '{}'::text[]) FROM reach WHERE label IS NOT NULL
$$;
--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_finding_sightings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_findings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_report_sightings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_reports" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "agent_steps" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "answer_relations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "appeals" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "arbitration_results" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "argument_evaluations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "argument_evidence_backlog" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "argument_instances" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "argument_subclaims" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "arguments" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "assessment_orders" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "assistant_conversations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "assistant_held_actions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "assistant_pages" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "audit_findings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "audit_notes" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "audit_runs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "bounties" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "budget_jobs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_formalizations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_instance_reading_log" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_instance_readings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_instances" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_links" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_predictions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_provenance_roots" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_relationships" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claim_source_maps" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "consistency_flags" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "consistency_sweeps" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "contribution_reviews" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "contributions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "correspondent_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "correspondent_plan_items" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "correspondent_updates" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "correspondents" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "curation_requests" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "enqueue_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "examination_coverage" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "examination_findings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "examinations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "grant_conversations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "grant_sources" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "ingest_focuses" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "judgment_inputs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lean_checks" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lookout_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lookout_feed_items" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lookout_feeds" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lookout_flags" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "lookouts" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "mandate_decisions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "mandate_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "mandate_inbox" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "mandate_policy_versions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "node_messages" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "petitions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "prize_claims" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "proof_attempts" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "quantity_cuts" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "quantity_definitions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "quantity_estimates" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "quantity_readings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "question_assessments" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "reading_citations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "reconciliation_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "reputation_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "request_targets" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "request_work" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "research_runs" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "setup_parts" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "shared_page_analyses" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "source_events" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "source_extractions" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "source_interests" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "source_relationships" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "source_segments" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "taggings" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_name_plain" CHECK ("labels"."name" ~ '^[a-z][a-z0-9_-]{0,62}$');
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minerval_cleared') THEN
    CREATE ROLE minerval_cleared NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minerval_sql_views') THEN
    CREATE ROLE minerval_sql_views NOLOGIN NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
-- The owner hands the public_read views to minerval_sql_views when
-- enforcement turns on, and later migrations replace those views, so the
-- owner must be able to act as that role. A superuser already can; an owner
-- that only created the role needs the membership spelled out.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT minerval_sql_views TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public_read TO minerval_sql_views;
--> statement-breakpoint
-- The key read-only SQL's clearance is signed with (minerval_sql_clearance
-- below). It sits in a schema nothing is granted on, so only the owner and
-- the function that checks a signature can read it.
CREATE SCHEMA IF NOT EXISTS minerval_private;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS minerval_private.sql_clearance_key (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  key text NOT NULL
);
--> statement-breakpoint
INSERT INTO minerval_private.sql_clearance_key (key)
VALUES (encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The labels a read-only SQL session may read through the public_read
-- views. Whoever writes that SQL can set any setting, so the clearance is
-- not taken from one on trust: the service signs "expiry.pid.labels" with
-- the key above and passes it in minerval.sql_clearance, and this function
-- returns the labels only when the signature is right, the token has not
-- expired and it was made for this very backend. Anything else, a missing
-- token included, reads 'public' alone.
CREATE OR REPLACE FUNCTION minerval_sql_clearance() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  token text := NULLIF(current_setting('minerval.sql_clearance', true), '');
  parts text[];
  k text;
  signed text;
BEGIN
  IF token IS NULL THEN
    RETURN ARRAY['public'];
  END IF;
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) IS DISTINCT FROM 4 THEN
    RETURN ARRAY['public'];
  END IF;
  SELECT key INTO k FROM minerval_private.sql_clearance_key;
  IF k IS NULL THEN
    RETURN ARRAY['public'];
  END IF;
  signed := parts[1] || '.' || parts[2] || '.' || parts[3];
  IF parts[4] IS DISTINCT FROM
     encode(sha256(convert_to(k || encode(sha256(convert_to(k || signed, 'UTF8')), 'hex'), 'UTF8')), 'hex') THEN
    RETURN ARRAY['public'];
  END IF;
  IF parts[1]::bigint < floor(extract(epoch FROM clock_timestamp())) OR parts[2]::int <> pg_backend_pid() THEN
    RETURN ARRAY['public'];
  END IF;
  RETURN ARRAY['public'] || COALESCE(string_to_array(NULLIF(parts[3], ''), ','), '{}'::text[]);
EXCEPTION WHEN others THEN
  RETURN ARRAY['public'];
END
$$;
--> statement-breakpoint
-- Views that apply the clearance themselves, for the reads row-level
-- security would otherwise leave without an index.
--
-- A policy's test runs before any test of the query's own that Postgres
-- cannot prove harmless on rows the reader may not see, and full-text
-- match is one of those. So a keyword search on a table under row-level
-- security cannot use its index. A view owned by the tables' owner is not
-- under the policy; it carries the same test as an ordinary condition, and
-- the index is used. Each view here exposes only what the search needs to
-- find rows (an id and the indexed column), and the caller joins back to
-- the table, where the policy applies as everywhere else.
CREATE SCHEMA IF NOT EXISTS minerval_readable;
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_readable.claims_text AS
SELECT c.id, c.text_search
  FROM public.claims c
 WHERE c.sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[]);
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_readable.requests_text AS
SELECT r.id, r.text_search
  FROM public.requests r
 WHERE r.sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[]);
--> statement-breakpoint
-- Whether enforcement is on: whether the policy the step creates exists.
CREATE OR REPLACE FUNCTION minerval_enforcement_on() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname = 'label_clearance')
$$;
--> statement-breakpoint
-- The one step that turns enforcement on and off.
--
--   minerval_enforcement_sync(true)   on, whatever labels exist (used just
--                                     before the second label is defined)
--   minerval_enforcement_sync(false)  on exactly when a label other than
--                                     'public' exists
--   minerval_enforcement_sync()       as (false), except that it never
--                                     turns enforcement off: this is the
--                                     form that runs after migrations
--
-- On, for every table in public:
--   - a table with a sensitivity_label column gets row-level security and
--     two policies: label_clearance, which lets minerval_cleared read and
--     write a row only at a label in the connection's clearance, and
--     label_sql_read, which lets the public_read views show a row only at
--     a label in the session's signed clearance;
--   - then, and only then, the table is granted to minerval_cleared, so a
--     table is never reachable before it is covered.
-- Every view in public is made to run with its caller's rights
-- (security_invoker), because a view otherwise reads its tables as its
-- owner, whom the policies do not bind. The public_read views are handed
-- to minerval_sql_views, which the policies do bind.
--
-- Off: the policies are dropped and row-level security is disabled. Grants
-- and view options are left as they are; nothing uses them.
--
-- It returns one line per change it made, and no lines when everything was
-- already as it should be. It takes locks only for changes.
CREATE OR REPLACE FUNCTION minerval_enforcement_sync(want boolean DEFAULT NULL) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  enforce boolean;
  t record;
  clearance_test constant text :=
    'sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[])';
  sql_test constant text :=
    'sensitivity_label = ANY ((SELECT public.minerval_sql_clearance())::text[])';
BEGIN
  -- One at a time: several API tasks start together, and each runs this.
  PERFORM pg_advisory_xact_lock(hashtext('minerval:enforcement'));

  enforce := EXISTS (SELECT 1 FROM public.labels WHERE name <> 'public')
          OR want IS TRUE
          OR (want IS NULL AND public.minerval_enforcement_on());

  IF NOT enforce THEN
    FOR t IN
      SELECT c.relname, c.relrowsecurity,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_clearance') AS has_clearance,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_sql_read') AS has_sql
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
       ORDER BY c.relname
    LOOP
      IF t.has_clearance THEN
        EXECUTE format('DROP POLICY label_clearance ON public.%I', t.relname);
      END IF;
      IF t.has_sql THEN
        EXECUTE format('DROP POLICY label_sql_read ON public.%I', t.relname);
      END IF;
      IF t.relrowsecurity THEN
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.relname);
        RETURN NEXT format('- %s: row-level security off', t.relname);
      END IF;
    END LOOP;
    RETURN;
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

  -- Tables: cover, then grant.
  FOR t IN
    SELECT c.oid, c.relname, c.relrowsecurity,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped) AS labelled,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_clearance') AS has_clearance,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_sql_read') AS has_sql
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
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
    END IF;
    IF NOT (has_table_privilege('minerval_cleared', t.oid, 'SELECT')
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

  -- Sequences the tables draw from.
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
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
           COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), false) AS invoker
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
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
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'minerval_readable' AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    IF NOT has_table_privilege('minerval_cleared', t.oid, 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON minerval_readable.%I TO minerval_cleared', t.relname);
    END IF;
  END LOOP;

  -- Read-only SQL: the views it reads are owned by a role the policies bind.
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public_read' AND c.relkind = 'v'
       AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'minerval_sql_views')
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER VIEW public_read.%I OWNER TO minerval_sql_views', t.relname);
    RETURN NEXT format('+ public_read.%s: owned by minerval_sql_views', t.relname);
  END LOOP;
  RETURN;
END
$$;
--> statement-breakpoint
-- The step is the owner's to run. It is SECURITY DEFINER so that the
-- trigger below can run it whoever inserts the label.
REVOKE ALL ON FUNCTION minerval_enforcement_sync(boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_labels_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.minerval_enforcement_sync(false);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- A second label cannot exist without enforcement: the insert that defines
-- it turns enforcement on in the same transaction, and removing the last
-- one turns it off.
CREATE TRIGGER labels_enforcement
  AFTER INSERT OR DELETE ON labels
  FOR EACH STATEMENT EXECUTE FUNCTION minerval_labels_changed();
