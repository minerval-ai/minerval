-- Follow-ups to the kinds (constitution §7, §10, Part VIII): an argument
-- evaluation on a quantity records the estimate it was made under, and a
-- contribution can come from a mandate's research, metered to its budget.
ALTER TABLE "argument_evaluations" ADD COLUMN "estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "funded_by_job_id" uuid;--> statement-breakpoint
ALTER TABLE "argument_evaluations" ADD CONSTRAINT "argument_evaluations_estimate_id_quantity_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."quantity_estimates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;