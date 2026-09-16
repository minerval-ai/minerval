CREATE TABLE "claim_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_a_id" uuid NOT NULL,
	"claim_b_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reasoning" text NOT NULL,
	"created_by" text DEFAULT 'curator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_claim_links_ordered" CHECK ("claim_links"."claim_a_id" < "claim_links"."claim_b_id"),
	CONSTRAINT "ck_claim_links_kind" CHECK ("claim_links"."kind" IN ('related', 'rival_explanation', 'counterpart_position'))
);
--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "claim_links_claim_a_id_claims_id_fk" FOREIGN KEY ("claim_a_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "claim_links_claim_b_id_claims_id_fk" FOREIGN KEY ("claim_b_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_claim_links_unique" ON "claim_links" USING btree ("claim_a_id","claim_b_id","kind");--> statement-breakpoint
CREATE INDEX "idx_claim_links_b" ON "claim_links" USING btree ("claim_b_id");