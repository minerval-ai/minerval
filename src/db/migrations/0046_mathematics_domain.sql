CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contribution_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage" text DEFAULT 'db' NOT NULL,
	"body" "bytea",
	"storage_key" text,
	"visibility" text DEFAULT 'restricted' NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_attachments_size" CHECK (size_bytes >= 0),
	CONSTRAINT "ck_attachments_body_location" CHECK ((storage = 'db' AND body IS NOT NULL) OR (storage = 's3' AND storage_key IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"formalization_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"condition_type" text DEFAULT 'lean_statement' NOT NULL,
	"resolution" text DEFAULT 'either' NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"rules_version" text NOT NULL,
	"posted_by_grant_id" uuid,
	"rationale" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"human_confirmed_at" timestamp with time zone,
	"human_confirmed_by" text,
	"withdraw_effective_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_bounties_amount" CHECK (amount_micro_usd > 0)
);
--> statement-breakpoint
CREATE TABLE "claim_formalizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"language" text DEFAULT 'lean4' NOT NULL,
	"pin_id" text NOT NULL,
	"lean_toolchain" text NOT NULL,
	"mathlib_rev" text NOT NULL,
	"mathlib_tag" text,
	"image_digest" text NOT NULL,
	"namespace" text NOT NULL,
	"statement_source" text NOT NULL,
	"source_hash" text NOT NULL,
	"expr_hash" text NOT NULL,
	"pp_type" text NOT NULL,
	"constants" jsonb NOT NULL,
	"definitions_axioms" jsonb NOT NULL,
	"witness_present" boolean NOT NULL,
	"correspondence" text,
	"review_notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"authored_by" text NOT NULL,
	"model" text,
	"created_by_run_id" uuid,
	"reviewed_by_run_id" uuid,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"review_period_ends_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_claim_formalizations_claim_version" UNIQUE("claim_id","version")
);
--> statement-breakpoint
CREATE TABLE "lean_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"formalization_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"kind" text NOT NULL,
	"submission_sha256" text NOT NULL,
	"submission_source" text NOT NULL,
	"submitted_by" text NOT NULL,
	"prize_claim_id" uuid,
	"attempt_id" uuid,
	"run_id" uuid,
	"verdict" text NOT NULL,
	"checks" jsonb NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"resource" jsonb NOT NULL,
	"pin_id" text NOT NULL,
	"image_digest" text NOT NULL,
	"checker_version" text NOT NULL,
	"second_opinion" jsonb,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_lean_checks_submission" UNIQUE("formalization_id","submission_sha256","checker_version","mode")
);
--> statement-breakpoint
CREATE TABLE "platform_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prize_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contribution_id" uuid NOT NULL,
	"bounty_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"formalization_id" uuid NOT NULL,
	"claimant_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"rejected_stage" text,
	"lean_check_id" uuid,
	"check_attempts" integer DEFAULT 0 NOT NULL,
	"tie_group" uuid,
	"steward_decision" jsonb,
	"result_category" text,
	"defect_award_micro_usd" bigint,
	"window_ends_at" timestamp with time zone,
	"window_paused_ms" bigint DEFAULT 0 NOT NULL,
	"audit_outcome" text,
	"signed_off_at" timestamp with time zone,
	"signed_off_by" text,
	"payee" jsonb,
	"credit_name" text,
	"tools_disclosure" text,
	"declarations" jsonb,
	"rules_version" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_claims_contribution_id_unique" UNIQUE("contribution_id"),
	CONSTRAINT "ck_prize_claims_defect_award" CHECK (defect_award_micro_usd IS NULL OR defect_award_micro_usd >= 0),
	CONSTRAINT "ck_prize_claims_window_paused" CHECK (window_paused_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "prize_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prize_claim_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"withholding_micro_usd" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"payee_country" text,
	"tax_form_kind" text,
	"screening_result" text,
	"provider" text DEFAULT 'internal' NOT NULL,
	"provider_payee_id" text,
	"provider_payout_id" text,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "prize_payouts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_prize_payouts_amount" CHECK (amount_micro_usd > 0),
	CONSTRAINT "ck_prize_payouts_withholding" CHECK (withholding_micro_usd >= 0 AND withholding_micro_usd <= amount_micro_usd)
);
--> statement-breakpoint
CREATE TABLE "prize_pool_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"reason" text NOT NULL,
	"bounty_id" uuid,
	"prize_claim_id" uuid,
	"bank_reference" text,
	"stripe_event_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_pool_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_prize_pool_entries_reason" CHECK (reason IN ('platform_deposit', 'sponsorship', 'owl_prize', 'withholding_remitted', 'defect_award', 'review_award', 'admin_adjust', 'payout'))
);
--> statement-breakpoint
CREATE TABLE "prize_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_pools_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "proof_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"formalization_id" uuid NOT NULL,
	"action_id" uuid,
	"run_id" uuid,
	"grant_id" uuid,
	"job_id" uuid,
	"model" text NOT NULL,
	"variant" text NOT NULL,
	"effort" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"report" jsonb,
	"lean_proof" text,
	"lean_check_id" uuid,
	"notebook" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_calibration" boolean DEFAULT false NOT NULL,
	"ceiling_micro_usd" bigint NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"compactions" integer DEFAULT 0 NOT NULL,
	"served_models" jsonb,
	"published_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "ck_proof_attempts_ceiling" CHECK (ceiling_micro_usd > 0),
	CONSTRAINT "ck_proof_attempts_spent" CHECK (spent_micro_usd >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "skills" text[];--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "skills" text[];--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "domains_source" text;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "challenged_formalization_id" uuid;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "challenged_prize_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "owls_prized_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "prize_ineligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "skills" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "external_units" numeric;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "external_unit_kind" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_id_contributors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_formalization_id_claim_formalizations_id_fk" FOREIGN KEY ("formalization_id") REFERENCES "public"."claim_formalizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_pool_id_prize_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."prize_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_posted_by_grant_id_grants_id_fk" FOREIGN KEY ("posted_by_grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD CONSTRAINT "claim_formalizations_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD CONSTRAINT "claim_formalizations_superseded_by_claim_formalizations_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."claim_formalizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lean_checks" ADD CONSTRAINT "lean_checks_formalization_id_claim_formalizations_id_fk" FOREIGN KEY ("formalization_id") REFERENCES "public"."claim_formalizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_formalization_id_claim_formalizations_id_fk" FOREIGN KEY ("formalization_id") REFERENCES "public"."claim_formalizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_claimant_id_contributors_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_lean_check_id_lean_checks_id_fk" FOREIGN KEY ("lean_check_id") REFERENCES "public"."lean_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_payouts" ADD CONSTRAINT "prize_payouts_prize_claim_id_prize_claims_id_fk" FOREIGN KEY ("prize_claim_id") REFERENCES "public"."prize_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_pool_entries" ADD CONSTRAINT "prize_pool_entries_pool_id_prize_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."prize_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_attempts" ADD CONSTRAINT "proof_attempts_formalization_id_claim_formalizations_id_fk" FOREIGN KEY ("formalization_id") REFERENCES "public"."claim_formalizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_attempts" ADD CONSTRAINT "proof_attempts_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_attempts" ADD CONSTRAINT "proof_attempts_lean_check_id_lean_checks_id_fk" FOREIGN KEY ("lean_check_id") REFERENCES "public"."lean_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachments_contribution" ON "attachments" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_sha256" ON "attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "idx_bounties_claim" ON "bounties" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_bounties_status" ON "bounties" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bounties_formalization" ON "bounties" USING btree ("formalization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bounty_live_per_claim" ON "bounties" USING btree ("claim_id") WHERE status IN ('requested', 'confirm_pending', 'open', 'claim_pending', 'house_result_pending', 'rebinding');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_formalization_published" ON "claim_formalizations" USING btree ("claim_id") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "idx_claim_formalizations_claim" ON "claim_formalizations" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_lean_checks_formalization" ON "lean_checks" USING btree ("formalization_id");--> statement-breakpoint
CREATE INDEX "idx_lean_checks_submission_sha256" ON "lean_checks" USING btree ("submission_sha256");--> statement-breakpoint
CREATE INDEX "idx_prize_claims_bounty_status" ON "prize_claims" USING btree ("bounty_id","status");--> statement-breakpoint
CREATE INDEX "idx_prize_claims_claimant" ON "prize_claims" USING btree ("claimant_id");--> statement-breakpoint
CREATE INDEX "idx_prize_claims_formalization_status" ON "prize_claims" USING btree ("formalization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prize_claim_live_per_claimant" ON "prize_claims" USING btree ("claimant_id","formalization_id") WHERE status IN ('queued', 'checking', 'check_error', 'checked', 'in_review', 'in_challenge_window', 'payable', 'defect_award_pending');--> statement-breakpoint
CREATE INDEX "idx_prize_payouts_claim" ON "prize_payouts" USING btree ("prize_claim_id");--> statement-breakpoint
CREATE INDEX "idx_prize_pool_entries_pool" ON "prize_pool_entries" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "idx_prize_pool_entries_bounty" ON "prize_pool_entries" USING btree ("bounty_id");--> statement-breakpoint
CREATE INDEX "idx_proof_attempts_claim" ON "proof_attempts" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_proof_attempts_status" ON "proof_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_proof_attempts_formalization" ON "proof_attempts" USING btree ("formalization_id");--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_challenged_formalization_id_claim_formalizations_id_fk" FOREIGN KEY ("challenged_formalization_id") REFERENCES "public"."claim_formalizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_challenged_prize_claim_id_prize_claims_id_fk" FOREIGN KEY ("challenged_prize_claim_id") REFERENCES "public"."prize_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_claims_domains" ON "claims" USING gin ("domains");