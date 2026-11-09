ALTER TABLE "argument_instances" ALTER COLUMN "argument_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "dismissed_reason" text;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "argument_instances_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_argument_instances_claim" ON "argument_instances" USING btree ("claim_id");--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "ck_argument_instances_placed" CHECK (("argument_instances"."argument_id" IS NULL) <> ("argument_instances"."claim_id" IS NULL));