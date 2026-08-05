CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funder_user_id" uuid NOT NULL,
	"budget_job_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_claim_id" uuid,
	"scope_query" text,
	"policy" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" jsonb,
	"plan_cursor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "funded_by_job_id" uuid;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_funder_user_id_contributors_id_fk" FOREIGN KEY ("funder_user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_budget_job_id_budget_jobs_id_fk" FOREIGN KEY ("budget_job_id") REFERENCES "public"."budget_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_scope_claim_id_claims_id_fk" FOREIGN KEY ("scope_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_grants_funder" ON "grants" USING btree ("funder_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_grants_status" ON "grants" USING btree ("status");