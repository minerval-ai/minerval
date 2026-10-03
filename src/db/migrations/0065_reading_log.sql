CREATE TABLE "claim_instance_reading_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"support" text NOT NULL,
	"note" text,
	"source_read" boolean DEFAULT false NOT NULL,
	"worth_reading" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_instance_reading_log" ADD CONSTRAINT "claim_instance_reading_log_instance_id_claim_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."claim_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cirl_instance" ON "claim_instance_reading_log" USING btree ("instance_id");--> statement-breakpoint
INSERT INTO "claim_instance_reading_log" ("instance_id", "support", "note", "source_read", "worth_reading", "created_by", "created_at")
SELECT "instance_id", "support", "note", "source_read", "worth_reading", "created_by", "updated_at" FROM "claim_instance_readings";
