ALTER TABLE "agent_runs" ADD COLUMN "log_hash" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_steps_chained" ON "agent_steps" USING btree ("run_id","seq") WHERE hash IS NOT NULL;