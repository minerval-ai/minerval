-- The three layers at the bottom of a members-only deployment (#1203).
--
-- On a members-only deployment one label, 'public', has held three kinds of
-- row: the public graph's own, which the mirror brings in; what the
-- organization released outside; and the organization's own material that
-- every member reads. Each becomes a label of its own. This migration names
-- the layers and moves nothing: it adds the column that says which label is
-- which layer, and the functions that read it. Until a deployment is split
-- (services/label-split.ts, at start, on a members-only deployment) no row
-- names a layer, every function here answers 'public', and nothing behaves
-- differently. The public graph is never split: there 'public' stays all
-- three.
--
--   public_graph  'public': the public graph's own rows. Anyone reads it,
--                 every label reads it, and it reads nothing.
--   published     what the organization released outside. Anyone may read
--                 it, so it is in every clearance beside 'public'.
--   base          the bottom layer of the deployment's own work: what a
--                 write is given when nothing names a label.
ALTER TABLE "labels" ADD COLUMN "layer" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_labels_layer" ON "labels" USING btree ("layer") WHERE "labels"."layer" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "ck_labels_layer" CHECK ("labels"."layer" IN ('public_graph', 'published', 'base'));
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "ck_labels_public_graph_is_public" CHECK (("labels"."layer" = 'public_graph') IS NOT TRUE OR "labels"."name" = 'public');
--> statement-breakpoint
-- The base label: the bottom layer of this deployment's own work. 'public'
-- until the deployment is split, and on the public graph always.
--
-- The three functions that read the layers run with their owner's rights:
-- a policy calls them on a connection held to a clearance, which is granted
-- the labels table only once enforcement is on, and read-only SQL's role is
-- never granted it. Each returns names and nothing else.
CREATE OR REPLACE FUNCTION minerval_base_label() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((SELECT l.name FROM public.labels l WHERE l.layer = 'base'), 'public')
$$;
--> statement-breakpoint
-- The label of what the organization released outside: the destination of
-- the gate to outside. 'public' until the deployment is split.
CREATE OR REPLACE FUNCTION minerval_published_label() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((SELECT l.name FROM public.labels l WHERE l.layer = 'published'), 'public')
$$;
--> statement-breakpoint
-- The labels anyone may read, which every clearance therefore holds: the
-- public graph's, and what was published where that is a label of its own.
CREATE OR REPLACE FUNCTION minerval_open_labels() RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY['public'] || COALESCE((SELECT ARRAY[l.name] FROM public.labels l WHERE l.layer = 'published'), '{}'::text[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_clearance() RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  -- What anyone may read is readable on every connection, whatever the
  -- setting says, and is all a connection reads when it carries no setting.
  SELECT public.minerval_open_labels() || COALESCE(NULLIF(current_setting('minerval.clearance', true), '')::text[], '{}'::text[])
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
    RETURN public.minerval_base_label();
  END IF;
  RAISE EXCEPTION 'a row was written without a label, on a connection that carries none'
    USING ERRCODE = 'MVL01',
          HINT = 'This deployment has more than one label, so a row is never given one by omission. Name sensitivity_label in the insert, or run the work at a label (runAtLabel).';
END
$$;
--> statement-breakpoint
-- The label a connection's new rows carry: its own, and the base label
-- where it has none (a request outside any run).
CREATE OR REPLACE FUNCTION minerval_write_label() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(NULLIF(current_setting('minerval.label', true), ''), public.minerval_base_label())
$$;
--> statement-breakpoint
-- Every label readable from the ones given: the labels themselves, each
-- label one of them reads, and so on to the end of label_reads. 'public' is
-- always in the answer, and so is what was published, for any label but
-- 'public' itself: the public graph's label reads nothing, 'published'
-- reads 'public', and every other label reads both.
CREATE OR REPLACE FUNCTION minerval_labels_readable_from(held text[]) RETURNS text[]
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE reach(label) AS (
    SELECT 'public'
    UNION
    SELECT l.name FROM public.labels l
     WHERE l.layer = 'published' AND EXISTS (SELECT 1 FROM unnest(held) AS h(label) WHERE h.label <> 'public')
    UNION
    SELECT unnest(held)
    UNION
    SELECT lr.reads FROM public.label_reads lr JOIN reach r ON lr.label = r.label
  )
  SELECT COALESCE(array_agg(label), '{}'::text[]) FROM reach WHERE label IS NOT NULL
$$;
--> statement-breakpoint
-- A ledger key at a label: the plain key at the base label, which is the
-- form every key written before a split has, and the key with the label
-- after it elsewhere. No index is built on it, so it may read the table.
CREATE OR REPLACE FUNCTION minerval_group_at(base text, at_label text) RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT CASE WHEN at_label = public.minerval_base_label() THEN base ELSE base || ' @' || at_label END $$;
--> statement-breakpoint
-- Read-only SQL with no valid token reads what anyone may read.
CREATE OR REPLACE FUNCTION public.minerval_sql_clearance()
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
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
    RETURN public.minerval_open_labels();
  END IF;
  parts := string_to_array(token, '.');
  IF array_length(parts, 1) IS DISTINCT FROM 4 THEN
    RETURN public.minerval_open_labels();
  END IF;
  SELECT key INTO k FROM minerval_private.sql_clearance_key;
  IF k IS NULL THEN
    RETURN public.minerval_open_labels();
  END IF;
  signed := parts[1] || '.' || parts[2] || '.' || parts[3];
  IF parts[4] IS DISTINCT FROM
     encode(sha256(convert_to(k || encode(sha256(convert_to(k || signed, 'UTF8')), 'hex'), 'UTF8')), 'hex') THEN
    RETURN public.minerval_open_labels();
  END IF;
  IF parts[1]::bigint < floor(extract(epoch FROM clock_timestamp())) OR parts[2]::int <> pg_backend_pid() THEN
    RETURN public.minerval_open_labels();
  END IF;
  RETURN public.minerval_open_labels() || COALESCE(string_to_array(NULLIF(parts[3], ''), ','), '{}'::text[]);
EXCEPTION WHEN others THEN
  RETURN public.minerval_open_labels();
END
$$;
--> statement-breakpoint
-- The label of a connection that carries none is the base label, here as in the policies.
CREATE OR REPLACE FUNCTION public.minerval_judgment_label_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  own text := public.minerval_write_label();
  node_column text := TG_ARGV[0];
  node uuid;
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
    IF NOT (NEW.is_current AND NOT OLD.is_current) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.is_current THEN
    EXECUTE format('SELECT ($1).%I', node_column) INTO node USING NEW;
    IF TG_TABLE_NAME = 'argument_evaluations' THEN
      SELECT a.sensitivity_label INTO node_label FROM public.arguments a WHERE a.id = node;
    ELSE
      SELECT c.sensitivity_label INTO node_label FROM public.claims c WHERE c.id = node;
    END IF;
    IF node_label IS DISTINCT FROM NEW.sensitivity_label
       AND (node_label IS NULL
            OR NOT (node_label = ANY (public.minerval_labels_readable_from(ARRAY[NEW.sensitivity_label])))) THEN
      RAISE EXCEPTION 'this version was not recorded: the label "%" does not read this node', NEW.sensitivity_label
        USING ERRCODE = 'MVL07',
              HINT = 'A version of a node''s judgment is recorded at the node''s own label or at a label that reads it. The same is said of a node that does not exist. Nothing was recorded.';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "work_label" SET DEFAULT minerval_base_label();
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ALTER COLUMN "work_label" SET DEFAULT minerval_base_label();
--> statement-breakpoint
-- 'published' reads 'public' and nothing a deployment could add: what it
-- read, anyone would read. The base label reads those two and nothing a
-- deployment could add either: what it read, every member would read, which
-- is what the check on 'public' has always kept from happening to the
-- members' layer. The check on label_reads can name only a fixed word, so
-- these pairs are refused by a trigger, as the API refuses them.
CREATE OR REPLACE FUNCTION minerval_open_label_reads_nothing() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.label = ANY (public.minerval_open_labels()) OR NEW.label = public.minerval_base_label() THEN
    RAISE EXCEPTION 'the label "%" reads no other label by a pair: what it read, everyone who reads it would read', NEW.label
      USING ERRCODE = '23514', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER label_reads_open_label_reads_nothing
  BEFORE INSERT OR UPDATE ON label_reads
  FOR EACH ROW EXECUTE FUNCTION minerval_open_label_reads_nothing();
