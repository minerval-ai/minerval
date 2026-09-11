CREATE TABLE "lookout_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lookout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lookout_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lookout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claim_id" uuid,
	"url" text,
	"action_id" uuid,
	"rationale" text NOT NULL,
	"urgency" real,
	"value_written" real,
	"status_at_flag" text,
	"credence_at_flag" real,
	"assessment_id_at_flag" uuid,
	"repeats" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_lookout_flags_kind" CHECK ("lookout_flags"."kind" IN ('reassess', 'ingest', 'note'))
);
--> statement-breakpoint
CREATE TABLE "lookouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"heartbeat_hours" integer DEFAULT 24 NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"max_value" real DEFAULT 6 NOT NULL,
	"max_ingests_per_run" integer DEFAULT 3 NOT NULL,
	"workspace" text,
	"last_note" text,
	"last_run_at" timestamp with time zone,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"flags" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_lookouts_status" CHECK ("lookouts"."status" IN ('active', 'paused', 'retired')),
	CONSTRAINT "ck_lookouts_max_value" CHECK ("lookouts"."max_value" >= 0 AND "lookouts"."max_value" <= 10),
	CONSTRAINT "ck_lookouts_heartbeat" CHECK ("lookouts"."heartbeat_hours" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lookout_events" ADD CONSTRAINT "lookout_events_lookout_id_lookouts_id_fk" FOREIGN KEY ("lookout_id") REFERENCES "public"."lookouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_flags" ADD CONSTRAINT "lookout_flags_lookout_id_lookouts_id_fk" FOREIGN KEY ("lookout_id") REFERENCES "public"."lookouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_flags" ADD CONSTRAINT "lookout_flags_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_flags" ADD CONSTRAINT "lookout_flags_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookouts" ADD CONSTRAINT "lookouts_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_lookout_events_pending" ON "lookout_events" USING btree ("lookout_id","created_at") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_lookout_flags_lookout" ON "lookout_flags" USING btree ("lookout_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lookout_flags_claim" ON "lookout_flags" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_lookouts_grant" ON "lookouts" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lookouts_due" ON "lookouts" USING btree ("next_due_at") WHERE status = 'active';