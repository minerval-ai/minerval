-- #360: the first source to mention a claim does not own its framing.
--
-- claim_instances.original_text -> verbatim_text. "Original" implied the
-- first source's wording had precedence and that the canonical form derived
-- from it; the column holds the passage as ONE source stated it, and every
-- source's excerpt is equally verbatim to itself. A rename, so no data moves.
ALTER TABLE "claim_instances" RENAME COLUMN "original_text" TO "verbatim_text";--> statement-breakpoint
-- claims.canonical_direction_note: why the canonical form is stated in the
-- direction it is (the affirmative form of the question as the discourse
-- poses it), recorded by the Matcher when it mints a claim so a later agent
-- does not silently re-invert the form and flip every recorded stance.
ALTER TABLE "claims" ADD COLUMN "canonical_direction_note" text;
