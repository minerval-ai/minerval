ALTER TABLE "curation_requests" DROP CONSTRAINT "ck_curation_requests_source";--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "claims_undecided" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "undecided" jsonb;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "document_problem" text;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "document_problem_note" text;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "ck_curation_requests_source" CHECK (source IN ('steward_escalation', 'reconcile_candidate', 'operator', 'matcher'));