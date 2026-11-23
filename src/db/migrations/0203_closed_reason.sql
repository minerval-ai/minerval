-- Why a cancelled ledger row was cancelled (#1045). An ingest whose fetch the
-- site refused, or whose document the Extractor could not read, was cancelled
-- with nothing on the row to say so, and a mandate's plan item read
-- "cancelled" with no reason; its Grantmaker could not tell a dead URL from a
-- platform failure, nor substitute another. The reason is written with the
-- cancel (action-service.ts, cancelActionGroup), in words its payer can read:
-- never a provider's or the database's own text, since it is public here.
ALTER TABLE "actions" ADD COLUMN "closed_reason" text;--> statement-breakpoint
-- A reason belongs to the cancel it was written with. A row that leaves
-- cancelled (a group's next piece of work reopening it) drops it, whichever
-- statement moves it, so a later cancel with no reason never reads the old
-- one. As actions_clear_fault does for a fault's wait.
CREATE OR REPLACE FUNCTION actions_clear_closed_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'cancelled' THEN
    NEW.closed_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "actions_clear_closed_reason" BEFORE UPDATE OF "status" ON "actions" FOR EACH ROW EXECUTE FUNCTION actions_clear_closed_reason();--> statement-breakpoint
-- The public ledger says why a cancelled row was cancelled. One column is
-- added at the end, as replacing a view requires; the rest is 0171's.
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
       END AS partition,
       CASE WHEN a.status = 'cancelled' THEN a.closed_reason END AS closed_reason
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
