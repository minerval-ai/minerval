CREATE TABLE "agent_finding_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"importance" integer,
	"agent" text NOT NULL,
	"model" text,
	"run_id" uuid,
	"job_id" uuid,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"headline" text NOT NULL,
	"account" text NOT NULL,
	"claim_id" uuid NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"importance" integer NOT NULL,
	"embedding" vector(1536),
	"agent" text NOT NULL,
	"model" text,
	"run_id" uuid,
	"job_id" uuid,
	"skills" text[],
	"status" text DEFAULT 'published' NOT NULL,
	"withdrawn_note" text,
	"sighting_count" integer DEFAULT 1 NOT NULL,
	"first_noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_noted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_findings_importance" CHECK ("agent_findings"."importance" BETWEEN 1 AND 10),
	CONSTRAINT "ck_agent_findings_status" CHECK ("agent_findings"."status" IN ('published', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "agent_finding_sightings" ADD CONSTRAINT "agent_finding_sightings_finding_id_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_finding_sightings_finding" ON "agent_finding_sightings" USING btree ("finding_id","noted_at");--> statement-breakpoint
CREATE INDEX "idx_agent_findings_claim" ON "agent_findings" USING btree ("claim_id","last_noted_at");--> statement-breakpoint
CREATE INDEX "idx_agent_findings_status_noted" ON "agent_findings" USING btree ("status","last_noted_at");--> statement-breakpoint
CREATE INDEX "idx_agent_findings_importance" ON "agent_findings" USING btree ("importance","last_noted_at");