ALTER TABLE "source_extractions" ADD COLUMN "claims_undecided" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "undecided" jsonb;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "document_problem" text;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "document_problem_note" text;