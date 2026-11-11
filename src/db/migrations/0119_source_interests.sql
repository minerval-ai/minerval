CREATE TABLE "source_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"claim_id" uuid,
	"party" text NOT NULL,
	"stake" text NOT NULL,
	"recorded_by" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_interests" ADD CONSTRAINT "source_interests_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_interests" ADD CONSTRAINT "source_interests_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_source_interests_source" ON "source_interests" USING btree ("source_id","claim_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_source_interests_claim" ON "source_interests" USING btree ("claim_id") WHERE claim_id IS NOT NULL;