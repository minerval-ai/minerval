ALTER TABLE "agent_runs" ADD COLUMN "skills" text[];--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "skills" text[];--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "domains_source" text;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "skills" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_claims_domains" ON "claims" USING gin ("domains");