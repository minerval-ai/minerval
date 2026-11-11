ALTER TABLE "agent_sessions" ADD COLUMN "private_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Sessions paused before their run's private reasons were kept: whatever
-- made that run private is in the transcript they resume, so they resume
-- private, as runs recorded before the visibility rules are.
UPDATE "agent_sessions" SET "private_reasons" = ARRAY['recorded-before-visibility-rules']::text[]
 WHERE "status" <> 'closed';
