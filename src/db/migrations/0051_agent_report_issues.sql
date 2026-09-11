CREATE TABLE "agent_report_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" text DEFAULT 'sighting' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"context_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"run_id" uuid,
	"job_id" uuid,
	"claim_id" uuid,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "github_issue_number" integer;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "github_issue_url" text;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "github_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_report_sightings" ADD CONSTRAINT "agent_report_sightings_report_id_agent_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."agent_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_report_sightings_report" ON "agent_report_sightings" USING btree ("report_id","seen_at");--> statement-breakpoint
CREATE INDEX "idx_agent_reports_github_pending" ON "agent_reports" USING btree ("github_issue_number","status","first_seen_at");