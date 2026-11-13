-- The extraction lane (docs/infrastructure.md, "The extraction lane").
--
-- A job now carries the ledger row it executes (action_id), when a worker
-- took it up (started_at, null while it waits in its queue), how many times
-- one has (attempts, the run's hold on the job), and when its run last made
-- progress (heartbeat_at, read by the recovery sweep to find an extraction
-- that stopped).
ALTER TABLE "jobs" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_jobs_action" ON "jobs" USING btree ("action_id");--> statement-breakpoint
-- The unfinished extractions of the ingest rows running now, linked to their
-- rows the way the ledger's reconcile has matched them (action-service.ts):
-- the job for the row's URL submitted for this run of the row. A job already
-- being read counts as taken up at its creation, which is the most this
-- database knows; it moves on at the run's next step.
UPDATE jobs j
   SET action_id = a.id,
       started_at = CASE WHEN j.status = 'processing' THEN j.created_at END,
       heartbeat_at = CASE WHEN j.status = 'processing' THEN now() END,
       attempts = CASE WHEN j.status = 'processing' THEN 1 ELSE 0 END
  FROM actions a
 WHERE a.kind = 'ingest' AND a.status = 'running'
   AND j.type = 'url_extraction' AND j.status IN ('pending', 'processing')
   AND j.action_id IS NULL
   AND j.input->>'url' = a.target_ref
   AND j.created_at >= a.updated_at - interval '1 minute';--> statement-breakpoint
-- The public ledger says of a running ingest whether its extraction is
-- waiting its turn or being read. A row went 'running' when the engine
-- executor submitted its source, not when a worker took it up, so on
-- 2026-11-13 callers told their users a source was being read when it was
-- some twenty-third in line. Three columns are added at the end: extraction
-- (queued or extracting, null for any other row), extraction_started_at
-- (when a worker took the current extraction up) and queued_ahead (for a
-- queued one, how many extractions submitted before it are still waiting:
-- approximate, as the queue does not promise its order).
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
       END AS queued_ahead
  FROM actions a
  LEFT JOIN LATERAL (
    SELECT j.status, j.started_at, j.created_at
      FROM jobs j
     WHERE a.kind = 'ingest' AND a.status = 'running' AND j.action_id = a.id
     ORDER BY j.created_at DESC
     LIMIT 1
  ) x ON true;
