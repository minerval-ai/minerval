-- What a caller reading a mandate or a judgment over MCP could not see.
--
--  * quantity_estimates.run_id: the run that wrote an estimate, as
--    assessments and question_assessments already record theirs, so a
--    quantity's judgment can be opened on the run log like any other. The
--    in-force view is rebuilt to carry it (a view's column list is fixed
--    when it is made).
--  * grant_conversations.turn_activity: what a running Grantmaker turn has
--    done so far ({steps, recent}), so a caller waiting on a reply sees which
--    step it is on rather than nothing for minutes.
--  * public_read.plan_items carries who added each item and when (added_by,
--    added_at, added_run_id), written on every path that adds items to a
--    plan. Items added before this read null. New columns go last, as
--    replacing a view requires.
DROP VIEW "public"."quantity_estimates_in_force";--> statement-breakpoint
ALTER TABLE "grant_conversations" ADD COLUMN "turn_activity" jsonb;--> statement-breakpoint
ALTER TABLE "quantity_estimates" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE VIEW "public"."quantity_estimates_in_force" WITH (security_invoker = true) AS (select "id", "claim_id", "estimate", "summary", "work", "marginal_yield", "model", "funded_by_job_id", "run_id", "inputs_recorded", "is_current", "trigger", "trigger_context", "assessed_at", "sensitivity_label", "origin" from "quantity_estimates" where "quantity_estimates"."is_current" = true);--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.plan_items AS
SELECT g.id AS mandate_id,
       (i.ord - 1)::int AS item_index,
       g.plan_cursor,
       i.item->>'action' AS action,
       NULLIF(i.item->>'claim_id', '')::uuid AS node_id,
       i.item->>'url' AS url,
       i.item->>'partition' AS partition,
       i.item->>'variant' AS variant,
       i.item->>'focus' AS focus,
       i.item->>'rationale' AS rationale,
       i.item->'ledger'->>'status' AS ledger_status,
       i.item->'ledger'->>'reason' AS ledger_reason,
       NULLIF(i.item->'ledger'->>'action_id', '')::uuid AS action_id,
       i.item->'ledger'->>'exclusion_group' AS exclusion_group,
       (i.item->'ledger'->>'checked_at')::timestamptz AS ledger_checked_at,
       i.item->>'kind' AS proposed_kind,
       i.item->>'text' AS proposed_text,
       i.item->>'ref' AS proposal_ref,
       i.item->>'claim_ref' AS node_ref,
       NULLIF(i.item->>'contribution_id', '')::uuid AS contribution_id,
       i.item->>'added_by' AS added_by,
       (i.item->>'added_at')::timestamptz AS added_at,
       NULLIF(i.item->>'added_run_id', '')::uuid AS added_run_id
  FROM grants g,
       jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) WITH ORDINALITY AS i(item, ord);
