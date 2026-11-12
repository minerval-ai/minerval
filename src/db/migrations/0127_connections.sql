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
	"sensitivity_label" text DEFAULT 'public' NOT NULL
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
	"withdrawn_reason" text
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
	"sensitivity_label" text DEFAULT 'public' NOT NULL,
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
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_offered_by_contributors_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_connection_time" ON "connection_calls" USING btree ("connection_id","called_at");--> statement-breakpoint
CREATE INDEX "idx_connection_calls_source" ON "connection_calls" USING btree ("source_id") WHERE source_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connection_tools_name" ON "connection_tools" USING btree ("connection_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connections_name" ON "connections" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connections_tool_prefix" ON "connections" USING btree ("tool_prefix");