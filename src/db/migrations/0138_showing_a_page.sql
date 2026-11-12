CREATE TABLE "redaction_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boundary_id" uuid NOT NULL,
	"side" text NOT NULL,
	"version" integer NOT NULL,
	"categories" jsonb NOT NULL,
	"body" text NOT NULL,
	"hash" text NOT NULL,
	"from_label" text,
	"to_label" text,
	"to_outside" boolean DEFAULT false NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_redaction_policies_side" CHECK ("redaction_policies"."side" IN ('page', 'destination')),
	CONSTRAINT "ck_redaction_policies_pair" CHECK (("redaction_policies"."side" = 'page') = ("redaction_policies"."from_label" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "release_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"boundary_id" uuid NOT NULL,
	"condition" text NOT NULL,
	"covers_verdict" boolean DEFAULT false NOT NULL,
	"set_by" uuid,
	"set_holding" text[] DEFAULT '{}' NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_release_rules_condition" CHECK ("release_rules"."condition" IN ('nothing_removed_and_only_ours', 'only_ours'))
);
--> statement-breakpoint
CREATE TABLE "showing_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showing_id" uuid NOT NULL,
	"page_id" uuid,
	"part_id" uuid,
	"act" text NOT NULL,
	"party_id" uuid,
	"actor_id" uuid,
	"holding" text[] DEFAULT '{}' NOT NULL,
	"rule_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"judgment_kind" text NOT NULL,
	"judgment_id" uuid NOT NULL,
	"judged_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" text DEFAULT 'to_redact' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"redact_action_id" uuid,
	"audit_run_id" uuid,
	"policy_id" uuid,
	"header" text,
	"header_salt" text,
	"root" text,
	"rests_on" uuid[] DEFAULT '{}' NOT NULL,
	"least_sure" jsonb,
	"cannot_cross_category" text,
	"cannot_cross_note" text,
	"audit_answer" text,
	"audit_reasons" text,
	"redactor_model" text,
	"redactor_run_id" uuid,
	"redacted_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_showing_pages_stage" CHECK ("showing_pages"."stage" IN ('to_redact', 'to_check', 'at_gate', 'cannot_cross', 'overtaken')),
	CONSTRAINT "ck_showing_pages_kind" CHECK ("showing_pages"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment'))
);
--> statement-breakpoint
CREATE TABLE "showing_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"descriptor" text NOT NULL,
	"ref_id" uuid,
	"original" text NOT NULL,
	"salt" text NOT NULL,
	"rests_on" uuid[] DEFAULT '{}' NOT NULL,
	"redacted" text,
	"marks" jsonb,
	"commitment" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showing_removals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"category" text NOT NULL,
	"note" text NOT NULL,
	"policy_id" uuid NOT NULL,
	"made_in_round" integer DEFAULT 1 NOT NULL,
	"taken_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_showing_removals_span" CHECK ("showing_removals"."start_offset" >= 0 AND "showing_removals"."end_offset" > "showing_removals"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "showings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"to_label" text,
	"to_outside" boolean DEFAULT false NOT NULL,
	"boundary_id" uuid NOT NULL,
	"form" text NOT NULL,
	"scope" text NOT NULL,
	"asked_by" uuid,
	"asked_holding" text[] DEFAULT '{}' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"ended_holding" text[],
	"end_reason" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_showings_destination" CHECK (("showings"."to_label" IS NULL) = "showings"."to_outside"),
	CONSTRAINT "ck_showings_form" CHECK ("showings"."form" IN ('once', 'standing')),
	CONSTRAINT "ck_showings_scope" CHECK ("showings"."scope" IN ('node', 'under')),
	CONSTRAINT "ck_showings_not_own_label" CHECK ("showings"."to_label" IS NULL OR "showings"."to_label" <> "showings"."sensitivity_label")
);
--> statement-breakpoint
CREATE TABLE "shown_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"place_parent_id" uuid,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" text,
	"first_assessed_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shown_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"judged_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"stage" text DEFAULT 'to_redact' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"root" text,
	"roots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"header_commitment" text,
	"header" text,
	"header_salt" text,
	"needs" uuid[] DEFAULT '{}' NOT NULL,
	"audit_answer" text,
	"shown_at" timestamp with time zone,
	"source_id" uuid,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shown_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"descriptor" text NOT NULL,
	"commitment" text NOT NULL,
	"needs" uuid[] DEFAULT '{}' NOT NULL,
	"text" text,
	"marks" jsonb,
	"salt" text,
	"released_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shown_showings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"to_outside" boolean DEFAULT false NOT NULL,
	"boundary_id" uuid NOT NULL,
	"form" text NOT NULL,
	"scope" text NOT NULL,
	"asked_by" uuid,
	"asked_holding" text[] DEFAULT '{}' NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"ended_holding" text[],
	"end_reason" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "ck_sources_source_type";--> statement-breakpoint
ALTER TABLE "redaction_policies" ADD CONSTRAINT "redaction_policies_from_label_labels_name_fk" FOREIGN KEY ("from_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redaction_policies" ADD CONSTRAINT "redaction_policies_to_label_labels_name_fk" FOREIGN KEY ("to_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redaction_policies" ADD CONSTRAINT "redaction_policies_saved_by_contributors_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redaction_policies" ADD CONSTRAINT "redaction_policies_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rules" ADD CONSTRAINT "release_rules_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rules" ADD CONSTRAINT "release_rules_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rules" ADD CONSTRAINT "release_rules_ended_by_contributors_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rules" ADD CONSTRAINT "release_rules_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD CONSTRAINT "showing_acts_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD CONSTRAINT "showing_acts_actor_id_contributors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD CONSTRAINT "showing_acts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD CONSTRAINT "showing_pages_showing_id_showings_id_fk" FOREIGN KEY ("showing_id") REFERENCES "public"."showings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD CONSTRAINT "showing_pages_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD CONSTRAINT "showing_pages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_parts" ADD CONSTRAINT "showing_parts_page_id_showing_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."showing_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_parts" ADD CONSTRAINT "showing_parts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_removals" ADD CONSTRAINT "showing_removals_part_id_showing_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."showing_parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showing_removals" ADD CONSTRAINT "showing_removals_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_to_label_labels_name_fk" FOREIGN KEY ("to_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_asked_by_contributors_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_ended_by_contributors_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_nodes" ADD CONSTRAINT "shown_nodes_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD CONSTRAINT "shown_pages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_parts" ADD CONSTRAINT "shown_parts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_showings" ADD CONSTRAINT "shown_showings_asked_by_contributors_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_showings" ADD CONSTRAINT "shown_showings_ended_by_contributors_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shown_showings" ADD CONSTRAINT "shown_showings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_redaction_policies_version" ON "redaction_policies" USING btree ("boundary_id","side","version");--> statement-breakpoint
CREATE INDEX "idx_release_rules_boundary" ON "release_rules" USING btree ("boundary_id");--> statement-breakpoint
CREATE INDEX "idx_showing_acts_showing" ON "showing_acts" USING btree ("showing_id","at");--> statement-breakpoint
CREATE INDEX "idx_showing_acts_item" ON "showing_acts" USING btree ("page_id","part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_showing_pages_version" ON "showing_pages" USING btree ("showing_id","node_id","judgment_id");--> statement-breakpoint
CREATE INDEX "idx_showing_pages_stage" ON "showing_pages" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_showing_parts_position" ON "showing_parts" USING btree ("page_id","position");--> statement-breakpoint
CREATE INDEX "idx_showing_removals_part" ON "showing_removals" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "idx_showings_node" ON "showings" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_showings_live" ON "showings" USING btree ("node_id","boundary_id","form","scope") WHERE ended_at IS NULL AND form = 'standing';--> statement-breakpoint
CREATE INDEX "idx_shown_nodes_showing" ON "shown_nodes" USING btree ("showing_id");--> statement-breakpoint
CREATE INDEX "idx_shown_nodes_node" ON "shown_nodes" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_shown_pages_showing" ON "shown_pages" USING btree ("showing_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shown_parts_position" ON "shown_parts" USING btree ("page_id","position");--> statement-breakpoint
CREATE INDEX "idx_shown_showings_node" ON "shown_showings" USING btree ("node_id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "ck_sources_source_type" CHECK ("sources"."source_type" IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'shown_page', 'unknown'));--> statement-breakpoint
-- A version made beside another label's version is shown as made against an
-- earlier one when that version is replaced (judgment_inputs, 'beside'),
-- and its reassessment is opened. One replacement is not such a change: the
-- other label's Steward took in a page that this version's own label, or a
-- label it reads, had shown it (services/showing-service.ts). Everything in
-- such a page was already in front of the version that was shown, so the
-- lower version changing for that reason alone gives the higher one nothing
-- new to weigh.
--
-- It is read from the record: the version that stands there now and the
-- one this version was made beside rest on the same premises, each at the
-- same judgment, and beside the same versions, and the sources that one
-- has and the other has not are all pages shown from a label `reader_label`
-- reads, with at least one of them added. A version whose inputs were not
-- recorded has none to compare, and is treated as any other replacement.
--
-- It runs with its caller's rights. A reader of `reader_label` reads the
-- rows it needs; a connection that does not read them gets false, which is
-- the answer the rule had before this function existed.
CREATE OR REPLACE FUNCTION minerval_only_shown_pages_between(
  kind text, old_version uuid, new_version uuid, reader_label text
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  WITH old_in AS (
    SELECT input_kind, node_id, relation_type, input_judgment_id, input_label, source_id
      FROM public.judgment_inputs WHERE judgment_kind = kind AND judgment_id = old_version
  ), new_in AS (
    SELECT input_kind, node_id, relation_type, input_judgment_id, input_label, source_id
      FROM public.judgment_inputs WHERE judgment_kind = kind AND judgment_id = new_version
  ), other_diff AS (
    (SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM old_in WHERE input_kind <> 'source'
     EXCEPT
     SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM new_in WHERE input_kind <> 'source')
    UNION ALL
    (SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM new_in WHERE input_kind <> 'source'
     EXCEPT
     SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM old_in WHERE input_kind <> 'source')
  ), source_diff AS (
    (SELECT source_id FROM old_in WHERE input_kind = 'source' EXCEPT SELECT source_id FROM new_in WHERE input_kind = 'source')
    UNION ALL
    (SELECT source_id FROM new_in WHERE input_kind = 'source' EXCEPT SELECT source_id FROM old_in WHERE input_kind = 'source')
  )
  SELECT new_version IS NOT NULL AND old_version IS NOT NULL
     AND EXISTS (SELECT 1 FROM old_in)
     AND NOT EXISTS (SELECT 1 FROM other_diff)
     AND EXISTS (SELECT 1 FROM source_diff)
     AND NOT EXISTS (
       SELECT 1 FROM source_diff d
        WHERE NOT EXISTS (
          SELECT 1 FROM public.shown_pages sp
            JOIN public.showing_pages pp ON pp.id = sp.id
           WHERE sp.source_id = d.source_id
             AND pp.sensitivity_label = ANY (public.minerval_labels_readable_from(ARRAY[reader_label]))))
$$;
