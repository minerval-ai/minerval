ALTER TABLE "claims" ADD COLUMN "seed_credence" real;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "seed_note" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "seed_source_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_seed_source_claim_id_claims_id_fk" FOREIGN KEY ("seed_source_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;