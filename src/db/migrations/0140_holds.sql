ALTER TABLE "petitions" DROP CONSTRAINT "petitions_status_check";--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD COLUMN "hold_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "done_so_far" text;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "hold_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "petitions" ADD CONSTRAINT "petitions_status_check" CHECK ("petitions"."status" IN ('pending', 'held', 'escalated', 'granted', 'refused', 'follow_up'));