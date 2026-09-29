CREATE TABLE "curation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anchor_claim_id" uuid NOT NULL,
	"other_claim_id" uuid,
	"source" text NOT NULL,
	"concern" text NOT NULL,
	"signal" real,
	"requested_by_claim_id" uuid,
	"requested_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_by_action_id" uuid,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "ck_curation_requests_source" CHECK (source IN ('steward_escalation', 'reconcile_candidate', 'operator'))
);
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "subject_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "bounty_id" uuid;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "curation_requests_anchor_claim_id_claims_id_fk" FOREIGN KEY ("anchor_claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "curation_requests_other_claim_id_claims_id_fk" FOREIGN KEY ("other_claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "curation_requests_requested_by_claim_id_claims_id_fk" FOREIGN KEY ("requested_by_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "curation_requests_consumed_by_action_id_actions_id_fk" FOREIGN KEY ("consumed_by_action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_curation_requests_live" ON "curation_requests" USING btree ("anchor_claim_id",COALESCE("other_claim_id", '00000000-0000-0000-0000-000000000000'::uuid),"source") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_curation_requests_anchor_live" ON "curation_requests" USING btree ("anchor_claim_id") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_curation_requests_requester_live" ON "curation_requests" USING btree ("requested_by_claim_id") WHERE consumed_at IS NULL;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_subject_grant_id_grants_id_fk" FOREIGN KEY ("subject_grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_runs_action" ON "audit_runs" USING btree ("action_id");