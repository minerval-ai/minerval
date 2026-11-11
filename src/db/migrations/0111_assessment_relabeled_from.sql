-- Statuses relabeled by migration 0066 and never re-judged, made visible
-- (#848). 0066 (#524) relabeled contested -> inconclusive and unsupported ->
-- unknown, marking each row only by appending a note to reasoning_trace,
-- which public_read shows only the first 500 characters of. Such a status is
-- provisional, not a finding, and its summary may still argue for the retired
-- label. relabeled_from names that label so the API, the claim page and
-- read-only SQL can say so, and a mandate can enumerate and price the backlog.
--
-- 0066 already queued every affected active claim for a fresh Steward pass,
-- so nothing is queued here. A Steward never writes the column, so a node
-- clears it when re-judged (its new current row carries NULL). Only claims'
-- assessments: question_assessments and quantity_estimates were created by
-- 0073, after 0066, and never held a retired label.
ALTER TABLE "assessments" ADD COLUMN "relabeled_from" text;--> statement-breakpoint
-- Backfill from 0066's note, current and historical rows alike (0066
-- relabeled both). The note was appended at the very end of the trace and
-- traces are never edited afterwards, so the match is anchored there: a later
-- trace that quotes the note does not match. The status must also be the one
-- 0066 mapped the label to.
UPDATE "assessments" a
   SET "relabeled_from" = m.label
  FROM (
    SELECT "id",
           substring("reasoning_trace" from
             '\[Status relabeled from (contested|unsupported) to (?:inconclusive|unknown) by migration 0066 \(#524\), when the (?:contested|unsupported) status was retired\.\]$'
           ) AS label
      FROM "assessments"
     WHERE "reasoning_trace" LIKE '%by migration 0066 (#524)%'
  ) m
 WHERE a."id" = m."id"
   AND m.label IS NOT NULL
   AND a."status" = CASE m.label WHEN 'contested' THEN 'inconclusive' ELSE 'unknown' END;--> statement-breakpoint
-- Read-only SQL (sql-service.ts): new columns go last, as replacing a view
-- requires. The reviewed column list is in tests/db/sql-views.test.ts.
CREATE OR REPLACE VIEW public_read.assessments AS
SELECT a.id, a.claim_id AS node_id, a.status, a.confidence, a.claim_credence AS credence, a.marginal_yield,
       a.is_current, a.assessed_at, a.trigger, a.summary, left(a.reasoning_trace, 500) AS reasoning_head,
       a.relabeled_from
  FROM assessments a;
