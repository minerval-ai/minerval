ALTER TABLE "bounties" DROP CONSTRAINT "bounties_pool_id_prize_pools_id_fk";
--> statement-breakpoint
ALTER TABLE "bounties" DROP COLUMN "pool_id";--> statement-breakpoint
ALTER TABLE "prize_pool_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prize_pools" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "prize_pool_entries" CASCADE;--> statement-breakpoint
DROP TABLE "prize_pools" CASCADE;--> statement-breakpoint
ALTER TABLE "bounties" ALTER COLUMN "posted_by_grant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD COLUMN "own_definitions" boolean DEFAULT false NOT NULL;
