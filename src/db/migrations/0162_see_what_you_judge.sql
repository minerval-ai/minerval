ALTER TABLE "inbound_contributions" DROP CONSTRAINT "ck_inbound_contributions_state";--> statement-breakpoint
ALTER TABLE "inbound_contributions" ALTER COLUMN "state" SET DEFAULT 'received';--> statement-breakpoint
ALTER TABLE "inbound_contributions" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD COLUMN "source_ids" uuid[];--> statement-breakpoint
-- A contribution already summarized and given to its node's Steward keeps
-- the time it was given. Every other one that is not a repeat is received
-- and waits to be given as written, and the reading that was open for it
-- on the ledger is no longer work anyone does.
UPDATE "inbound_contributions" SET "delivered_at" = "read_at" WHERE "state" = 'summarized' AND "reassessment" IS NOT NULL;--> statement-breakpoint
UPDATE "inbound_contributions" SET "state" = 'received' WHERE "state" <> 'repeat';--> statement-breakpoint
UPDATE "actions" SET "status" = 'cancelled', "updated_at" = now() WHERE "kind" = 'inbound_review' AND "status" = 'open';--> statement-breakpoint
ALTER TABLE "inbound_contributions" DROP COLUMN "summary";--> statement-breakpoint
ALTER TABLE "inbound_contributions" DROP COLUMN "set_aside_because";--> statement-breakpoint
ALTER TABLE "inbound_contributions" DROP COLUMN "read_by_run";--> statement-breakpoint
ALTER TABLE "inbound_contributions" DROP COLUMN "read_at";--> statement-breakpoint
ALTER TABLE "inbound_contributions" DROP COLUMN "action_id";--> statement-breakpoint
ALTER TABLE "inbound_contributions" ADD CONSTRAINT "ck_inbound_contributions_state" CHECK ("inbound_contributions"."state" IN ('received', 'repeat'));