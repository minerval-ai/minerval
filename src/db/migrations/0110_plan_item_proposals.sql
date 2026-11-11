-- A plan's proposals in public_read.plan_items (#656): a `propose` item's
-- kind and wording, the contribution it filed and the label other items name
-- it by, and on an item that waits on one, the label it names. node_id is
-- unchanged: for a propose item it is the node the accepted proposal became
-- or landed on, and for an item that named a proposal, that node once the
-- materializer has written it. New columns go last, as replacing a view
-- requires.
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
       NULLIF(i.item->>'contribution_id', '')::uuid AS contribution_id
  FROM grants g,
       jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) WITH ORDINALITY AS i(item, ord);
