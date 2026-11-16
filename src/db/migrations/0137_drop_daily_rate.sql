-- The mandates view read the daily rate; it reads the pace and the reserve now.
DROP VIEW public_read.mandates;
--> statement-breakpoint
ALTER TABLE "grants" DROP COLUMN "daily_budget_micro_usd";
--> statement-breakpoint
CREATE VIEW public_read.mandates AS
SELECT g.id AS mandate_id, g.mandate->>'title' AS title, g.mandate->>'objective' AS objective, g.status,
       g.is_platform, g.pace, g.reserve_micro_usd / 1e6 AS reserve_owls, g.reserve_reason,
       j.budget_micro_usd / 1e6 AS escrow_owls,
       g.mandate->'operating_policy' AS operating_policy, g.created_at
  FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id;
--> statement-breakpoint
GRANT SELECT ON public_read.mandates TO minerval_sql;
--> statement-breakpoint
-- A view in public_read made after enforcement is held by the step, or read-only
-- SQL would read every label through it until the next start (added when this
-- line of migrations met the private-deployment work; a database that had
-- already run this file is covered by the step in 0148).
SELECT minerval_enforcement_sync();
