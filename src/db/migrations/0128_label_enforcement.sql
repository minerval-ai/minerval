-- Holding reads and writes to a clearance: the database's side of it. A
-- clearance is the set of labels a connection may read. The application
-- code that gives each connection its clearance, and connects as the roles
-- below, is its own change and carries no migration.
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
--  6. Four guards the step installs with the policies, for what a policy
--     cannot say: a node's judgment in force is retired only by work at its
--     own label, an insert that collides with a row the writer cannot read
--     is refused with the reason, a row's label is never changed, and
--     neither is the sign-in an account belongs to.
--  7. Views, in their own schema, that the policies do not bind: two that
--     apply a connection's clearance as an ordinary condition, so that
--     keyword search keeps its index where the policies are on, and two
--     that show the money on the ledger whole, without the text beside it.
--  8. A label on the three tables that hold text an agent wrote and had
--     none: action_allocations, mandate_valuations and regrants.
--  9. Every view in public reads with its caller's rights from now on,
--     whether or not enforcement is on, so that no view is ever a way past
--     the policies, however it comes to be replaced.
--
-- Every function here that runs with its owner's rights (SECURITY DEFINER)
-- sets search_path to pg_catalog, then pg_temp, and names every relation
-- and every function of ours with its schema. A session's temporary schema
-- is searched first for relations unless the path lists it, so a function
-- that named pg_roles bare could be handed a temporary table of that name.
-- Built-in functions and operators are not spelled with pg_catalog: the
-- temporary schema is never searched for those, and pg_catalog is first.
--
-- The table owner is not bound by the policies (row-level security is
-- enabled, not forced). The owner is the role migrations run as and the
-- role system work connects as, and both must see every row.
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
-- The label a connection's new rows carry: its own, and 'public' where it
-- has none (a request outside any run, whose stamps have always said
-- 'public'). The policy below holds every insert on a cleared connection
-- to it.
CREATE OR REPLACE FUNCTION minerval_write_label() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(NULLIF(current_setting('minerval.label', true), ''), 'public')
$$;
--> statement-breakpoint
-- Every label readable from the ones given: the labels themselves, each
-- label one of them reads, and so on to the end of label_reads. 'public' is
-- always in the answer. The one definition of what a clearance is, for a
-- person's grants and for a run's label alike.
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
-- The three tables 0126 left to be decided. Each holds text an agent
-- wrote: a commission's brief and reason, a valuation's rationale, a
-- regrant's note. They get the column as the other tables did (a catalog
-- change, then one scan for the foreign key; 0126 says what each locks).
--
-- Rows that exist are 'public', as every row was when they were written,
-- except on a database that already has another label: there a row takes
-- the label of what it was written for, which is the nearest thing to the
-- label of the work that wrote it. An allocation takes its ledger row's; a
-- valuation its mandate's; a regrant the mandate's that gave. On the public
-- graph the block finds one label and scans nothing.
ALTER TABLE "action_allocations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_valuations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "regrants" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.labels WHERE name <> 'public') THEN
    UPDATE public.action_allocations al
       SET sensitivity_label = a.sensitivity_label
      FROM public.actions a
     WHERE a.id = COALESCE(al.action_id,
                           (SELECT g.id FROM public.actions g
                             WHERE g.exclusion_group = al.exclusion_group
                             ORDER BY g.created_at DESC LIMIT 1))
       AND a.sensitivity_label <> 'public';
    UPDATE public.mandate_valuations v
       SET sensitivity_label = g.sensitivity_label
      FROM public.grants g
     WHERE g.id = v.grant_id AND g.sensitivity_label <> 'public';
    UPDATE public.regrants r
       SET sensitivity_label = g.sensitivity_label
      FROM public.grants g
     WHERE g.id = r.from_grant_id AND g.sensitivity_label <> 'public';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_valuations" ADD CONSTRAINT "mandate_valuations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regrants" ADD CONSTRAINT "regrants_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_allocations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
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
ALTER TABLE "mandate_valuations" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
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
ALTER TABLE "regrants" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
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
-- A label's name is written into a connection's settings as an element of
-- an array, where the bare word null is no label at all: a label of that
-- name could not read its own rows. No other plain name reads specially.
ALTER TABLE "labels" ADD CONSTRAINT "labels_name_plain" CHECK ("labels"."name" ~ '^[a-z][a-z0-9_-]{0,62}$' AND "labels"."name" <> 'null');
--> statement-breakpoint
-- 'public' reads no other label: what it read, everyone would read. The
-- API has always refused such a pair; the table now refuses it too. A pair
-- that is there all the same goes, which can only narrow what is read.
DELETE FROM "label_reads" WHERE "label" = 'public';
--> statement-breakpoint
ALTER TABLE "label_reads" ADD CONSTRAINT "ck_label_reads_public_reads_nothing" CHECK ("label_reads"."label" <> 'public');
--> statement-breakpoint
-- Every view in public reads its tables with its caller's rights, always.
-- A view otherwise reads as its owner, whom the policies do not bind, so a
-- view left that way would show a cleared connection every label. The step
-- used to set this when enforcement turned on, and CREATE OR REPLACE VIEW
-- sets it back: a later migration that replaced a view would have opened it
-- until the step next ran. Now the four views say it in the schema
-- (src/db/schema.ts), so a regenerated view is created with it, and a test
-- fails a migration that makes a view here without it. Where enforcement is
-- off every caller is the owner, and the option changes nothing.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND NOT COALESCE((SELECT option_value = 'true' FROM pg_catalog.pg_options_to_table(c.reloptions)
                          WHERE option_name = 'security_invoker'), false)
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v.relname);
  END LOOP;
END $$;
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
--
-- The tables' owner is the exception, here as everywhere: it reads every
-- row of the tables themselves, so the views show it every row too. A
-- read-only SQL login is never the owner.
CREATE OR REPLACE FUNCTION minerval_sql_clearance() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  token text := NULLIF(current_setting('minerval.sql_clearance', true), '');
  parts text[];
  k text;
  signed text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
              WHERE r.rolname = session_user
                AND (r.rolsuper OR r.oid = (SELECT c.relowner FROM pg_catalog.pg_class c
                                             WHERE c.oid = 'public.labels'::pg_catalog.regclass))) THEN
    RETURN (SELECT array_agg(name) FROM public.labels);
  END IF;
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
-- the index is used. Each view here exposes only the columns the search
-- reads, so a later change to any other column of its table does not meet
-- it. claims_search stands in for claims in the search queries;
-- requests_text gives the ids a request search matched, and the rows are
-- then read from the table under the policy.
CREATE SCHEMA IF NOT EXISTS minerval_readable;
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_readable.claims_search AS
SELECT c.id, c.kind, c.text, c.claim_type, c.state, c.merged_into, c.importance, c.text_search, c.embedding
  FROM public.claims c
 WHERE c.sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[]);
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_readable.requests_text AS
SELECT r.id, r.text_search
  FROM public.requests r
 WHERE r.sensitivity_label = ANY ((SELECT public.minerval_clearance())::text[]);
--> statement-breakpoint
-- The money on the ledger, whole.
--
-- An allocation is money placed on a ledger row, and one row is paid for by
-- whoever placed money on it, at whatever label: work at one label joins a
-- row another label opened. What a run costs is split across every
-- allocation that covers it, a mandate's room is its budget less everything
-- it has placed, and a refund is what was placed and not spent. Each of
-- those sums is wrong if it is taken over the allocations one label reads,
-- and wrong in the direction that spends money twice. So the money is read
-- and settled through these views, which the policies do not bind, and
-- which leave out the one thing on these rows that an agent wrote: a
-- commission's brief and reason, a regrant's note. Those are read from the
-- tables, under the policies. What the views show at every label is ids,
-- amounts, times and the key of the ledger row.
--
-- The application reads them whether or not enforcement is on; a view this
-- simple is planned as the table it is over. Rows are added to the tables,
-- never through the views, so a new row is held to its writer's label.
--
-- A cleared connection may change through them only what settling money
-- changes, column by column (the step grants exactly these): on an
-- allocation its amount, what of it is spent, and when it was released; on
-- a regrant its amount and what of it came back. It may delete a regrant,
-- which is what returning one in full does (mandate-terms-service.ts), and
-- no allocation. The ledger key and who commissioned are in the allocation
-- view because every money statement finds its rows by them, and they
-- cannot be changed through it.
CREATE SCHEMA IF NOT EXISTS minerval_whole;
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_whole.allocation_money AS
SELECT al.id, al.exclusion_group, al.action_id, al.claim_id, al.grant_id, al.user_id,
       al.amount_micro_usd, al.spent_micro_usd, al.released_at, al.created_at,
       al.commissioned_by, al.parent_action_id
  FROM public.action_allocations al;
--> statement-breakpoint
CREATE OR REPLACE VIEW minerval_whole.regrant_money AS
SELECT r.id, r.from_grant_id, r.to_grant_id, r.amount_micro_usd, r.refunded_micro_usd, r.created_at
  FROM public.regrants r;
--> statement-breakpoint
-- Whether enforcement is on: whether the policy the step creates exists.
CREATE OR REPLACE FUNCTION minerval_enforcement_on() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname = 'label_clearance')
$$;
--> statement-breakpoint
-- One judgment in force per node, and each label's own.
--
-- A node holds one judgment in force today (a unique index on the rows
-- where is_current is true), whatever its label. Under the policies that
-- leaves two ways for one label's judgment to take another's place. A run
-- that reads the label of the judgment in force can retire it and record
-- its own, and readers of the first label are left with none. A run that
-- cannot read it sees no judgment, and its insert collides with the row it
-- cannot see. A node keeping one judgment for each label is later work.
-- Until then this trigger refuses both, with a reason: on a cleared
-- connection a judgment is retired only by work at its own label, and one
-- is recorded as in force only where none stands at another label. The
-- owner's connection is not held to it. The step below puts the trigger on
-- every labelled table that has an is_current column and a unique index
-- over its rows in force, and names that index's column as the node's.
CREATE OR REPLACE FUNCTION minerval_judgment_label_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  own text := COALESCE(NULLIF(current_setting('minerval.label', true), ''), 'public');
  node_column text := TG_ARGV[0];
  node text;
  elsewhere boolean;
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_current AND NOT NEW.is_current AND OLD.sensitivity_label <> own THEN
      RAISE EXCEPTION 'the judgment in force on this node was recorded at another label, and this work may not retire it'
        USING ERRCODE = 'MVL02',
              HINT = 'A judgment at one label must not take the place of another label''s, and a node keeping one for each label is not built yet. Nothing was changed.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_current THEN
    EXECUTE format('SELECT ($1).%I::text', node_column) INTO node USING NEW;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I::text = $1 AND is_current AND sensitivity_label <> $2)',
      TG_TABLE_NAME, node_column) INTO elsewhere USING node, NEW.sensitivity_label;
    IF elsewhere THEN
      RAISE EXCEPTION 'this node''s judgment in force was recorded at another label, so this one was not recorded'
        USING ERRCODE = 'MVL02',
              HINT = 'A judgment at one label must not take the place of another label''s, and a node keeping one for each label is not built yet. Nothing was recorded.';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A write that would collide with a row the writer cannot read.
--
-- A unique index holds for every row of its table, whatever the labels, so
-- a run can try to write a row whose key is already taken by one it cannot
-- see: a tag with the same slug, an edge between the same two nodes, a
-- source at the same address. Left alone, Postgres answers in three ways,
-- none of them clear: a plain insert fails as a duplicate; an insert that
-- does nothing on conflict does nothing, and the code that then reads the
-- row back finds no row; an upsert is refused by the policy. Each label
-- keeping its own row is later work. Until then this trigger makes the
-- three one: an insert on a cleared connection whose key is held by a row
-- outside the connection's clearance is refused, and says so.
--
-- The step below gives it the table's unique indexes as arguments, in
-- pairs: an index's columns, and its predicate where it is partial. The
-- step reads a predicate with only pg_catalog on its path, so a type or a
-- function of ours in it comes spelled with its schema, which is how this
-- function, on the same path, reads it back. Indexes over expressions are
-- not handled, and a lone id is left out. It does not look at updates that
-- change a key.
CREATE OR REPLACE FUNCTION minerval_unseen_collision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  reads text[];
  i int := 0;
  columns text[];
  predicate text;
  applies boolean;
  taken boolean;
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  reads := public.minerval_clearance();
  WHILE i < TG_NARGS LOOP
    columns := string_to_array(TG_ARGV[i], ',');
    predicate := TG_ARGV[i + 1];
    i := i + 2;
    IF predicate <> '' THEN
      -- A partial index binds the new row only where its predicate holds for it.
      EXECUTE format('SELECT (%s) FROM (SELECT ($1).*) AS candidate', predicate) INTO applies USING NEW;
      CONTINUE WHEN applies IS NOT TRUE;
    END IF;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I AS existing WHERE (%s) = (%s)%s AND existing.sensitivity_label <> ALL ($2))',
      TG_TABLE_NAME,
      (SELECT string_agg(format('existing.%I', c), ', ') FROM unnest(columns) AS c),
      (SELECT string_agg(format('($1).%I', c), ', ') FROM unnest(columns) AS c),
      CASE WHEN predicate <> '' THEN format(' AND (%s)', predicate) ELSE '' END
    ) INTO taken USING NEW, reads;
    IF taken THEN
      RAISE EXCEPTION 'this was not written: a row with the same identity already exists at a label this work does not read'
        USING ERRCODE = 'MVL03',
              TABLE = TG_TABLE_NAME,
              DETAIL = format('In %s, by %s.', TG_TABLE_NAME, array_to_string(columns, ', ')),
              HINT = 'A table holds one row for each identity whatever the labels, and each label keeping its own is not built yet. Nothing was changed.';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A row's label does not change.
--
-- The policy lets a cleared connection change a row it reads into any row
-- it reads, the label included: down to 'public', which shows the row to
-- everyone; across to another label it holds; or up, which takes a public
-- row out of everyone else's sight. Moving a row to a label more people
-- read is a release, which is later work and will be the owner's to do.
-- Until then this trigger refuses, on a cleared connection, an update that
-- changes the label, an upsert's DO UPDATE included.
--
-- One change is let through, because it is how the ledger has worked since
-- its rows got labels (LABEL_ON_REOPEN_SQL in services/action-service.ts):
-- a ledger row stands for its group's next piece of work, so a finished row
-- that is opened again takes the label of the work that reopens it. The
-- trigger lets through exactly that and nothing near it:
--   - the row was finished, by name: done, superseded or cancelled;
--   - the same statement opens it: its new status is open;
--   - its new label is the connection's own;
--   - and the new label reads the old one, so the row only ever moves to
--     where fewer people read it. A request, which writes at 'public',
--     cannot take a private row this way, and nothing moves sideways.
-- The statement that reopens a row also replaces its display text and its
-- target (the same fragment sets them), so nothing written at the old
-- label is carried under the new one. What this can still do is take a
-- finished public row out of public readers' sight, and a public reopening
-- of a finished private row is refused: the cost of one row per group
-- until each label keeps its own.
--
-- It is a trigger on the column and not a grant on the other columns,
-- because a grant would have to be given again for each column a later
-- migration adds, and a missed one would refuse a write that had nothing
-- to do with labels. It fires only for a statement that names the column,
-- so it costs nothing on any other update.
CREATE OR REPLACE FUNCTION minerval_label_fixed_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'actions' THEN
    IF OLD.status IN ('done', 'superseded', 'cancelled')
       AND NEW.status = 'open'
       AND NEW.sensitivity_label = public.minerval_write_label()
       AND OLD.sensitivity_label = ANY (public.minerval_labels_readable_from(ARRAY[NEW.sensitivity_label])) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a row''s label does not change: this row is at "%" and the update would have made it "%"',
      OLD.sensitivity_label, NEW.sensitivity_label
    USING ERRCODE = 'MVL04',
          TABLE = TG_TABLE_NAME,
          HINT = 'A row stays at the label it was written at. Moving one to a label more people read is a release, which is not built yet. Nothing was changed.';
END
$$;
--> statement-breakpoint
-- Which sign-in an account is does not change on a cleared connection.
--
-- contributors.external_id is the identity a verified sign-in is matched
-- to, and a service caller names the person it acts for by it. A connection
-- that could rewrite it could hand one person's account, with its grants,
-- to another sign-in. The rest of the row (a display name, a reputation) is
-- the application's to change as it always has, so this is a trigger on
-- the one column and not a grant on the others.
CREATE OR REPLACE FUNCTION minerval_identity_fixed_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'which sign-in an account belongs to does not change on a connection held to a clearance'
    USING ERRCODE = 'MVL05',
          TABLE = TG_TABLE_NAME,
          HINT = 'contributors.external_id is set when the account is made. Nothing was changed.';
END
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
--     three policies: label_clearance, which lets minerval_cleared read and
--     change a row only at a label in the connection's clearance;
--     label_own_insert, which lets it add a row only at the connection's
--     own label, so a wrong stamp is refused as a missing one is filled;
--     and label_sql_read, which lets the public_read views show a row only
--     at a label in the session's signed clearance;
--   - a labelled table that holds judgments in force gets the trigger
--     above, one with a unique index gets the trigger that refuses a
--     collision with a row the writer cannot read, and every one gets the
--     trigger that keeps a row's label as it was written;
--   - then, and only then, the table is granted to minerval_cleared, so a
--     table is never reachable before it is covered.
-- The tables that say what a clearance is (labels, label_reads,
-- permission_grants, account_groups) and the ones that say who a request
-- is (api_keys, oauth_tokens, oauth_clients, oauth_authorization_requests)
-- are granted to minerval_cleared to read and nothing else: a connection
-- held to a clearance must not be able to widen it, its own or anyone's,
-- or make itself a key to an account that reads more. Their administration
-- is the owner's. On contributors, the column that says which sign-in an
-- account is (external_id) is held by a trigger, as a row's label is.
-- The administrators' log (administrative_events) it may read and add to,
-- and not change.
-- Every view in public is made to run with its caller's rights
-- (security_invoker), because a view otherwise reads its tables as its
-- owner, whom the policies do not bind. The public_read views are handed
-- to minerval_sql_views, which the policies do bind. Nobody but the
-- database's owner makes temporary tables once enforcement is on: nothing
-- of ours uses one, and a temporary table is a way to put a relation of a
-- chosen name in front of a session's own queries.
--
-- Off: the policies and the triggers are dropped and row-level security is
-- disabled. Grants and view options are left as they are; nothing uses them.
--
-- It returns one line per change it made, and no lines when everything was
-- already as it should be. It takes locks only for changes.
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
             EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'label_fixed_guard') AS has_fixed_guard
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
      IF t.relrowsecurity THEN
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.relname);
        RETURN NEXT format('- %s: row-level security off', t.relname);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g
                WHERE g.tgrelid = 'public.contributors'::pg_catalog.regclass AND g.tgname = 'identity_fixed_guard') THEN
      DROP TRIGGER identity_fixed_guard ON public.contributors;
    END IF;
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
           -- The node a judgment is of: the column of the unique index over
           -- the rows in force. Null on a table that holds no judgments.
           (SELECT a.attname::text
              FROM pg_catalog.pg_index i
              JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
             WHERE i.indrelid = c.oid AND i.indisunique AND i.indnatts = 1 AND i.indpred IS NOT NULL
               AND pg_get_expr(i.indpred, i.indrelid) LIKE '%is_current%'
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
-- The step is the owner's to run. It is SECURITY DEFINER so that the
-- trigger below can run it whoever inserts the label.
REVOKE ALL ON FUNCTION minerval_enforcement_sync(boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_labels_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
