CREATE TABLE "outbound_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"public_node_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content_hash" text NOT NULL,
	"hash" text NOT NULL,
	"package" jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_kind" text DEFAULT 'claim' NOT NULL,
	"text" text NOT NULL,
	"written_by" uuid,
	"written_holding" text[] DEFAULT '{}' NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"needs" uuid[] DEFAULT '{}' NOT NULL,
	"releases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'waiting_for_release' NOT NULL,
	"public_contribution_id" text,
	"public_node_id" uuid,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_outbound_proposals_state" CHECK ("outbound_proposals"."state" IN ('waiting_for_release', 'ready', 'sent', 'on_the_public_graph', 'not_admitted', 'replaced'))
);
--> statement-breakpoint
CREATE TABLE "outbound_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid,
	"proposal_id" uuid,
	"sent_by" uuid,
	"holding" text[] DEFAULT '{}' NOT NULL,
	"under_standing_choice" boolean DEFAULT false NOT NULL,
	"how" text NOT NULL,
	"result" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_outbound_sends_how" CHECK ("outbound_sends"."how" IN ('https', 'file')),
	CONSTRAINT "ck_outbound_sends_result" CHECK ("outbound_sends"."result" IN ('admitted', 'refused', 'failed', 'handed_over'))
);
--> statement-breakpoint
CREATE TABLE "published_page_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"published_page_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"hash" text NOT NULL,
	"state" text NOT NULL,
	"package" jsonb NOT NULL,
	"checked" jsonb NOT NULL,
	"source_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"showing_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"contribution_id" uuid,
	"latest_sequence" integer DEFAULT 0 NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"hosting" text NOT NULL,
	"declared_interest" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_publishers_hosting" CHECK ("publishers"."hosting" IN ('own_machines', 'minerval', 'third_party'))
);
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "ck_sources_source_type";--> statement-breakpoint
ALTER TABLE "shown_showings" ADD COLUMN "send_as_released" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_packages" ADD CONSTRAINT "outbound_packages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_proposals" ADD CONSTRAINT "outbound_proposals_written_by_contributors_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_proposals" ADD CONSTRAINT "outbound_proposals_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_sent_by_contributors_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_page_packages" ADD CONSTRAINT "published_page_packages_published_page_id_published_pages_id_fk" FOREIGN KEY ("published_page_id") REFERENCES "public"."published_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_page_packages" ADD CONSTRAINT "published_page_packages_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_page_packages" ADD CONSTRAINT "published_page_packages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_packages_sequence" ON "outbound_packages" USING btree ("showing_id","node_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_packages_hash" ON "outbound_packages" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "idx_outbound_proposals_node" ON "outbound_proposals" USING btree ("showing_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_outbound_sends_package" ON "outbound_sends" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_published_page_packages_sequence" ON "published_page_packages" USING btree ("published_page_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_published_page_packages_hash" ON "published_page_packages" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_published_pages_showing_node" ON "published_pages" USING btree ("key_id","showing_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_published_pages_node" ON "published_pages" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_publishers_live_key" ON "publishers" USING btree ("key_id") WHERE "publishers"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_publishers_account" ON "publishers" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "ck_sources_source_type" CHECK ("sources"."source_type" IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'shown_page', 'published_page', 'unknown'));