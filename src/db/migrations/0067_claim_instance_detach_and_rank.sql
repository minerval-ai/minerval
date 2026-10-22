-- A claim is a canonical proposition with no home source, and its Steward
-- decides which instances it carries and in what order.
--
-- detached_at / detached_reason / detached_by: the Steward detaches an
-- instance whose source does not assert, deny or pose the claim. The row is
-- never deleted, because provenance edges, readings and the reading log
-- reference it; reads that show or weigh a claim's instances filter on
-- detached_at IS NULL. Every existing row stays attached.
--
-- display_rank: the Steward's chosen position on the claim page, 1 first.
-- Null (every existing row) follows the default order: the provenance
-- story's order, then the date of the statement.
ALTER TABLE "claim_instances" ADD COLUMN "detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "detached_reason" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "detached_by" text;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "display_rank" integer;
