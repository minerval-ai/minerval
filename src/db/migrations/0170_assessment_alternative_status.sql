DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."assessments_versions";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "alternative_status" text;--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "alternative_status", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", "origin" from "assessments" where ("assessments"."is_current" = true and minerval_version_gone_by('assessments', "assessments"."claim_id", "assessments"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "alternative_status", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", "origin", minerval_version_in_force('assessments', "claim_id", "sensitivity_label") as "in_force" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
-- The two views were dropped and made again; where a deployment has more
-- than one label they are held again as every view is.
SELECT public.minerval_enforcement_sync();
