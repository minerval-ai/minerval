/**
 * Telling a mandate that a pass it paid for ended without a conclusion
 * (#1027). The ledger row already carries the outcome and run_settled says
 * it; this puts it in front of the mandate's program officers, who decide
 * under the operating policy whether to commission the node again, with a
 * different budget or brief, or to leave it (§19: paying again is the
 * payer's judgment). Nothing here re-queues or spends.
 *
 * One open item per node and mandate: a node whose passes keep ending
 * without a conclusion shows as one item with a count, which is itself what
 * the officers should see.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { outcomeClause, type PassOutcome } from "../llm/agents/pass-outcome.js";
import { raiseToMandate } from "./mandate-inbox-service.js";

export async function reportUnconcludedPass(actionId: string, nodeId: string, outcome: PassOutcome): Promise<number> {
  if (outcome.kind !== "unconcluded") return 0;
  // The mandates whose money was on the run.
  const grants = await rawQuery<{ grant_id: string; label: string }>(
    `SELECT DISTINCT al.grant_id::text AS grant_id, a.label
       FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
      WHERE al.action_id = $1 AND al.grant_id IS NOT NULL`,
    [actionId]
  );
  const clause = outcomeClause(outcome);
  let raised = 0;
  for (const g of grants) {
    const line = `A pass you paid for (${g.label}) ${clause}`;
    // A repeat on the same node folds into the item still waiting, at this
    // work's own label (as raiseToMandate folds, mandate-inbox-service.ts).
    const [folded] = await rawQuery<{ id: string }>(
      `UPDATE mandate_inbox
          SET summary = left(summary || E'\\n' || $3, 4000),
              detail = detail || jsonb_build_object(
                'passes', COALESCE((detail->>'passes')::int, 1) + 1,
                'action_ids', COALESCE(detail->'action_ids', '[]'::jsonb) || to_jsonb($4::text))
        WHERE id = (SELECT id FROM mandate_inbox
                     WHERE grant_id = $1 AND handled_at IS NULL AND kind = 'outcome'
                       AND target_node_id = $2 AND detail->>'outcome' = 'unconcluded'
                       AND sensitivity_label = $5
                     ORDER BY created_at DESC LIMIT 1)
        RETURNING id`,
      [g.grant_id, nodeId, line, actionId, currentLabel()]
    );
    if (folded) {
      raised++;
      continue;
    }
    const item = await raiseToMandate({
      grantId: g.grant_id,
      kind: "outcome",
      targetNodeId: nodeId,
      source: "the system",
      summary:
        `${line} Whether to commission this node again, with a different budget or brief, ` +
        `or to leave it, is yours to decide; nothing has been re-queued.`,
      // No action_id key: raiseToMandate would fold on it, and the fold here is by node.
      detail: { outcome: "unconcluded", passes: 1, action_ids: [actionId], ended_by: outcome.ended_by, spent_all: outcome.spent_all },
    });
    if (item) raised++;
  }
  return raised;
}

/**
 * The node's last finished pass, as a reader sees it beside stewarded_at
 * (#1027): stewarded_at is the lease heartbeat and moves when a pass starts,
 * so on its own it is read as a conclusion it may not be. The newest of the
 * ledger's passes and the paid orders' that recorded an outcome, at labels
 * the reader reads. Null when none has.
 */
export async function lastPassOutcome(
  nodeId: string
): Promise<{ kind: PassOutcome["kind"]; summary: string; ended_at: string } | null> {
  const [row] = await rawQuery<{ outcome: PassOutcome; ended_at: string }>(
    `SELECT outcome, ended_at FROM (
       SELECT a.outcome, a.updated_at AS ended_at FROM actions a
        WHERE a.claim_id = $1 AND a.status = 'done' AND a.outcome IS NOT NULL
       UNION ALL
       SELECT o.outcome, o.completed_at AS ended_at FROM assessment_orders o
        WHERE o.claim_id = $1 AND o.status = 'done' AND o.outcome IS NOT NULL
     ) p ORDER BY ended_at DESC LIMIT 1`,
    [nodeId]
  );
  if (!row) return null;
  return { kind: row.outcome.kind, summary: outcomeClause(row.outcome), ended_at: new Date(row.ended_at).toISOString() };
}
