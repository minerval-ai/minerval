CREATE TABLE "correspondent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correspondent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "correspondent_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correspondent_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_covered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changes_from" text,
	"changes_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"audience" text NOT NULL,
	"scope_claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scope_tag_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"heartbeat_hours" integer DEFAULT 168 NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_wake_hours" integer DEFAULT 24 NOT NULL,
	"model" text,
	"changes_cursor" text,
	"workspace" text,
	"last_note" text,
	"last_run_at" timestamp with time zone,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"updates" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_correspondents_status" CHECK ("correspondents"."status" IN ('active', 'paused', 'retired')),
	CONSTRAINT "ck_correspondents_heartbeat" CHECK ("correspondents"."heartbeat_hours" >= 0),
	CONSTRAINT "ck_correspondents_min_wake" CHECK ("correspondents"."min_wake_hours" >= 0)
);
--> statement-breakpoint
ALTER TABLE "correspondent_events" ADD CONSTRAINT "correspondent_events_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_updates" ADD CONSTRAINT "correspondent_updates_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_updates" ADD CONSTRAINT "correspondent_updates_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_correspondent_events_pending" ON "correspondent_events" USING btree ("correspondent_id","created_at") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_correspondent_updates_feed" ON "correspondent_updates" USING btree ("correspondent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_correspondents_grant" ON "correspondents" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_correspondents_due" ON "correspondents" USING btree ("next_due_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_assessments_assessed_at" ON "assessments" USING btree ("assessed_at","id");