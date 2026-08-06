ALTER TABLE "actions" ADD COLUMN "metered_job_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_action_allocations_live_placement" ON "action_allocations" USING btree ("grant_id","exclusion_group",(COALESCE("action_id"::text, ''))) WHERE released_at IS NULL AND grant_id IS NOT NULL AND spent_micro_usd < amount_micro_usd;--> statement-breakpoint
CREATE INDEX "idx_actions_metered_job" ON "actions" USING btree ("metered_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_open_per_claim" ON "assessment_orders" USING btree ("user_id","claim_id") WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_llm_usage_job" ON "llm_usage" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "ck_action_allocations_one_funder" CHECK ((grant_id IS NULL) <> (user_id IS NULL));--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "ck_action_allocations_amount" CHECK (amount_micro_usd > 0);--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "ck_action_allocations_spent" CHECK (spent_micro_usd >= 0 AND spent_micro_usd <= amount_micro_usd);--> statement-breakpoint
ALTER TABLE "regrants" ADD CONSTRAINT "ck_regrants_amount" CHECK (amount_micro_usd > 0);--> statement-breakpoint
ALTER TABLE "regrants" ADD CONSTRAINT "ck_regrants_refunded" CHECK (refunded_micro_usd >= 0 AND refunded_micro_usd <= amount_micro_usd);