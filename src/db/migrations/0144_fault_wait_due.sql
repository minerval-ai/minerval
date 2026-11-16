-- The public ledger says a row is waiting on a platform fault only while it
-- is: while the platform's next attempt at it is still ahead.
--
-- A row a platform fault stopped keeps the fault on it after its wait ends
-- (actions.fault_reason, with retry_after in the past), so that a second
-- refusal continues the same doubling; it loses it when a row of its kind
-- runs, or when it closes. Between those it is due: the executors may pick
-- it. The view showed waiting_on, waiting_since and next_attempt_at for as
-- long as the fault was on the row, so on 2026-11-13 thirteen rows read as
-- waiting on a provider that had been serving calls for hours, with a next
-- attempt in the past. The three columns are now null once the next attempt
-- has come (services/deployment-fault.ts, waitingOnFaultSql). Same columns,
-- same types; no table is touched.
CREATE OR REPLACE VIEW public_read.ledger AS
SELECT a.id AS action_id, a.kind, a.variant, a.claim_id AS target_node_id, a.target_ref, a.label,
       CASE a.status WHEN 'done' THEN 'finished' WHEN 'superseded' THEN 'finished' ELSE a.status END AS status,
       a.metered_cost_micro_usd / 1e6 AS spent_owls, a.created_at AS opened_at, a.updated_at,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.fault_reason END AS waiting_on,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.fault_since END AS waiting_since,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL AND a.retry_after > now() THEN a.retry_after END AS next_attempt_at
  FROM actions a;
--> statement-breakpoint
-- A view in public_read made after enforcement is held by the step, or read-only
-- SQL would read every label through it until the next start (added when this
-- line of migrations met the private-deployment work; a database that had
-- already run this file is covered by the step in 0148).
SELECT minerval_enforcement_sync();
