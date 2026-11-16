-- The public ledger names the partition a consistency sweep reads (#1005).
-- A consistency_sweep row's target_ref is the swept tag's id, or 'residual'
-- or 'graph' (consistency-service.ts, partitionRef), and public_read.tags
-- serves a tag by its slug with no id, so read-only SQL could not tell which
-- tag a sweep covered or join it to the nodes under it. One column is added
-- at the end: partition, the tag's slug for a sweep of a tag (null if the
-- reader cannot see that tag), 'residual' or 'graph' for those sweeps, and
-- null on every other kind of row.
CREATE OR REPLACE VIEW public_read.ledger AS
SELECT a.id AS action_id, a.kind, a.variant, a.claim_id AS target_node_id, a.target_ref, a.label,
       CASE a.status WHEN 'done' THEN 'finished' WHEN 'superseded' THEN 'finished' ELSE a.status END AS status,
       a.metered_cost_micro_usd / 1e6 AS spent_owls, a.created_at AS opened_at, a.updated_at,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.fault_reason END AS waiting_on,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.fault_since END AS waiting_since,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.retry_after END AS next_attempt_at,
       CASE WHEN a.kind = 'ingest' AND a.status = 'running' THEN
         CASE WHEN x.status = 'processing' THEN 'extracting'
              WHEN x.status IS NULL OR x.status = 'pending' THEN 'queued' END
       END AS extraction,
       CASE WHEN x.status = 'processing' THEN x.started_at END AS extraction_started_at,
       CASE WHEN x.status = 'pending' THEN
         (SELECT count(*) FROM jobs q
           WHERE q.type = 'url_extraction' AND q.status = 'pending'
             AND q.created_at < x.created_at
             AND q.created_at > now() - interval '4 days')
       END AS queued_ahead,
       CASE WHEN a.kind <> 'consistency_sweep' THEN NULL
            WHEN a.target_ref IN ('residual', 'graph') THEN a.target_ref
            WHEN a.target_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
              (SELECT t.slug FROM tags t WHERE t.id = a.target_ref::uuid)
       END AS partition
  FROM actions a
  LEFT JOIN LATERAL (
    SELECT j.status, j.started_at, j.created_at
      FROM jobs j
     WHERE a.kind = 'ingest' AND a.status = 'running' AND j.action_id = a.id
     ORDER BY j.created_at DESC
     LIMIT 1
  ) x ON true;
--> statement-breakpoint
-- The view was replaced; where a deployment has more than one label it is
-- held again as every view in public_read is.
SELECT public.minerval_enforcement_sync();
