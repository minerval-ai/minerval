CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text NOT NULL,
	"user_id" uuid,
	"job_id" uuid,
	"claim_id" uuid,
	"request_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	"steps" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_agent_time" ON "agent_runs" USING btree ("agent","started_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_claim" ON "agent_runs" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_job" ON "agent_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_agent_steps_run" ON "agent_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_run" ON "llm_usage" USING btree ("run_id");