CREATE TABLE "credits_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"reason" text DEFAULT 'purchase' NOT NULL,
	"stripe_event_id" text,
	"stripe_checkout_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credits_ledger_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
ALTER TABLE "credits_ledger" ADD CONSTRAINT "credits_ledger_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credits_ledger_user" ON "credits_ledger" USING btree ("user_id");