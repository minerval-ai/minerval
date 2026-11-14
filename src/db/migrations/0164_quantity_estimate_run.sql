DROP VIEW "public"."quantity_estimates_versions";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", "run_id", minerval_version_in_force('quantity_estimates', "claim_id", "sensitivity_label") as "in_force" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", "run_id" from "quantity_estimates" where ("quantity_estimates"."is_current" = true and minerval_version_gone_by('quantity_estimates', "quantity_estimates"."claim_id", "quantity_estimates"."sensitivity_label")));--> statement-breakpoint
-- Link existing estimates made here to the Steward run that wrote them,
-- where that run is still recorded, as 0096 did for assessments and
-- questions: the Steward run on the same node that was open when the
-- estimate was written (the latest to start, should two overlap). A
-- mirrored estimate's run is the publisher's and is not found here.
UPDATE "quantity_estimates" e SET "run_id" = (
  SELECT r.id FROM "agent_runs" r
   WHERE r.agent = 'steward'
     AND r.claim_id = e.claim_id
     AND r.started_at <= e.assessed_at
     AND (r.finished_at IS NULL OR r.finished_at >= e.assessed_at)
   ORDER BY r.started_at DESC
   LIMIT 1
) WHERE e.run_id IS NULL AND e.origin = 'local';--> statement-breakpoint
-- The two views were dropped and made again; where a deployment has more
-- than one label they are held again as every view is.
SELECT public.minerval_enforcement_sync();
