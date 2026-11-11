ALTER TABLE "lookouts" DROP CONSTRAINT "ck_lookouts_max_value";--> statement-breakpoint
ALTER TABLE "lookout_feeds" DROP COLUMN "daily_ingest_cap";--> statement-breakpoint
ALTER TABLE "lookouts" DROP COLUMN "max_value";--> statement-breakpoint
ALTER TABLE "lookouts" DROP COLUMN "max_ingests_per_run";