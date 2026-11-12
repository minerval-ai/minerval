CREATE TABLE "file_set_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_set_id" uuid NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_set_keeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_set_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"first_line" integer,
	"last_line" integer,
	"source_id" uuid NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"sensitivity_label" text DEFAULT 'public' NOT NULL,
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
	"sensitivity_label" text DEFAULT 'public' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_set_files" ADD CONSTRAINT "file_set_files_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_file_set_id_file_sets_id_fk" FOREIGN KEY ("file_set_id") REFERENCES "public"."file_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_file_id_file_set_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_set_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_set_keeps" ADD CONSTRAINT "file_set_keeps_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_sets" ADD CONSTRAINT "file_sets_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_calls" ADD CONSTRAINT "sandbox_calls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_calls" ADD CONSTRAINT "sandbox_calls_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_set_files_path" ON "file_set_files" USING btree ("file_set_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_set_keeps_source" ON "file_set_keeps" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_file_set_keeps_set" ON "file_set_keeps" USING btree ("file_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_sets_name" ON "file_sets" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_sets_slug" ON "file_sets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_sandbox_calls_time" ON "sandbox_calls" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "idx_sandbox_calls_source" ON "sandbox_calls" USING btree ("source_id") WHERE source_id IS NOT NULL;