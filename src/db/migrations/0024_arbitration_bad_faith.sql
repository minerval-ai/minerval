ALTER TABLE "arbitration_results" ADD COLUMN "suspected_bad_faith" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "arbitration_results" ADD COLUMN "bad_faith_category" text;