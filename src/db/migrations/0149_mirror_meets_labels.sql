-- The mirror and a judgment at each label, brought together.
--
-- The mirror's migration put an `origin` column on the judgment tables and
-- made the views of the judgment in force again to carry it. The migration
-- that gave each label its own version then made those views anew, and the
-- views of a node's versions beside them, from the tables as they stood
-- before that column. They are made once more here, by the same rule, over
-- every column the tables now have. Nothing else changes: the rule for
-- which version is in force is the functions', and those are untouched.
--
-- stated_views arrived on main beside the step that changed every label
-- column's default, so its default is set here as that step sets the others.
DROP VIEW "public"."argument_evaluations_in_force";--> statement-breakpoint
DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
DROP VIEW "public"."question_assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."argument_evaluations_versions";--> statement-breakpoint
DROP VIEW "public"."assessments_versions";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_versions";--> statement-breakpoint
DROP VIEW "public"."question_assessments_versions";--> statement-breakpoint
ALTER TABLE "stated_views" ALTER COLUMN "sensitivity_label" SET DEFAULT minerval_default_label();--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_in_force" WITH (security_invoker = true) AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label", "origin" from "argument_evaluations" where ("argument_evaluations"."is_current" = true and minerval_version_gone_by('argument_evaluations', "argument_evaluations"."argument_id", "argument_evaluations"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", "origin" from "assessments" where ("assessments"."is_current" = true and minerval_version_gone_by('assessments', "assessments"."claim_id", "assessments"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "quantity_estimates" where ("quantity_estimates"."is_current" = true and minerval_version_gone_by('quantity_estimates', "quantity_estimates"."claim_id", "quantity_estimates"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."question_assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "question_assessments" where ("question_assessments"."is_current" = true and minerval_version_gone_by('question_assessments', "question_assessments"."claim_id", "question_assessments"."sensitivity_label")));--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_versions" WITH (security_invoker = true) AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label", "origin", minerval_version_in_force('argument_evaluations', "argument_id", "sensitivity_label") as "in_force" from "argument_evaluations" where "argument_evaluations"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label", "origin", minerval_version_in_force('assessments', "claim_id", "sensitivity_label") as "in_force" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", minerval_version_in_force('quantity_estimates', "claim_id", "sensitivity_label") as "in_force" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."question_assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", minerval_version_in_force('question_assessments', "claim_id", "sensitivity_label") as "in_force" from "question_assessments" where "question_assessments"."is_current" = true);--> statement-breakpoint
-- The views are new objects: on a database that already has a second label
-- the step grants them to the roles the policies bind. On the public graph
-- it finds one label and changes nothing.
SELECT public.minerval_enforcement_sync();
