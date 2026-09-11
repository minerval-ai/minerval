CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid,
	"grant_id" uuid,
	"requested_by" text NOT NULL,
	"requester_run_id" uuid,
	"run_id" uuid,
	"job_id" uuid,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"model_tier" text NOT NULL,
	"effort" text,
	"include_constitution" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ceiling_micro_usd" bigint NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"served_models" jsonb,
	"report" jsonb,
	"notebook" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "ck_research_runs_ceiling" CHECK (ceiling_micro_usd > 0),
	CONSTRAINT "ck_research_runs_spent" CHECK (spent_micro_usd >= 0)
);
--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_research_runs_claim" ON "research_runs" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_research_runs_grant" ON "research_runs" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_research_runs_status" ON "research_runs" USING btree ("status");