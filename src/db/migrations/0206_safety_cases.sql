-- Safety cases (constitution §7b, #1211): the second artifact kind with a
-- suggested structure. artifact_specs admits subtype 'safety_case' with the
-- case's own specification (system, deployment, the claim it argues for, the
-- standard and whose it is, the framework, what it does not cover), and a
-- list's two required fields are required of a list alone. case_elements
-- holds the case's structure as its Steward writes it. artifact_assessments
-- gains the case's second judgment: whether it establishes its conclusion to
-- its standard. A released page may carry an artifact's judgment
-- (release_pages.judgment_kind).
--
-- The two views over artifact_assessments are made again with the new
-- columns. Nothing else reads them by column list.
CREATE TABLE "case_elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"element_type" text NOT NULL,
	"parent_id" uuid,
	"node_id" uuid,
	"argument_id" uuid,
	"block" text,
	"statement" text NOT NULL,
	"standing" text,
	"standing_reason" text,
	"accepted_by" text,
	"acceptance" text,
	"departure" text,
	"raised_in_published" boolean,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "ck_case_elements_origin" CHECK ("case_elements"."origin" IN ('local', 'mirror')),
	CONSTRAINT "ck_case_elements_type" CHECK ("case_elements"."element_type" IN ('claim', 'step', 'side_claim', 'evidence', 'defeater')),
	CONSTRAINT "ck_case_elements_step" CHECK (CASE WHEN "case_elements"."element_type" = 'step'
               THEN "case_elements"."node_id" IS NULL AND "case_elements"."block" IN ('decomposition', 'substitution', 'concretion', 'calculation', 'evidence_incorporation')
               ELSE "case_elements"."node_id" IS NOT NULL AND "case_elements"."block" IS NULL AND "case_elements"."argument_id" IS NULL END),
	CONSTRAINT "ck_case_elements_defeater" CHECK (CASE WHEN "case_elements"."element_type" = 'defeater'
               THEN "case_elements"."standing" IN ('open', 'answered', 'sustained')
                    AND ("case_elements"."accepted_by" IS NULL OR ("case_elements"."standing" = 'sustained' AND "case_elements"."acceptance" IS NOT NULL))
               ELSE "case_elements"."standing" IS NULL AND "case_elements"."accepted_by" IS NULL AND "case_elements"."acceptance" IS NULL END)
);
--> statement-breakpoint
DROP VIEW "public"."artifact_assessments_versions";--> statement-breakpoint
DROP VIEW "public"."artifact_assessments_in_force";--> statement-breakpoint
ALTER TABLE "artifact_specs" DROP CONSTRAINT "ck_artifact_specs_subtype";--> statement-breakpoint
ALTER TABLE "release_pages" DROP CONSTRAINT "ck_release_pages_kind";--> statement-breakpoint
ALTER TABLE "artifact_specs" ALTER COLUMN "purpose" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_specs" ALTER COLUMN "inclusion" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD COLUMN "verdict_basis" text;--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD COLUMN "would_change" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "system" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "deployment" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "conclusion_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "standard" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "standard_of" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "framework" text;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD COLUMN "not_covered" text;--> statement-breakpoint
ALTER TABLE "case_elements" ADD CONSTRAINT "case_elements_case_id_claims_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_elements" ADD CONSTRAINT "case_elements_parent_id_case_elements_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."case_elements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_elements" ADD CONSTRAINT "case_elements_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_elements" ADD CONSTRAINT "case_elements_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_elements" ADD CONSTRAINT "case_elements_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_case_elements_case" ON "case_elements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_case_elements_parent" ON "case_elements" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_case_elements_node" ON "case_elements" USING btree ("node_id") WHERE node_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "artifact_specs_conclusion_claim_id_claims_id_fk" FOREIGN KEY ("conclusion_claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_assessments" ADD CONSTRAINT "ck_artifact_assessments_verdict" CHECK ("artifact_assessments"."verdict" IS NULL OR ("artifact_assessments"."verdict" IN ('established', 'not_established') AND "artifact_assessments"."verdict_basis" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "ck_artifact_specs_list" CHECK ("artifact_specs"."subtype" <> 'list' OR ("artifact_specs"."purpose" IS NOT NULL AND "artifact_specs"."inclusion" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "ck_artifact_specs_safety_case" CHECK ("artifact_specs"."subtype" <> 'safety_case' OR ("artifact_specs"."system" IS NOT NULL AND "artifact_specs"."deployment" IS NOT NULL
          AND "artifact_specs"."conclusion_claim_id" IS NOT NULL AND "artifact_specs"."standard" IS NOT NULL AND "artifact_specs"."standard_of" IS NOT NULL
          AND "artifact_specs"."framework" IN ('assurance_2_cae', 'none')));--> statement-breakpoint
ALTER TABLE "artifact_specs" ADD CONSTRAINT "ck_artifact_specs_subtype" CHECK ("artifact_specs"."subtype" IN ('list', 'safety_case'));--> statement-breakpoint
ALTER TABLE "release_pages" ADD CONSTRAINT "ck_release_pages_kind" CHECK (CASE WHEN "release_pages"."node_id" IS NULL THEN "release_pages"."judgment_kind" IS NULL AND "release_pages"."version_key" IS NOT NULL
               ELSE "release_pages"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment', 'artifact_assessment') AND "release_pages"."judgment_id" IS NOT NULL END);--> statement-breakpoint
CREATE VIEW "public"."artifact_assessments_versions" WITH (security_invoker = true) AS (select "id", "claim_id", "fidelity", "summary", "reasoning_trace", "gaps", "entry_order", "left_out", "verdict", "verdict_basis", "would_change", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin", minerval_version_in_force('artifact_assessments', "claim_id", "sensitivity_label") as "in_force" from "artifact_assessments" where "artifact_assessments"."is_current" = true);--> statement-breakpoint
CREATE VIEW "public"."artifact_assessments_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "fidelity", "summary", "reasoning_trace", "gaps", "entry_order", "left_out", "verdict", "verdict_basis", "would_change", "confidence", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "artifact_assessments" where ("artifact_assessments"."is_current" = true and minerval_version_gone_by('artifact_assessments', "artifact_assessments"."claim_id", "artifact_assessments"."sensitivity_label")));
--> statement-breakpoint
-- case_elements is mirrored with the specification it belongs to
-- (mirror-manifest.ts): a mirrored row is the public graph's, written by the
-- applier alone, as 0173 guards the other artifact tables.
CREATE TRIGGER "mirror_row_guard_insert" BEFORE INSERT ON "case_elements" FOR EACH ROW WHEN (NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_update" BEFORE UPDATE ON "case_elements" FOR EACH ROW WHEN (OLD."origin" = 'mirror' OR NEW."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();--> statement-breakpoint
CREATE TRIGGER "mirror_row_guard_delete" BEFORE DELETE ON "case_elements" FOR EACH ROW WHEN (OLD."origin" = 'mirror') EXECUTE FUNCTION mirror_row_guard();
--> statement-breakpoint
-- The new table and the remade views are held as every other is where a
-- deployment has more than one label.
SELECT public.minerval_enforcement_sync();
