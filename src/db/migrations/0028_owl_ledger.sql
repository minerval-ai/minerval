-- The owl economy (Stage 1): one spendable ledger.
--
-- credits_ledger becomes owl_ledger IN PLACE so purchased-credit balances
-- survive: those rows were face-value micro-USD grants and mean the same
-- thing under the owl unit. Their Stripe checkout-session ids move into the
-- generalized idempotency_key ("stripe:<session_id>"), which also serves the
-- signup/monthly grant keys.
--
-- kudos_events and contributors.kudos are dropped outright, not migrated:
-- kudos was never held by anyone, and the recognition concept is absorbed
-- into owls (contribution_award rows + contributors.owls_earned_micro_usd).
ALTER TABLE "credits_ledger" RENAME TO "owl_ledger";--> statement-breakpoint
ALTER TABLE "owl_ledger" RENAME CONSTRAINT "credits_ledger_user_id_contributors_id_fk" TO "owl_ledger_user_id_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD COLUMN "op" text;--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD COLUMN "contribution_id" uuid;--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "owl_ledger" SET "idempotency_key" = 'stripe:' || "stripe_checkout_session_id" WHERE "stripe_checkout_session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "owl_ledger" DROP CONSTRAINT IF EXISTS "credits_ledger_stripe_checkout_session_id_unique";--> statement-breakpoint
ALTER TABLE "owl_ledger" DROP COLUMN IF EXISTS "stripe_checkout_session_id";--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD CONSTRAINT "owl_ledger_idempotency_key_unique" UNIQUE("idempotency_key");--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD CONSTRAINT "owl_ledger_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owl_ledger" ADD CONSTRAINT "owl_ledger_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_credits_ledger_user";--> statement-breakpoint
CREATE INDEX "idx_owl_ledger_user_time" ON "owl_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_owl_ledger_contribution" ON "owl_ledger" USING btree ("contribution_id");--> statement-breakpoint
DROP TABLE "kudos_events" CASCADE;--> statement-breakpoint
ALTER TABLE "contributors" DROP COLUMN "kudos";--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "owls_earned_micro_usd" bigint DEFAULT 0 NOT NULL;
