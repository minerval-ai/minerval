DROP INDEX "idx_action_allocations_grant";--> statement-breakpoint
DROP INDEX "idx_agent_runs_job";--> statement-breakpoint
DROP INDEX "idx_llm_usage_job";--> statement-breakpoint
CREATE INDEX "idx_agent_findings_job" ON "agent_findings" USING btree ("job_id") WHERE job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_assessments_funded_by_job" ON "assessments" USING btree ("funded_by_job_id","assessed_at") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_contributions_funded_by_job" ON "contributions" USING btree ("funded_by_job_id") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_owl_ledger_job" ON "owl_ledger" USING btree ("job_id","reason") WHERE job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_quantity_estimates_funded_by_job" ON "quantity_estimates" USING btree ("funded_by_job_id") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_question_assessments_funded_by_job" ON "question_assessments" USING btree ("funded_by_job_id") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_request_work_funded_by_job" ON "request_work" USING btree ("funded_by_job_id") WHERE funded_by_job_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_action_allocations_grant" ON "action_allocations" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_job" ON "agent_runs" USING btree ("job_id","agent","started_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_job" ON "llm_usage" USING btree ("job_id","cost_micro_usd");