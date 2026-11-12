ALTER TABLE "curation_requests" ADD COLUMN "defect" text;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "ck_curation_requests_defect" CHECK (defect IS NULL OR defect IN ('duplicate', 'conflation', 'wrong_kind', 'mislabeled_edge', 'missing_link', 'bad_merge', 'other'));--> statement-breakpoint
-- #955: classify the requests whose producer only ever raised one kind of
-- defect. The Matcher's curator_review and the reconcile-candidate scan
-- both name a near-miss that might be the same node; the one operator
-- sweep (scripts/sweep-fallback-matches.ts) asked about duplicates minted
-- on the Matcher's old fallback. A Steward's, a sweep's or an Audit's
-- request could be any kind, so it stays unclassified and renders as such.
UPDATE "curation_requests" SET "defect" = 'duplicate'
 WHERE "defect" IS NULL AND "source" IN ('matcher', 'reconcile_candidate', 'operator');
