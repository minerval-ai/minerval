CREATE TABLE "adopted_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"public_request_id" uuid NOT NULL,
	"adopted_by" uuid,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_up_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_contributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"contribution_type" text NOT NULL,
	"content" text NOT NULL,
	"evidence_urls" text[] DEFAULT '{}' NOT NULL,
	"about_published_page_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"review_status" text NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "ck_feed_contributions_origin" CHECK ("feed_contributions"."origin" IN ('local', 'mirror'))
);
--> statement-breakpoint
CREATE TABLE "feed_request_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "ck_feed_request_targets_origin" CHECK ("feed_request_targets"."origin" IN ('local', 'mirror'))
);
--> statement-breakpoint
CREATE TABLE "feed_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ask" text NOT NULL,
	"why" text NOT NULL,
	"satisfied_by" text NOT NULL,
	"who_could" text,
	"addressed_to" text,
	"bears_on_text" text,
	"state" text NOT NULL,
	"state_note" text,
	"filed_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "ck_feed_requests_origin" CHECK ("feed_requests"."origin" IN ('local', 'mirror'))
);
--> statement-breakpoint
CREATE TABLE "inbound_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_contribution_id" uuid NOT NULL,
	"public_page_id" uuid NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"contribution_type" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'to_read' NOT NULL,
	"summary" text,
	"repeats" uuid,
	"set_aside_because" text,
	"read_by_run" uuid,
	"read_at" timestamp with time zone,
	"action_id" uuid,
	"reassessment" text,
	"reassessment_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_inbound_contributions_state" CHECK ("inbound_contributions"."state" IN ('to_read', 'summarized', 'repeat', 'set_aside')),
	CONSTRAINT "ck_inbound_contributions_reassessment" CHECK ("inbound_contributions"."reassessment" IS NULL OR "inbound_contributions"."reassessment" IN ('not_funded', 'funded', 'made'))
);
--> statement-breakpoint
CREATE TABLE "keep_current_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid,
	"node_id" uuid,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keep_current_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"version_at" timestamp with time zone NOT NULL,
	"paid_by_grant_id" uuid,
	"noticed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"because" text,
	"settled_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_keep_current_queue_state" CHECK ("keep_current_queue"."state" IN ('waiting', 'sent', 'not_sent'))
);
--> statement-breakpoint
CREATE TABLE "outward_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"acted_by" uuid,
	"holding" text[] DEFAULT '{}' NOT NULL,
	"under_standing_choice" text,
	"public_ref" text,
	"sent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" text NOT NULL,
	"public_graph_said" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_outward_acts_result" CHECK ("outward_acts"."result" IN ('done', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "outward_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"told" text NOT NULL,
	"set_by" uuid,
	"holding" text[] DEFAULT '{}' NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_sendings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"policy_id" uuid,
	"removals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_id" uuid,
	"state" text DEFAULT 'to_redact' NOT NULL,
	"redacted_at" timestamp with time zone,
	"redacted_by_model" text,
	"sent_by" uuid,
	"sent_holding" text[] DEFAULT '{}' NOT NULL,
	"sent_under_standing_choice" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"public_report_id" uuid,
	"came_back" jsonb,
	"facts_sent_at" timestamp with time zone,
	"facts_seen" integer,
	"facts_public_report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_report_sendings_state" CHECK ("report_sendings"."state" IN ('to_redact', 'redacted', 'sent', 'not_sent'))
);
--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "about_published_page_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "public_page_id" uuid;--> statement-breakpoint
ALTER TABLE "request_work" ADD COLUMN "taken_up" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_work" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "request_work" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "adopted_requests_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "adopted_requests_adopted_by_contributors_id_fk" FOREIGN KEY ("adopted_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "adopted_requests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_contributions" ADD CONSTRAINT "feed_contributions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_contributions" ADD CONSTRAINT "feed_contributions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_request_targets" ADD CONSTRAINT "feed_request_targets_request_id_feed_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."feed_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_request_targets" ADD CONSTRAINT "feed_request_targets_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_request_targets" ADD CONSTRAINT "feed_request_targets_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD CONSTRAINT "feed_requests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_contributions" ADD CONSTRAINT "inbound_contributions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keep_current_exceptions" ADD CONSTRAINT "keep_current_exceptions_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keep_current_exceptions" ADD CONSTRAINT "keep_current_exceptions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keep_current_queue" ADD CONSTRAINT "keep_current_queue_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outward_acts" ADD CONSTRAINT "outward_acts_acted_by_contributors_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outward_acts" ADD CONSTRAINT "outward_acts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outward_settings" ADD CONSTRAINT "outward_settings_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outward_settings" ADD CONSTRAINT "outward_settings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sendings" ADD CONSTRAINT "report_sendings_report_id_agent_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."agent_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sendings" ADD CONSTRAINT "report_sendings_sent_by_contributors_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sendings" ADD CONSTRAINT "report_sendings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_adopted_requests_request" ON "adopted_requests" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_adopted_requests_public" ON "adopted_requests" USING btree ("public_request_id");--> statement-breakpoint
CREATE INDEX "idx_feed_contributions_claim" ON "feed_contributions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_feed_contributions_page" ON "feed_contributions" USING btree ("about_published_page_id");--> statement-breakpoint
CREATE INDEX "idx_feed_request_targets_request" ON "feed_request_targets" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_feed_request_targets_claim" ON "feed_request_targets" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_contributions_public" ON "inbound_contributions" USING btree ("public_contribution_id");--> statement-breakpoint
CREATE INDEX "idx_inbound_contributions_node" ON "inbound_contributions" USING btree ("showing_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_keep_current_exceptions" ON "keep_current_exceptions" USING btree ("grant_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_keep_current_queue_version" ON "keep_current_queue" USING btree ("node_id","version_at","sensitivity_label");--> statement-breakpoint
CREATE INDEX "idx_keep_current_queue_due" ON "keep_current_queue" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "idx_outward_acts_at" ON "outward_acts" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_report_sendings_report" ON "report_sendings" USING btree ("report_id");--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_about_published_page_id_published_pages_id_fk" FOREIGN KEY ("about_published_page_id") REFERENCES "public"."published_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_request_work_taken_up" ON "request_work" USING btree ("request_id","contributor_id") WHERE taken_up;--> statement-breakpoint
-- The mirror's guard on the feed's record tables, as on every replicated table (0127_mirror.sql): nothing but the applier writes a mirrored row.
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "feed_contributions" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "feed_contributions" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "feed_contributions" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "feed_requests" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "feed_requests" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "feed_requests" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "feed_request_targets" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "feed_request_targets" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "feed_request_targets" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();
