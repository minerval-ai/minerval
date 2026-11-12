-- The tables and columns four features of a private deployment need, in
-- one migration so that their code can follow with none: usage reports,
-- connections to an organization's own systems, sets of files and the
-- commands run against them, and the label a credential works at.
--
-- Nothing changes in behavior. No code reads or writes the nine new tables,
-- which are empty, and the three new columns hold their defaults: every key
-- and every token that exists works at 'public', as it did, and a consent
-- names no label.
--
-- Seven of the new tables carry "sensitivity_label", with the default every
-- labelled table has (minerval_default_label(), 0130), so the step that
-- holds labelled tables to a clearance covers them the next time it runs,
-- from the catalog. "usage_reports" and "usage_reports_received" carry
-- none: a day, a total and identifiers. src/db/schema.ts says why for each
-- table.
--
-- The column on "api_keys", "oauth_tokens" and
-- "oauth_authorization_requests" is "work_label" and not
-- "sensitivity_label", on purpose: it says what label a credential works
-- at, not who may read the row, and those three tables must stay among the
-- ones a connection held to a clearance reads and cannot write (0130), not
-- among the labelled ones.
--
-- What it locks: each ADD COLUMN has a constant default, so it is a catalog
-- change that rewrites nothing, and each of the three keys to "labels"
-- checks its table with one scan. The three tables hold a row per key,
-- token or consent.
CREATE TABLE "connection_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"outcome" text,
	"error" text,
	"result" text,
	"result_hash" text,
	"result_chars" integer,
	"run_id" uuid,
	"agent" text,
	"claim_id" uuid,
	"party_id" uuid,
	"source_id" uuid,
	"kept_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"annotations" jsonb,
	"definition_hash" text NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offered" boolean DEFAULT false NOT NULL,
	"offered_by" uuid,
	"offered_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tool_prefix" text NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"url" text NOT NULL,
	"credential_env" text,
	"credential_header" text DEFAULT 'Authorization' NOT NULL,
	"party_id" uuid NOT NULL,
	"stake" text NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"calls_per_minute" integer,
	"timeout_seconds" integer DEFAULT 120 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_answered_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_connections_rate" CHECK ("connections"."calls_per_minute" IS NULL OR "connections"."calls_per_minute" > 0),
	CONSTRAINT "ck_connections_timeout" CHECK ("connections"."timeout_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "file_set_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_set_id" uuid NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_set_keeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_set_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"first_line" integer,
	"last_line" integer,
	"source_id" uuid NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	"storage_key" text NOT NULL,
	"party_id" uuid NOT NULL,
	"stake" text NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"problem" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"manifest_hash" text,
	"closed_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_sets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"outcome" text,
	"exit_code" integer,
	"error" text,
	"output" text,
	"output_hash" text,
	"output_chars" integer,
	"written" jsonb,
	"written_not_listed" integer,
	"sandbox_version" text,
	"sandbox_image" text,
	"python" text,
	"run_id" uuid,
	"agent" text,
	"claim_id" uuid,
	"source_id" uuid,
	"kept_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"period" date NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"spent_micro_owls" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_via" text,
	"receipt" jsonb,
	"last_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "usage_reports_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"period" date NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"spent_micro_owls" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "work_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD COLUMN "work_label" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "work_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_offered_by_contributors_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_files" ADD CONSTRAINT "file_set_files_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_files" ADD CONSTRAINT "file_set_files_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_file_id_file_set_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_set_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_calls" ADD CONSTRAINT "sandbox_calls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_calls" ADD CONSTRAINT "sandbox_calls_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reports_received" ADD CONSTRAINT "usage_reports_received_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_connection_time" ON "connection_calls" USING btree ("connection_id","called_at");--> statement-breakpoint
CREATE INDEX "idx_connection_calls_source" ON "connection_calls" USING btree ("source_id") WHERE source_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connection_tools_name" ON "connection_tools" USING btree ("connection_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connections_name" ON "connections" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connections_tool_prefix" ON "connections" USING btree ("tool_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_set_files_path" ON "file_set_files" USING btree ("file_set_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_set_keeps_source" ON "file_set_keeps" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_file_set_keeps_set" ON "file_set_keeps" USING btree ("file_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_sets_name" ON "file_sets" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_sets_slug" ON "file_sets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_sandbox_calls_time" ON "sandbox_calls" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_calls_file_sets" ON "sandbox_calls" USING gin ("file_sets");--> statement-breakpoint
CREATE INDEX "idx_sandbox_calls_source" ON "sandbox_calls" USING btree ("source_id") WHERE source_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_reports_period_revision" ON "usage_reports" USING btree ("period","revision");--> statement-breakpoint
CREATE INDEX "idx_usage_reports_unsent" ON "usage_reports" USING btree ("period") WHERE "usage_reports"."sent_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_reports_received" ON "usage_reports_received" USING btree ("account_id","deployment_id","period","revision");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;