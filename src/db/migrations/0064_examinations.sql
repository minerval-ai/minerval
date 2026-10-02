CREATE TABLE "audit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_by" text DEFAULT 'audit_agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examination_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"examination_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"facet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examination_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"examination_id" uuid NOT NULL,
	"segment_id" uuid,
	"facet" text NOT NULL,
	"statement" text NOT NULL,
	"evidence" text NOT NULL,
	"created_by" text DEFAULT 'researcher' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"trigger" text NOT NULL,
	"claim_id" uuid,
	"grant_id" uuid,
	"source_id" uuid NOT NULL,
	"brief" text NOT NULL,
	"facets" text[] NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_examinations_scope" CHECK ("examinations"."scope" IN ('claim', 'document')),
	CONSTRAINT "ck_examinations_trigger" CHECK ("examinations"."trigger" IN ('claim', 'mechanical', 'mandate'))
);
--> statement-breakpoint
CREATE TABLE "reading_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"created_by" text DEFAULT 'claim_steward' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "examination_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_notes" ADD CONSTRAINT "audit_notes_finding_id_examination_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."examination_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_coverage" ADD CONSTRAINT "examination_coverage_examination_id_examinations_id_fk" FOREIGN KEY ("examination_id") REFERENCES "public"."examinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_coverage" ADD CONSTRAINT "examination_coverage_segment_id_source_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."source_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_findings" ADD CONSTRAINT "examination_findings_examination_id_examinations_id_fk" FOREIGN KEY ("examination_id") REFERENCES "public"."examinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_findings" ADD CONSTRAINT "examination_findings_segment_id_source_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."source_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_citations" ADD CONSTRAINT "reading_citations_reading_id_claim_instance_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."claim_instance_readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_citations" ADD CONSTRAINT "reading_citations_finding_id_examination_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."examination_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_notes_finding" ON "audit_notes" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_examination_coverage_unique" ON "examination_coverage" USING btree ("examination_id","segment_id","facet");--> statement-breakpoint
CREATE INDEX "idx_examination_findings_examination" ON "examination_findings" USING btree ("examination_id");--> statement-breakpoint
CREATE INDEX "idx_examinations_source" ON "examinations" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_examinations_claim" ON "examinations" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reading_citations_unique" ON "reading_citations" USING btree ("reading_id","finding_id");--> statement-breakpoint
CREATE INDEX "idx_reading_citations_finding" ON "reading_citations" USING btree ("finding_id");--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_examination_id_examinations_id_fk" FOREIGN KEY ("examination_id") REFERENCES "public"."examinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_research_runs_examination" ON "research_runs" USING btree ("examination_id");