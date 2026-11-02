CREATE TABLE "mandate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claim_id" uuid,
	"ref_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "events_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandate_events" ADD CONSTRAINT "mandate_events_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mandate_events_pending" ON "mandate_events" USING btree ("grant_id","created_at") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mandate_events_ref" ON "mandate_events" USING btree ("grant_id","kind","ref_id");