CREATE TABLE "assessment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"contribution_id" uuid,
	"price_micro_usd" bigint NOT NULL,
	"charge_entry_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budget_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claim_id" uuid,
	"budget_micro_usd" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"checkpoint" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claim_stakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"source" text DEFAULT 'order' NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_orders" ADD CONSTRAINT "assessment_orders_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_orders" ADD CONSTRAINT "assessment_orders_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_orders" ADD CONSTRAINT "assessment_orders_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_orders" ADD CONSTRAINT "assessment_orders_charge_entry_id_owl_ledger_id_fk" FOREIGN KEY ("charge_entry_id") REFERENCES "public"."owl_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_jobs" ADD CONSTRAINT "budget_jobs_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_jobs" ADD CONSTRAINT "budget_jobs_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_stakes" ADD CONSTRAINT "claim_stakes_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_stakes" ADD CONSTRAINT "claim_stakes_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_stakes" ADD CONSTRAINT "claim_stakes_order_id_assessment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."assessment_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orders_pending" ON "assessment_orders" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_orders_user_time" ON "assessment_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_orders_claim" ON "assessment_orders" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_budget_jobs_user_time" ON "budget_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_budget_jobs_running" ON "budget_jobs" USING btree ("updated_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "idx_claim_stakes_claim" ON "claim_stakes" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_claim_stakes_user" ON "claim_stakes" USING btree ("user_id");