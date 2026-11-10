/**
 * The open ledger as a mandate's agents see it from the graph.
 *
 * A Grantmaker or program officer thinks in territory: these questions, this
 * subtree, this topic. The ledger is rows. openActionsForNodes joins the
 * two, so every graph read they make (search, a node, a decomposition,
 * dependents, a survey) carries, on each node, the work open there and
 * whether someone has already commissioned it (annotateOpenActions). To
 * look across the ledger as a whole, they query it (query_sql).
 *
 * Nothing here values or prices anything.
 */
import { rawQuery } from "../db/client.js";

export interface NodeOpenAction {
  action_id: string;
  kind: string;
  variant: string;
  /** Someone has paid for this work; it runs, or is running. */
  commissioned: boolean;
}

/** The open actions on each of these nodes. */
export async function openActionsForNodes(
  nodeIds: readonly string[]
): Promise<Map<string, NodeOpenAction[]>> {
  const ids = [...new Set(nodeIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const out = new Map<string, NodeOpenAction[]>();
  if (ids.length === 0) return out;
  const rows = await rawQuery<{
    claim_id: string;
    action_id: string;
    kind: string;
    variant: string;
    commissioned: boolean;
  }>(
    `SELECT a.claim_id, a.id AS action_id, a.kind, a.variant,
            EXISTS (SELECT 1 FROM action_allocations al
                     WHERE al.exclusion_group = a.exclusion_group
                       AND al.released_at IS NULL
                       AND al.commissioned_by IS NOT NULL
                       AND al.spent_micro_usd < al.amount_micro_usd
                       AND (al.action_id IS NULL OR al.action_id = a.id)) AS commissioned
       FROM actions a
      WHERE a.status = 'open' AND a.claim_id = ANY($1::uuid[])
      ORDER BY a.kind, a.variant`,
    [ids]
  );
  for (const r of rows) {
    const list = out.get(r.claim_id) ?? [];
    list.push({ action_id: r.action_id, kind: r.kind, variant: r.variant, commissioned: r.commissioned === true });
    out.set(r.claim_id, list);
  }
  return out;
}

type Json = Record<string, unknown>;

/** The node objects in a graph read's result, by tool. */
function nodesIn(tool: string, payload: Json): Json[] {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]).filter((x) => x && typeof x === "object") : []);
  switch (tool) {
    case "search_claims":
      return list(payload.results);
    case "get_claim": {
      const nodes: Json[] = [];
      if (payload.claim && typeof payload.claim === "object") nodes.push(payload.claim as Json);
      // `dependents` is one page of nodes, with `dependents_total` beside it.
      nodes.push(...list(payload.dependents));
      return nodes;
    }
    case "get_decomposition": {
      const nodes: Json[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        nodes.push(n as Json);
        for (const c of list((n as Json).children)) walk(c);
      };
      walk(payload.tree);
      return nodes;
    }
    case "get_dependents":
      return list(payload.dependents);
    default:
      return [];
  }
}

/**
 * Put each node's open actions on a graph read's result, for a mandate's
 * agents: the work open there, and whether it is commissioned. A node with
 * none carries nothing extra. Returns the result unchanged for a
 * tool that reads no nodes, or a result that is not JSON.
 */
export async function annotateOpenActions(tool: string, result: string, _grantId?: string): Promise<string> {
  let payload: Json;
  try {
    payload = JSON.parse(result) as Json;
  } catch {
    return result;
  }
  const nodes = nodesIn(tool, payload);
  const ids = nodes.map((n) => String(n.id ?? "")).filter(Boolean);
  if (ids.length === 0) return result;
  const actions = await openActionsForNodes(ids);
  if (actions.size === 0) return result;
  for (const n of nodes) {
    const open = actions.get(String(n.id ?? ""));
    if (open) n.open_actions = open;
  }
  return JSON.stringify(payload);
}
