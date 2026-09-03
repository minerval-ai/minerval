CREATE TABLE "agent_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"surface" text,
	"origin" text DEFAULT 'internal' NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"reporter_contributor_id" uuid,
	"context_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"job_id" uuid,
	"claim_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"triage_note" text,
	"triaged_by" text,
	"triaged_at" timestamp with time zone,
	"duplicate_of_id" uuid,
	"dedupe_key" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_reporter_contributor_id_contributors_id_fk" FOREIGN KEY ("reporter_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_reports_dedupe_key" ON "agent_reports" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_agent_reports_status_seen" ON "agent_reports" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_agent_reports_agent_seen" ON "agent_reports" USING btree ("agent","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_agent_reports_origin_status" ON "agent_reports" USING btree ("origin","status");