-- Money a mandate placed on its own upkeep before every run had to be
-- commissioned (#991) is recorded as the commission it was.
--
-- Since #991 the executors pick a row only when a live commission pays for it
-- (action-service.ts, COMMISSIONED_SQL), and the self-funding pass
-- (allocation-service.ts, fundGrantSelfActions) writes commissioned_by
-- 'mandate' with the reason on the mandate's record. The allocations that
-- pass placed before #991 carry no commissioner. Such a row still counts as
-- its action's coverage, so the pass sees the action as paid for and places
-- nothing new, and no executor will pick it: the money is held and the work
-- never runs. A row that closed with such a hold unreleased is stuck the same
-- way the moment its group's next piece of work reopens it.
--
-- One statement, and it touches exactly the rows of action_allocations for
-- which all of these hold:
--   * released_at IS NULL            (still on the books as placed)
--   * commissioned_by IS NULL
--   * grant_id IS NOT NULL           (a mandate's money, never a person's)
--   * action_id IS NOT NULL          (pinned to one ledger row)
--   * that ledger row's kind is one the self-funding pass funds:
--     grant_planning, mandate_review, lookout_run, correspondent_run, ingest,
--     consistency_sweep
--   * the mandate holds no valuation of that ledger row (mandate_valuations)
-- It sets commissioned_by to 'mandate' and, where the row has no reason, the
-- reason the pass writes for that kind. Amounts, spend and release are not
-- touched.
--
-- Why those rows and no others. Before #991 three writers left a mandate's
-- allocation without a commissioner. The self-funding pass is the one this
-- statement finds: it always pinned its placement to the row, and only on
-- those six kinds. The second is a run's overspend (completeAction), written
-- already spent and already released, which the first condition leaves out;
-- it never carries a commissioner and its readers know it by that. The third
-- is the allocator #855 removed, which placed on rows its mandate had valued,
-- pinned or on the group as a whole. Nothing written since would have given
-- those a commissioner, so they are left as they are: the last two
-- conditions leave out its group-level placements and any it pinned to an
-- ingest row it valued.
--
-- Safe to run twice: a row it has set no longer matches.
UPDATE "action_allocations" al
   SET "commissioned_by" = 'mandate',
       "reason" = COALESCE(al."reason", CASE a."kind"
         WHEN 'grant_planning' THEN 'The mandate''s planning pass.'
         WHEN 'mandate_review' THEN 'A sitting of the mandate''s Grantmaker.'
         WHEN 'lookout_run' THEN 'A run of one of the mandate''s lookouts.'
         WHEN 'correspondent_run' THEN 'A run of one of the mandate''s Correspondents.'
         WHEN 'ingest' THEN 'An ingest item of the mandate''s plan.'
         WHEN 'consistency_sweep' THEN 'A consistency sweep the mandate funds.'
       END)
  FROM "actions" a
 WHERE a."id" = al."action_id"
   AND al."released_at" IS NULL
   AND al."commissioned_by" IS NULL
   AND al."grant_id" IS NOT NULL
   AND a."kind" IN ('grant_planning', 'mandate_review', 'lookout_run', 'correspondent_run', 'ingest', 'consistency_sweep')
   AND NOT EXISTS (SELECT 1 FROM "mandate_valuations" mv
                    WHERE mv."grant_id" = al."grant_id" AND mv."action_id" = al."action_id");
