CREATE TABLE "mandate_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"decided_by" text NOT NULL,
	"item_kind" text NOT NULL,
	"decision" text NOT NULL,
	"target" text,
	"owls_micro_usd" bigint,
	"reason" text,
	"petition_id" uuid,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandate_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_node_id" uuid,
	"target_ref" text,
	"source" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by" text,
	"escalated_at" timestamp with time zone,
	"escalation_note" text
);
--> statement-breakpoint
CREATE TABLE "mandate_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"part" text NOT NULL,
	"section" text,
	"content" jsonb NOT NULL,
	"note" text,
	"author" text NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "petitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"asked_micro_usd" bigint NOT NULL,
	"plan" text NOT NULL,
	"why" text,
	"if_refused" text,
	"requester_agent" text,
	"requester_action_id" uuid,
	"requester_node_id" uuid,
	"chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waiting" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"granted_micro_usd" bigint,
	"decided_by" text,
	"reason" text,
	"follow_up_commissioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "petitions_kind_check" CHECK ("petitions"."kind" IN ('more_budget', 'follow_up')),
	CONSTRAINT "petitions_status_check" CHECK ("petitions"."status" IN ('pending', 'escalated', 'granted', 'refused', 'follow_up'))
);
--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "officer_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandate_decisions" ADD CONSTRAINT "mandate_decisions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_decisions" ADD CONSTRAINT "mandate_decisions_petition_id_petitions_id_fk" FOREIGN KEY ("petition_id") REFERENCES "public"."petitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_decisions" ADD CONSTRAINT "mandate_decisions_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD CONSTRAINT "mandate_inbox_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD CONSTRAINT "mandate_inbox_target_node_id_claims_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_policy_versions" ADD CONSTRAINT "mandate_policy_versions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitions" ADD CONSTRAINT "petitions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitions" ADD CONSTRAINT "petitions_requester_action_id_actions_id_fk" FOREIGN KEY ("requester_action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitions" ADD CONSTRAINT "petitions_requester_node_id_claims_id_fk" FOREIGN KEY ("requester_node_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mandate_decisions_grant" ON "mandate_decisions" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_mandate_inbox_open" ON "mandate_inbox" USING btree ("grant_id","created_at") WHERE handled_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_mandate_policy_versions_grant" ON "mandate_policy_versions" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_petitions_open" ON "petitions" USING btree ("grant_id","created_at") WHERE status IN ('pending', 'escalated');