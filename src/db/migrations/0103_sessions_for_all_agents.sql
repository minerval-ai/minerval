ALTER TABLE "agent_sessions" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "context" jsonb;