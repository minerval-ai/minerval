ALTER TABLE "arguments" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "arguments" ADD COLUMN "retired_reason" text;