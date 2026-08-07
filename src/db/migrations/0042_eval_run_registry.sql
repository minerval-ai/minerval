CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster" text NOT NULL,
	"kind" text DEFAULT 'score' NOT NULL,
	"config" jsonb NOT NULL,
	"scorecard" jsonb,
	"run_dir" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_eval_runs_cluster_time" ON "eval_runs" USING btree ("cluster","created_at");