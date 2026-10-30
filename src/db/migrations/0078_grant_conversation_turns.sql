ALTER TABLE "grant_conversations" ADD COLUMN "turn_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_conversations" ADD COLUMN "turn_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_conversations" ADD COLUMN "turn_error" text;