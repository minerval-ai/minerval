-- Argument evaluation scale (#540): an evaluation rates how far the
-- conclusion follows if the premises hold (certain | likely | slight | none)
-- and may mark the argument decisive. No value of the old scale maps cleanly
-- onto the new one ("holds" does not say deductive or inductive; "contested"
-- was a fact about a premise), so old evaluations are retired as history
-- rather than relabelled, and the argument_evaluation_backfill re-drives the
-- Stewards to judge them afresh (scripts/backfill-argument-evaluations.ts).
ALTER TABLE "argument_evaluations" ADD COLUMN "decisive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "argument_evaluations" SET "is_current" = false
 WHERE "is_current" = true
   AND "verdict" IN ('holds', 'holds_with_caveats', 'fails', 'contested');
