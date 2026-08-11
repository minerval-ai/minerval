ALTER TABLE "claims" ADD COLUMN "resolution_criterion" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "resolves_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "resolution_outcome" real;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "resolution_source" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "baseline_credence" real;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "baseline_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "merged_opposed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_claims_resolution_due" ON "claims" USING btree ("resolves_at") WHERE resolution_criterion IS NOT NULL AND resolved_at IS NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_resolution_outcome_unit" CHECK (resolution_outcome IS NULL OR (resolution_outcome >= 0 AND resolution_outcome <= 1));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_resolution_wellformed" CHECK ((resolution_outcome IS NULL OR resolved_at IS NOT NULL)
          AND (resolved_at IS NULL OR resolution_criterion IS NOT NULL));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "ck_claims_baseline_paired" CHECK ((baseline_credence IS NULL) = (baseline_as_of IS NULL));