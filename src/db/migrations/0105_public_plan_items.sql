-- A mandate's plan, item by item, for read-only SQL (sql-service.ts): what
-- the mandate's public page already shows of its plan, with the standing the
-- plan materializer last wrote on each item and the ledger row it names, so a
-- query can check a plan against the ledger (the Audit Agent's cross-check,
-- which inspect_ledger used to make).
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
       (i.item->'ledger'->>'checked_at')::timestamptz AS ledger_checked_at
  FROM grants g,
       jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) WITH ORDINALITY AS i(item, ord);
--> statement-breakpoint
GRANT SELECT ON public_read.plan_items TO minerval_sql;
