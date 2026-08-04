ALTER TABLE "claim_instances" ADD COLUMN "speaker" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "publication" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "source_date" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "created_by" text DEFAULT 'extractor' NOT NULL;