CREATE TABLE "claim_predictions" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"fixture_id" text,
	"resolution_criterion" text NOT NULL,
	"resolution_date" date NOT NULL,
	"operationalization" text NOT NULL,
	"domain" text,
	"baseline_probability" real,
	"baseline_source" text,
	"baseline_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"outcome" boolean,
	"resolution_note" text,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_predictions" ADD CONSTRAINT "claim_predictions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_claim_predictions_fixture" ON "claim_predictions" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_claim_predictions_due" ON "claim_predictions" USING btree ("resolution_date");