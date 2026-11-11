CREATE TABLE "judgment_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"judgment_kind" text NOT NULL,
	"judgment_id" uuid NOT NULL,
	"input_kind" text NOT NULL,
	"node_id" uuid,
	"relation_type" text,
	"input_judgment_id" uuid,
	"source_id" uuid,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_judgment_inputs_judgment_kind" CHECK ("judgment_inputs"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment')),
	CONSTRAINT "ck_judgment_inputs_input_kind" CHECK ("judgment_inputs"."input_kind" IN ('premise', 'source')),
	CONSTRAINT "ck_judgment_inputs_shape" CHECK (("judgment_inputs"."input_kind" = 'premise' AND "judgment_inputs"."node_id" IS NOT NULL AND "judgment_inputs"."relation_type" IS NOT NULL AND "judgment_inputs"."source_id" IS NULL)
        OR ("judgment_inputs"."input_kind" = 'source' AND "judgment_inputs"."source_id" IS NOT NULL AND "judgment_inputs"."node_id" IS NULL))
);
--> statement-breakpoint
DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
DROP VIEW "public"."question_assessments_in_force";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "inputs_recorded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD COLUMN "inputs_recorded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD COLUMN "inputs_recorded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_judgment_inputs_judgment" ON "judgment_inputs" USING btree ("judgment_kind","judgment_id");--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."question_assessments_in_force" AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at" from "question_assessments" where "question_assessments"."is_current" = true);