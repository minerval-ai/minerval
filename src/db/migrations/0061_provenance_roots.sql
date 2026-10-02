CREATE TABLE "claim_provenance_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"basis" text NOT NULL,
	"created_by" text DEFAULT 'claim_steward' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_cpr_status" CHECK ("claim_provenance_roots"."status" IN ('origin', 'untraced'))
);
--> statement-breakpoint
ALTER TABLE "claim_provenance_roots" ADD CONSTRAINT "claim_provenance_roots_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_roots" ADD CONSTRAINT "claim_provenance_roots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cpr_claim_source" ON "claim_provenance_roots" USING btree ("claim_id","source_id");