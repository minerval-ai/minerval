CREATE TABLE "enqueue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"trigger" text,
	"claim_id" uuid,
	"job_id" uuid,
	"contribution_id" uuid,
	"source_agent" text,
	"source_run_id" uuid,
	"source_claim_id" uuid,
	"coalesced" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_depth_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_key" text,
	"steward_pending" integer DEFAULT 0 NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_depth_snapshots_period_key_unique" UNIQUE("period_key")
);
--> statement-breakpoint
CREATE INDEX "idx_enqueue_events_queue_time" ON "enqueue_events" USING btree ("queue","created_at");--> statement-breakpoint
CREATE INDEX "idx_enqueue_events_source_run" ON "enqueue_events" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "idx_enqueue_events_claim" ON "enqueue_events" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_queue_depth_snapshots_time" ON "queue_depth_snapshots" USING btree ("created_at");