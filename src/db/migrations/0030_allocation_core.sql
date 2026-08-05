DROP INDEX "idx_claims_steward_queue";--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "queue_priority" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
-- Seed the composite priority from importance so the existing queue keeps
-- its order at cutover; the allocation scheduler's sweep refreshes it with
-- the full composite (yield/stakes/staleness/provenance) from there.
UPDATE "claims" SET "queue_priority" = "importance";--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_claim" ON "llm_usage" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_claims_steward_queue" ON "claims" USING btree ("queue_priority" DESC NULLS LAST,"updated_at") WHERE steward_state = 'pending';