ALTER TABLE "research_runs" DROP COLUMN "questions";--> statement-breakpoint
ALTER TABLE "research_runs" DROP COLUMN "answers";
-- These two columns held the questions and answers of a run launched as a
-- "reader" (0153). That way of working was withdrawn before any deployment
-- used it: a Steward reads the evidence it judges. Nothing reads or writes
-- the columns, so they go. The rest of 0153, which keeps a source's stored
-- text from being replaced by other text (MVL08), stays.
