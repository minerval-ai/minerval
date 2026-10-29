-- Node kinds and requests (constitution §2, §3, §7a, §10, Part VIII).
-- claims.kind marks a node as a claim, a quantity or a question; a
-- quantity's definition, estimates, readings and cuts and a question's
-- assessments and answer relations get tables of their own, so
-- `assessments` stays a record of verdicts on propositions. Every existing
-- node is a claim (the column default). Requests, their targets and the work
-- done on them are new.
CREATE TABLE "answer_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"claim_a_id" uuid NOT NULL,
	"claim_b_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"reasoning" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_answer_relations_ordered" CHECK ("answer_relations"."claim_a_id" < "answer_relations"."claim_b_id"),
	CONSTRAINT "ck_answer_relations_relation" CHECK ("answer_relations"."relation" IN ('excludes', 'compatible'))
);
--> statement-breakpoint
CREATE TABLE "quantity_cuts" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"quantity_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"value" real NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_quantity_cuts_direction" CHECK ("quantity_cuts"."direction" IN ('above', 'below')),
	CONSTRAINT "ck_quantity_cuts_self" CHECK ("quantity_cuts"."claim_id" != "quantity_cuts"."quantity_id")
);
--> statement-breakpoint
CREATE TABLE "quantity_definitions" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"measures" text NOT NULL,
	"population" text,
	"conditions" text,
	"unit" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quantity_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"estimate" jsonb NOT NULL,
	"summary" text,
	"work" text NOT NULL,
	"model" text,
	"funded_by_job_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"trigger" text,
	"trigger_context" text,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quantity_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"measured" text NOT NULL,
	"figure" text NOT NULL,
	"bearing" text NOT NULL,
	"bearing_claim_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"standing" text NOT NULL,
	"favored_claim_ids" uuid[] DEFAULT '{}' NOT NULL,
	"summary" text,
	"reasoning_trace" text NOT NULL,
	"incomplete" text,
	"model" text,
	"funded_by_job_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"trigger" text,
	"trigger_context" text,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_question_assessments_standing" CHECK ("question_assessments"."standing" IN ('answered', 'leaning', 'open', 'ill_posed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "request_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"claim_id" uuid,
	"source_id" uuid,
	CONSTRAINT "ck_request_targets_one" CHECK (("request_targets"."claim_id" IS NULL) != ("request_targets"."source_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "request_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"by_label" text NOT NULL,
	"contributor_id" uuid,
	"research_run_id" uuid,
	"outcome" text,
	"summary" text NOT NULL,
	"funded_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_request_work_outcome" CHECK ("request_work"."outcome" IS NULL OR "request_work"."outcome" IN ('met', 'partly_met', 'negative', 'cannot_be_met', 'declined', 'revise'))
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ask" text NOT NULL,
	"why" text NOT NULL,
	"satisfied_by" text NOT NULL,
	"who_could" text,
	"addressed_to" text,
	"bears_on_text" text,
	"filer_kind" text NOT NULL,
	"filer_agent" text,
	"filer_contributor_id" uuid,
	"filer_grant_id" uuid,
	"filer_run_id" uuid,
	"keeper_kind" text NOT NULL,
	"keeper_claim_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"state_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "ck_requests_filer_kind" CHECK ("requests"."filer_kind" IN ('admin', 'contributor', 'mandate')),
	CONSTRAINT "ck_requests_keeper_kind" CHECK ("requests"."keeper_kind" IN ('steward', 'curator')),
	CONSTRAINT "ck_requests_keeper_claim" CHECK (("requests"."keeper_kind" = 'steward') = ("requests"."keeper_claim_id" IS NOT NULL)),
	CONSTRAINT "ck_requests_state" CHECK ("requests"."state" IN ('open', 'addressed', 'in_progress', 'met', 'declined', 'withdrawn', 'moot'))
);
--> statement-breakpoint
ALTER TABLE "arguments" ADD COLUMN "shows" jsonb;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "stated_estimate" jsonb;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "argument_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "answer_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "answer_basis" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "kind" text DEFAULT 'claim' NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_relations" ADD CONSTRAINT "answer_relations_question_id_claims_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_relations" ADD CONSTRAINT "answer_relations_claim_a_id_claims_id_fk" FOREIGN KEY ("claim_a_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_relations" ADD CONSTRAINT "answer_relations_claim_b_id_claims_id_fk" FOREIGN KEY ("claim_b_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "quantity_cuts_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "quantity_cuts_quantity_id_claims_id_fk" FOREIGN KEY ("quantity_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD CONSTRAINT "quantity_definitions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD CONSTRAINT "quantity_estimates_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD CONSTRAINT "quantity_readings_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD CONSTRAINT "quantity_readings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD CONSTRAINT "quantity_readings_bearing_claim_id_claims_id_fk" FOREIGN KEY ("bearing_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD CONSTRAINT "question_assessments_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_targets" ADD CONSTRAINT "request_targets_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_targets" ADD CONSTRAINT "request_targets_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_targets" ADD CONSTRAINT "request_targets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_work" ADD CONSTRAINT "request_work_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_work" ADD CONSTRAINT "request_work_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_work" ADD CONSTRAINT "request_work_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_filer_contributor_id_contributors_id_fk" FOREIGN KEY ("filer_contributor_id") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_filer_grant_id_grants_id_fk" FOREIGN KEY ("filer_grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_keeper_claim_id_claims_id_fk" FOREIGN KEY ("keeper_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_answer_relations_pair" ON "answer_relations" USING btree ("question_id","claim_a_id","claim_b_id");--> statement-breakpoint
CREATE INDEX "idx_quantity_cuts_quantity" ON "quantity_cuts" USING btree ("quantity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_quantity_estimates_current" ON "quantity_estimates" USING btree ("claim_id") WHERE "quantity_estimates"."is_current" = true;--> statement-breakpoint
CREATE INDEX "idx_quantity_estimates_claim" ON "quantity_estimates" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_quantity_readings_claim" ON "quantity_readings" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_question_assessments_current" ON "question_assessments" USING btree ("claim_id") WHERE "question_assessments"."is_current" = true;--> statement-breakpoint
CREATE INDEX "idx_question_assessments_claim" ON "question_assessments" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_request_targets_request" ON "request_targets" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_request_targets_claim" ON "request_targets" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_request_targets_unique" ON "request_targets" USING btree ("request_id",COALESCE("claim_id", "source_id"));--> statement-breakpoint
CREATE INDEX "idx_request_work_request" ON "request_work" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_requests_state" ON "requests" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_requests_keeper" ON "requests" USING btree ("keeper_claim_id");--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "claim_instances_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "claim_instances_answer_claim_id_claims_id_fk" FOREIGN KEY ("answer_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "ck_cr_answer_basis" CHECK ("claim_relationships"."answer_basis" IS NULL OR ("claim_relationships"."relation_type" = 'answers' AND "claim_relationships"."answer_basis" IN ('quality', 'prominence', 'both')));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_kind" CHECK ("claims"."kind" IN ('claim', 'quantity', 'question'));