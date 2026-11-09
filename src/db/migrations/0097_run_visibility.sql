ALTER TABLE "agent_runs" ADD COLUMN "private_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Runs recorded before the visibility rules carry no record of what their
-- tools read, so they start private. A reclassification over their recorded
-- tool steps can clear this reason later; nothing is made public by default.
UPDATE "agent_runs" SET "private_reasons" = ARRAY['recorded-before-visibility-rules']::text[];
