-- Each layer keeps its own identity.
--
-- A graph at a label is that label's own rows over the graph of the labels
-- it reads, down to the public graph's rows in the mirror. Until now a
-- table held one row for each key whatever the labels (apart from the
-- mirror, whose keys end with origin). So a run at a label could be
-- stopped by a row at a label it does not read, and the refusal told it the
-- row was there (unseen_collision_guard, MVL03).
--
-- The statements drizzle-kit generated below put sensitivity_label into
-- each such key, before origin where the table has one. An index gains a
-- column and so allows everything it allowed, and on a graph with one
-- label it holds exactly the rows it held. Every index and constraint
-- keeps its name. What a reader of two layers is given for one key, and
-- what a write does where a layer below holds it, is the application's
-- (src/services/layer-service.ts), with the two functions at the end.
ALTER TABLE "claim_formalizations" DROP CONSTRAINT "uq_claim_formalizations_claim_version";--> statement-breakpoint
ALTER TABLE "lean_checks" DROP CONSTRAINT "uq_lean_checks_submission";--> statement-breakpoint
DROP INDEX "idx_answer_relations_pair";--> statement-breakpoint
DROP INDEX "idx_argument_evidence_backlog_url";--> statement-breakpoint
DROP INDEX "uq_bounty_live_per_claim";--> statement-breakpoint
DROP INDEX "uq_formalization_published";--> statement-breakpoint
DROP INDEX "idx_cir_instance";--> statement-breakpoint
DROP INDEX "idx_claim_links_unique";--> statement-breakpoint
DROP INDEX "idx_cpe_unique";--> statement-breakpoint
DROP INDEX "idx_cpr_claim_source";--> statement-breakpoint
DROP INDEX "idx_cr_unique";--> statement-breakpoint
DROP INDEX "idx_csm_claim";--> statement-breakpoint
DROP INDEX "uq_curation_requests_live";--> statement-breakpoint
DROP INDEX "idx_examination_coverage_unique";--> statement-breakpoint
DROP INDEX "uq_lookout_feed_items_key";--> statement-breakpoint
DROP INDEX "idx_reading_citations_unique";--> statement-breakpoint
DROP INDEX "idx_sr_unique";--> statement-breakpoint
DROP INDEX "uq_sources_url_origin";--> statement-breakpoint
DROP INDEX "uq_taggings_tag_subject";--> statement-breakpoint
DROP INDEX "uq_tags_slug";--> statement-breakpoint
ALTER TABLE "argument_subclaims" DROP CONSTRAINT "argument_subclaims_argument_id_relationship_id_origin_pk";--> statement-breakpoint
ALTER TABLE "quantity_cuts" DROP CONSTRAINT "quantity_cuts_claim_id_origin_pk";--> statement-breakpoint
ALTER TABLE "quantity_definitions" DROP CONSTRAINT "quantity_definitions_claim_id_origin_pk";--> statement-breakpoint
ALTER TABLE "shared_page_analyses" DROP CONSTRAINT "shared_page_analyses_pkey";--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "argument_subclaims_argument_id_relationship_id_sensitivity_label_origin_pk" PRIMARY KEY("argument_id","relationship_id","sensitivity_label","origin");--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "quantity_cuts_claim_id_sensitivity_label_origin_pk" PRIMARY KEY("claim_id","sensitivity_label","origin");--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD CONSTRAINT "quantity_definitions_claim_id_sensitivity_label_origin_pk" PRIMARY KEY("claim_id","sensitivity_label","origin");--> statement-breakpoint
ALTER TABLE "shared_page_analyses" ADD CONSTRAINT "shared_page_analyses_url_hash_sensitivity_label_pk" PRIMARY KEY("url_hash","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_answer_relations_pair" ON "answer_relations" USING btree ("question_id","claim_a_id","claim_b_id","sensitivity_label","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_argument_evidence_backlog_url" ON "argument_evidence_backlog" USING btree ("argument_id","url","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bounty_live_per_claim" ON "bounties" USING btree ("claim_id","sensitivity_label") WHERE status IN ('requested', 'confirm_pending', 'open', 'claim_pending', 'house_result_pending', 'rebinding');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_formalization_published" ON "claim_formalizations" USING btree ("claim_id","sensitivity_label") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cir_instance" ON "claim_instance_readings" USING btree ("instance_id","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_claim_links_unique" ON "claim_links" USING btree ("claim_a_id","claim_b_id","kind","sensitivity_label","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cpe_unique" ON "claim_provenance_edges" USING btree ("from_instance_id","to_source_id","relation_type","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cpr_claim_source" ON "claim_provenance_roots" USING btree ("claim_id","source_id","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cr_unique" ON "claim_relationships" USING btree ("parent_claim_id","child_claim_id","relation_type","sensitivity_label","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_csm_claim" ON "claim_source_maps" USING btree ("claim_id","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_curation_requests_live" ON "curation_requests" USING btree ("anchor_claim_id",COALESCE("other_claim_id", '00000000-0000-0000-0000-000000000000'::uuid),"source","sensitivity_label") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_examination_coverage_unique" ON "examination_coverage" USING btree ("examination_id","segment_id","facet","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lookout_feed_items_key" ON "lookout_feed_items" USING btree ("feed_id","item_key","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reading_citations_unique" ON "reading_citations" USING btree ("reading_id","finding_id","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sr_unique" ON "source_relationships" USING btree ("parent_source_id","child_source_id","relation_type","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sources_url_origin" ON "sources" USING btree ("url","sensitivity_label","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_taggings_tag_subject" ON "taggings" USING btree ("tag_id","subject_kind","subject_id","sensitivity_label");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tags_slug" ON "tags" USING btree ("slug","sensitivity_label");--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD CONSTRAINT "uq_claim_formalizations_claim_version" UNIQUE("claim_id","version","sensitivity_label");--> statement-breakpoint
ALTER TABLE "lean_checks" ADD CONSTRAINT "uq_lean_checks_submission" UNIQUE("formalization_id","submission_sha256","checker_version","mode","sensitivity_label");
--> statement-breakpoint
-- How deep a row's layer lies: 0 for the public graph's row in the mirror,
-- then the number of labels the row's label reads, itself and 'public'
-- included. A label that reads another is always deeper than it, so "the
-- lowest layer first" is an ORDER BY on this. It is called only where a
-- deployment has more than one layer (services/layer-service.ts).
CREATE OR REPLACE FUNCTION minerval_layer_depth(row_label text, row_origin text DEFAULT 'local') RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT CASE WHEN row_origin = 'mirror' THEN 0
              ELSE cardinality(public.minerval_labels_readable_from(ARRAY[row_label])) END
$$;
--> statement-breakpoint
-- Whether one row's layer lies below another's: the mirror below every row
-- of the deployment's own, and among those a label below each label that
-- reads it. Two labels that do not read each other are neither below the
-- other.
CREATE OR REPLACE FUNCTION minerval_layer_below(lower_label text, lower_origin text, upper_label text, upper_origin text) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT (lower_origin = 'mirror' AND upper_origin <> 'mirror')
      OR (lower_origin = upper_origin AND lower_label <> upper_label
          AND lower_label = ANY (public.minerval_labels_readable_from(ARRAY[upper_label])))
$$;
--> statement-breakpoint
-- The guard against a collision the writer cannot see, for the keys that
-- are still one for the whole deployment (tests/db/layer-identity-keys.test.ts
-- lists them with their reasons). A key that holds sensitivity_label cannot
-- collide across labels, so the guard passes over it without asking.
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
    CONTINUE WHEN 'sensitivity_label' = ANY (columns);
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
              HINT = 'This key is held once for the whole deployment, whatever the labels. Nothing was changed.';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- The guard takes each table's keys as its arguments, so where enforcement
-- is on it is rebuilt on the keys as they now are.
SELECT public.minerval_enforcement_sync();
