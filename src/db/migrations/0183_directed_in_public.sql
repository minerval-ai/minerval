-- Directing the public graph is public (docs/allocation.md). A granting
-- conversation and the mandate it makes are public from the first message:
-- the transcript, the planning, the Grantmaker's and officers' runs, what the
-- funder says to the mandate and its working notes. New rows default to that.
--
-- The rows already here were made under a promise that a funder's words were
-- private, and they keep it: they are marked false, and their runs stay
-- private as before. The platform's own conversations and mandates were
-- always public (#529), so they are marked true.
ALTER TABLE "grant_conversations" ADD COLUMN "in_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "directed_in_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "grant_conversations" gc SET "in_public" = false
 WHERE NOT EXISTS (
   SELECT 1 FROM "contributors" c WHERE c.id = gc.user_id AND c.external_id = 'platform:minerval'
 );--> statement-breakpoint
UPDATE "grants" SET "directed_in_public" = false WHERE NOT "is_platform";
