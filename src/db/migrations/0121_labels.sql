-- Labels: who may read a row (src/labels.ts). A label is a row in "labels",
-- and "label_reads" holds which labels a holder of one may also read. The
-- rows that will be held to a clearance (judgments, sources, agent runs) get
-- a "sensitivity_label" column, 'public' on every row that exists. Nothing
-- reads the column yet.
CREATE TABLE "label_reads" (
	"label" text NOT NULL,
	"reads" text NOT NULL,
	CONSTRAINT "label_reads_label_reads_pk" PRIMARY KEY("label","reads")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The one label of the public graph. It goes in before the foreign keys
-- below are added, because each is checked against the rows that already
-- exist, and the column default makes every one of those 'public'.
INSERT INTO "labels" ("name", "description") VALUES ('public', 'Readable by anyone.');--> statement-breakpoint
-- The four views spell their columns out, so they are dropped here and
-- created again at the end with the new column.
DROP VIEW "public"."argument_evaluations_in_force";--> statement-breakpoint
DROP VIEW "public"."assessments_in_force";--> statement-breakpoint
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
DROP VIEW "public"."question_assessments_in_force";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_evaluations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "label_reads" ADD CONSTRAINT "label_reads_label_labels_name_fk" FOREIGN KEY ("label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_reads" ADD CONSTRAINT "label_reads_reads_labels_name_fk" FOREIGN KEY ("reads") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_evaluations" ADD CONSTRAINT "argument_evaluations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD CONSTRAINT "quantity_estimates_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD CONSTRAINT "question_assessments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."argument_evaluations_in_force" AS (select "id", "argument_id", "verdict", "decisive", "content", "assessment_id", "estimate_id", "is_current", "created_by", "created_at", "sensitivity_label" from "argument_evaluations" where "argument_evaluations"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."assessments_in_force" AS (select "id", "claim_id", "status", "confidence", "claim_credence", "summary", "reasoning_trace", "marginal_yield", "model", "funded_by_job_id", "skills", "run_id", "inputs_recorded", "is_current", "subclaim_summary", "trigger", "trigger_context", "assessed_at", "relabeled_from", "sensitivity_label" from "assessments" where "assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."question_assessments_in_force" AS (select "id", "claim_id", "standing", "favored_claim_ids", "summary", "reasoning_trace", "incomplete", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label" from "question_assessments" where "question_assessments"."is_current" = true);