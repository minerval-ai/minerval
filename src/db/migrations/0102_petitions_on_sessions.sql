ALTER TABLE "agent_sessions" ADD COLUMN "extra_funding" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "reply_to_session" uuid;