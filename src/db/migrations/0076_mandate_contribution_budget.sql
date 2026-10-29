-- A mandate's research submits contributions against a dollar budget its
-- Grantmaker delegates (Part VIII): the budget on the run, the submitting
-- run on the contribution, and what each review cost.
ALTER TABLE "contributions" ADD COLUMN "research_run_id" uuid;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "review_cost_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "contribution_budget_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contributions_research_run" ON "contributions" USING btree ("research_run_id") WHERE research_run_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "ck_research_runs_contribution_budget" CHECK (contribution_budget_micro_usd >= 0);