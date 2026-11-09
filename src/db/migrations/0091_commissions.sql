ALTER TABLE "action_allocations" ADD COLUMN "commissioned_by" text;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "parent_action_id" uuid;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_parent_action_id_actions_id_fk" FOREIGN KEY ("parent_action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_action_allocations_parent" ON "action_allocations" USING btree ("parent_action_id");