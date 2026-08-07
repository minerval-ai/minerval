CREATE TABLE "action_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text DEFAULT 'assess' NOT NULL,
	"claim_id" uuid NOT NULL,
	"grant_id" uuid,
	"user_id" uuid,
	"amount_micro_usd" bigint NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "claim_stakes" CASCADE;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "daily_budget_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "allocation_policy" jsonb;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_action_allocations_claim" ON "action_allocations" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_action_allocations_grant" ON "action_allocations" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_action_allocations_user" ON "action_allocations" USING btree ("user_id");