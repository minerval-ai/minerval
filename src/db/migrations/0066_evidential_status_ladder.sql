-- #524: claim status becomes an evidential ladder. `contested` and
-- `unsupported` are retired; `inconclusive` and `doubtful` are new.
-- assessments.status is a plain text column (no PG enum, no CHECK), so the
-- change is a value update over existing rows, as in 0021.
--
-- The mapping is provisional. `contested` described the debate, not the
-- evidence, and `unsupported` covered two cases the new ladder separates
-- (doubtful where evidence would exist if the claim were true, unknown where
-- it would not be expected), so no mechanical mapping is final:
--   contested   -> inconclusive
--   unsupported -> unknown
-- Every row is relabeled, current and historical, so the history endpoints
-- keep validating against the new enum. Each relabeled row's reasoning trace
-- records the label it was written under, so the record stays honest about
-- what the Steward actually said at the time.
--
-- Step 1: queue every active claim whose CURRENT assessment is relabeled for
-- a fresh Steward pass, through the same columns enqueueSteward writes
-- (queue-service.ts): the claim row is the queue, and the allocation
-- scheduler's reconcile opens the assess/reassess ledger group for every
-- pending claim, so the pass is valued and funded like any other. A claim
-- mid-run keeps 'running' and gets steward_requeued (#482); a claim already
-- queued keeps its trigger (structure_and_assess outranks a re-trigger) and
-- has the note appended to its context. This step reads the old labels, so
-- it runs before the relabel.
UPDATE "claims" c
   SET "steward_state" = CASE WHEN c."steward_state" = 'running' THEN 'running' ELSE 'pending' END,
       "steward_requeued" = (c."steward_state" = 'running'),
       "steward_trigger" = CASE
         WHEN (c."steward_state" = 'pending' OR (c."steward_state" = 'running' AND c."steward_requeued"))
              AND c."steward_trigger" IS NOT NULL
           THEN c."steward_trigger"
         ELSE 'staleness_check'
       END,
       "steward_context" = CASE
         WHEN (c."steward_state" = 'pending' OR (c."steward_state" = 'running' AND c."steward_requeued"))
              AND COALESCE(c."steward_context", '') <> ''
           THEN c."steward_context" || E'\n\n' || m.note
         ELSE m.note
       END,
       "updated_at" = now()
  FROM (
    SELECT a."claim_id",
           '[staleness_check] Status vocabulary change (#524): this claim''s current assessment was recorded as '
             || a."status" || ', a status that no longer exists. It was relabeled '
             || CASE a."status" WHEN 'contested' THEN 'inconclusive' ELSE 'unknown' END
             || ' provisionally. Re-assess it on the evidence and choose the status the evidence supports: '
             || 'verified, supported, inconclusive, doubtful, contradicted, or unknown. How actively the claim '
             || 'is disputed is recorded as contestation, not as a status.' AS note
      FROM "assessments" a
     WHERE a."is_current" = true
       AND a."status" IN ('contested', 'unsupported')
  ) m
 WHERE c."id" = m."claim_id"
   AND c."state" = 'active';
--> statement-breakpoint
-- Step 2: relabel, noting the original label in the reasoning trace.
UPDATE "assessments"
   SET "reasoning_trace" = "reasoning_trace" || E'\n\n[Status relabeled from ' || "status" || ' to '
         || CASE "status" WHEN 'contested' THEN 'inconclusive' ELSE 'unknown' END
         || ' by migration 0066 (#524), when the ' || "status" || ' status was retired.]',
       "status" = CASE "status" WHEN 'contested' THEN 'inconclusive' ELSE 'unknown' END
 WHERE "status" IN ('contested', 'unsupported');
