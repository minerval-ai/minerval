ALTER TABLE "grants" ADD COLUMN "pace" jsonb DEFAULT '{"kind":"as_needed"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "reserve_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "reserve_reason" text;--> statement-breakpoint
-- A mandate with a daily rate keeps it as a steady pace over a rolling day.
UPDATE "grants" SET "pace" = jsonb_build_object('kind', 'steady', 'owls', "daily_budget_micro_usd" / 1000000.0, 'period_hours', 24)
 WHERE "daily_budget_micro_usd" > 0;
