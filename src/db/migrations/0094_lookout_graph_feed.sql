ALTER TABLE "lookouts" ADD COLUMN "commission_limit_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "territory_claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "territory_tag_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "changes_cursor" text;