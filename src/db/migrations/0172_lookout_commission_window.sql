ALTER TABLE "action_allocations" ADD COLUMN "lookout_id" uuid;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "commission_window_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "commission_window_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_lookout_id_lookouts_id_fk" FOREIGN KEY ("lookout_id") REFERENCES "public"."lookouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_action_allocations_lookout" ON "action_allocations" USING btree ("lookout_id","created_at") WHERE lookout_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD CONSTRAINT "ck_lookouts_commission_window" CHECK ("lookouts"."commission_window_micro_usd" >= 0 AND "lookouts"."commission_window_hours" >= 1);--> statement-breakpoint
-- A lookout's window is read across labels, as a mandate's pace is: the
-- whole-money view carries who placed the allocation down to the lookout.
-- A column added at the end keeps the view's grants (0148).
CREATE OR REPLACE VIEW minerval_whole.allocation_money AS
SELECT al.id, al.exclusion_group, al.action_id, al.claim_id, al.grant_id, al.user_id,
       al.amount_micro_usd, al.spent_micro_usd, al.released_at, al.created_at,
       al.commissioned_by, al.parent_action_id, al.lookout_id
  FROM public.action_allocations al;
