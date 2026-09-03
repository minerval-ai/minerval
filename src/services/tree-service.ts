import { rawQuery } from "../db/client.js";
import type { TreeNode } from "../schemas/claim.js";
import {
  argumentLeanCheckLateralSql,
  checkedKindSql,
  formalExistsSql,
  leanCheckSummaryFromLateral,
  liveBountySql,
  type LeanCheckSummary,
} from "./formalization-service.js";

/**
 * The mathematics fields every node carries (docs/mathematics.md §8.3): the
 * amount of a live bounty, whether a machine-checked proof or disproof of
 * the published statement exists, and whether a published statement exists
 * at all. Optional on the shared TreeNode type so older payloads still parse.
 */
export interface TreeNodeMathFields {
  bounty_micro_usd: number | null;
  checked: "proof" | "disproof" | null;
  formal: boolean;
  /** The accepted check behind a machine-checked argument, on each of its edges. */
  argument_lean_check: LeanCheckSummary | null;
}

export type MathTreeNode = TreeNode & TreeNodeMathFields;

interface MathRowFields {
  bounty_micro_usd?: number | string | null;
  checked?: string | null;
  formal?: boolean | null;
}

interface TreeRootRow extends MathRowFields {
  id: string;
  text: string;
  claim_type: string;
  state: string;
  assessment_status: string | null;
  assessment_confidence: number | null;
  assessment_credence: number | null;
  // Steward-seeded prior credence (#285), served only while the claim has no
  // current assessment (the SQL nulls it out once one exists) so a seed can
  // never sit beside — or masquerade as — a real credence.
  seed_credence: number | null;
}

interface TreeEdgeRow extends MathRowFields {
  parent_id: string;
  id: string;
  text: string;
  claim_type: string;
  state: string;
  relation_type: string;
  reasoning: string | null;
  confidence: number | null;
  argument_id: string | null;
  argument_name: string | null;
  argument_stance: string | null;
  argument_content: string | null;
  argument_verdict: string | null;
  argument_evaluation: string | null;
  assessment_status: string | null;
  assessment_confidence: number | null;
  assessment_credence: number | null;
  seed_credence: number | null;
  lean_check_id?: string | null;
  lean_check_kind?: string | null;
  lean_check_verdict?: string | null;
  lean_check_at?: Date | null;
  lean_check_pin_id?: string | null;
  lean_check_sha256?: string | null;
  lean_check_submitted_by?: string | null;
}

/** The per-node mathematics columns, for any query whose claim alias is `c`. */
const NODE_MATH_SELECT_SQL = `pb.amount_micro_usd AS bounty_micro_usd,
            ${checkedKindSql("c.id")} AS checked,
            ${formalExistsSql("c.id")} AS formal`;
const NODE_MATH_JOIN_SQL = `LEFT JOIN bounties pb ON pb.claim_id = c.id AND ${liveBountySql("pb")}`;

function mathFields(row: MathRowFields): Omit<TreeNodeMathFields, "argument_lean_check"> {
  return {
    bounty_micro_usd:
      row.bounty_micro_usd === null || row.bounty_micro_usd === undefined
        ? null
        : Number(row.bounty_micro_usd),
    checked: row.checked === "proof" || row.checked === "disproof" ? row.checked : null,
    formal: row.formal === true,
  };
}

/**
 * Cap on distinct claims fetched into one tree response. The graph is a DAG
 * that densifies as subclaims are shared, so a tree render of it has no
 * natural size bound; this keeps a hub claim from turning one request into a
 * multi-megabyte payload. Nodes dropped by the cap are flagged on their
 * parent (`children_truncated`), never silently.
 */
const MAX_TREE_NODES = 500;

/**
 * Fetch the claim tree by a level-at-a-time walk with a visited set (at most
 * `maxDepth` queries), then assemble the nested tree.
 *
 * `maxDepth` bounds how many BFS levels (sequential queries) the walk runs; it
 * is NOT the cost guard. The walk exits the moment a level adds no new nodes,
 * so a generous cap only costs on trees that are genuinely that deep. What
 * bounds DB cost — and answers "a tree of thousands of subclaims isn't worth
 * computing" — is `maxNodes` (MAX_TREE_NODES): the walk stops fetching once it
 * has that many distinct claims, flagging the parents whose children it
 * dropped. Depth and breadth are separate levers; tune them separately.
 *
 * The default is deliberately shallow (3). The dominant consumer of a tree is
 * now an agent paying for its own context — a mandate's Grantmaker reading a
 * decomposition alongside its workspace and web-search results — and for that
 * reader depth is a TOKEN cost the node cap doesn't bound. Three levels is
 * where a disputed subclaim under a well-supported parent shows up; anything
 * deeper is a deliberate drill-down, asked for explicitly. Callers that render
 * rather than reason (the territory overview's subtree counts) pass their own.
 *
 * The graph is a DAG, not a tree: shared subclaims are the point of the
 * design. The previous recursive CTE re-expanded a diamond once per *path*,
 * so a shared node's whole subtree repeated for every route that reached it —
 * on dense subgraphs a single response carried the same subtree dozens of
 * times. The visited set fetches every node and edge exactly once, and
 * `assembleTree` renders a shared node's children only at its first
 * occurrence (later occurrences are stubs marked `subtree_collapsed`). The
 * visited set also makes a relationship cycle terminate for free.
 */
export async function getClaimTree(
  claimId: string,
  maxDepth: number = 3,
  maxNodes: number = MAX_TREE_NODES
): Promise<TreeNode | null> {
  const [root] = await rawQuery<TreeRootRow>(
    `SELECT c.id, c.text, c.claim_type, c.state,
            a.status AS assessment_status, a.confidence AS assessment_confidence,
            a.claim_credence AS assessment_credence,
            CASE WHEN a.id IS NULL THEN c.seed_credence END AS seed_credence,
            ${NODE_MATH_SELECT_SQL}
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
       ${NODE_MATH_JOIN_SQL}
      WHERE c.id = $1`,
    [claimId]
  );
  if (!root) return null;

  // parent id -> its outgoing edges, each carrying the child's node fields.
  // The (parent, child, relation) unique index plus visiting each parent
  // exactly once means no edge is fetched twice.
  const childEdges = new Map<string, TreeEdgeRow[]>();
  const visited = new Set<string>([root.id]);
  // Parents that have children the node cap dropped from this response.
  const truncatedParents = new Set<string>();
  let frontier = [root.id];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const rows = await rawQuery<TreeEdgeRow>(
      `SELECT cr.parent_claim_id AS parent_id,
              c.id, c.text, c.claim_type, c.state,
              cr.relation_type, cr.reasoning, cr.confidence, cr.argument_id,
              arg.name AS argument_name, arg.stance AS argument_stance,
              arg.content AS argument_content,
              ae.verdict AS argument_verdict, ae.content AS argument_evaluation,
              a.status AS assessment_status, a.confidence AS assessment_confidence,
              a.claim_credence AS assessment_credence,
              CASE WHEN a.id IS NULL THEN c.seed_credence END AS seed_credence,
              ${NODE_MATH_SELECT_SQL},
              alc.lean_check_id, alc.lean_check_kind, alc.lean_check_verdict,
              alc.lean_check_at, alc.lean_check_pin_id, alc.lean_check_sha256,
              alc.lean_check_submitted_by
         FROM claim_relationships cr
         JOIN claims c ON c.id = cr.child_claim_id
         LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
         LEFT JOIN arguments arg ON arg.id = cr.argument_id
         LEFT JOIN argument_evaluations ae
                ON ae.argument_id = cr.argument_id AND ae.is_current = true
         LEFT JOIN LATERAL ${argumentLeanCheckLateralSql("arg")} alc ON true
         ${NODE_MATH_JOIN_SQL}
        WHERE cr.parent_claim_id = ANY($1)
          AND c.state = 'active'
        ORDER BY cr.created_at, cr.id`,
      [frontier]
    );

    const next: string[] = [];
    for (const row of rows) {
      if (!visited.has(row.id)) {
        if (visited.size >= maxNodes) {
          truncatedParents.add(row.parent_id);
          continue;
        }
        visited.add(row.id);
        next.push(row.id);
      }
      // Edges into an already-visited node (a diamond, or a cycle back to an
      // ancestor) are kept — the node shows up under this parent too — but do
      // not re-enter the frontier, so nothing is expanded twice.
      const edges = childEdges.get(row.parent_id);
      if (edges) edges.push(row);
      else childEdges.set(row.parent_id, [row]);
    }
    frontier = next;
  }

  return assembleTree(root, childEdges, truncatedParents);
}

export interface DependentClaim {
  id: string;
  text: string;
  claim_type: string;
  relation_type: string;
  // Why the dependent leans on this claim, per the edge (issue #199).
  reasoning: string;
  importance: number;
  assessment_status: string | null;
  assessment_confidence: number | null;
  assessment_credence: number | null;
  // Mathematics (docs/mathematics.md §8.3), see TreeNodeMathFields.
  bounty_micro_usd: number | null;
  checked: "proof" | "disproof" | null;
  formal: boolean;
}

function dependentRow<T extends MathRowFields>(row: T): T & Omit<TreeNodeMathFields, "argument_lean_check"> {
  return { ...row, ...mathFields(row) };
}

/**
 * Get the claims that depend on (have as a subclaim) the given claim — the
 * reverse of the decomposition tree. Each row is a parent claim plus the
 * relationship edge by which it leans on this claim, and the parent's current
 * assessment. Mirrors the agents' `get_claim_dependents` graph query.
 *
 * Ordered by importance so consumers that truncate (the claim map shows a few
 * chips plus a count) surface the most load-bearing dependents first.
 */
export async function getClaimDependents(claimId: string): Promise<DependentClaim[]> {
  const rows = await rawQuery<DependentClaim>(
    `SELECT cr.parent_claim_id AS id, c.text, c.claim_type,
            cr.relation_type, cr.reasoning, c.importance,
            a.status AS assessment_status, a.confidence AS assessment_confidence,
            a.claim_credence AS assessment_credence,
            ${NODE_MATH_SELECT_SQL}
     FROM claim_relationships cr
     JOIN claims c ON c.id = cr.parent_claim_id
     LEFT JOIN assessments a ON a.claim_id = cr.parent_claim_id AND a.is_current = true
     ${NODE_MATH_JOIN_SQL}
     WHERE cr.child_claim_id = $1 AND c.state = 'active'
     ORDER BY c.importance DESC, a.confidence DESC NULLS LAST, c.text`,
    [claimId]
  );
  return rows.map(dependentRow);
}

/** One claim reached by walking upward, with how many edges away it sits. */
export interface TransitiveDependent extends DependentClaim {
  /** 1 = directly depends on the subject claim, 2 = depends on one of those. */
  depth: number;
}

/**
 * Walk UPWARD transitively: everything that rests on this claim, directly or
 * through a chain. The mirror of `getClaimTree`, and the answer to a question
 * nothing else here could answer — "what moves if this verdict changes?"
 *
 * Load-bearingness is the signal an allocator actually wants and it is not a
 * property of the claim itself: a modest-importance lemma carrying six
 * high-importance dependents is worth more attention than an isolated claim
 * scoring higher on `importance`. One level up (`getClaimDependents`) cannot
 * see that, because the weight often sits two edges away.
 *
 * Returned FLAT, ranked by importance, each row tagged with its depth, rather
 * than as a nested ancestor tree. The consumer is usually an agent paying for
 * its own context, and for "is this load-bearing" a ranked list plus a count
 * carries the whole signal at a fraction of the tokens a nested structure
 * would. Same guards as the downward walk: a visited set (so a diamond or a
 * cycle terminates), `maxDepth` levels, and `maxNodes` as the cost bound with
 * `truncated` set rather than silently dropping rows.
 */
export async function getTransitiveDependents(
  claimId: string,
  maxDepth: number = 3,
  maxNodes: number = MAX_TREE_NODES
): Promise<{ dependents: TransitiveDependent[]; total: number; truncated: boolean }> {
  const visited = new Set<string>([claimId]);
  const found: TransitiveDependent[] = [];
  let frontier = [claimId];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const rows = await rawQuery<DependentClaim>(
      `SELECT DISTINCT ON (cr.parent_claim_id)
              cr.parent_claim_id AS id, c.text, c.claim_type,
              cr.relation_type, cr.reasoning, c.importance,
              a.status AS assessment_status, a.confidence AS assessment_confidence,
              a.claim_credence AS assessment_credence,
              ${NODE_MATH_SELECT_SQL}
         FROM claim_relationships cr
         JOIN claims c ON c.id = cr.parent_claim_id
         LEFT JOIN assessments a
                ON a.claim_id = cr.parent_claim_id AND a.is_current = true
         ${NODE_MATH_JOIN_SQL}
        WHERE cr.child_claim_id = ANY($1) AND c.state = 'active'
        ORDER BY cr.parent_claim_id, c.importance DESC`,
      [frontier]
    );

    const next: string[] = [];
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      if (visited.size >= maxNodes) {
        truncated = true;
        continue;
      }
      visited.add(row.id);
      found.push({ ...dependentRow(row), depth });
      next.push(row.id);
    }
    frontier = next;
  }

  found.sort(
    (x, y) =>
      y.importance - x.importance ||
      (y.assessment_confidence ?? 0) - (x.assessment_confidence ?? 0) ||
      x.depth - y.depth
  );
  return { dependents: found, total: found.length, truncated };
}

/**
 * Paginated variant for GET /claims/:id/dependents (issue #102): the claim map
 * recentres often and only shows a handful of dependent chips plus a count, so
 * a hub claim with hundreds of dependents must not ship them all — nor drag
 * the whole deep payload (tree, arguments, instances) along for the ride.
 * `total` comes from a window function so page + count stay one query; the
 * offset-past-the-end case falls back to a bare count.
 */
export async function listClaimDependents(
  claimId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ dependents: DependentClaim[]; total: number }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = await rawQuery<DependentClaim & { total: string }>(
    `SELECT cr.parent_claim_id AS id, c.text, c.claim_type,
            cr.relation_type, cr.reasoning, c.importance,
            a.status AS assessment_status, a.confidence AS assessment_confidence,
            a.claim_credence AS assessment_credence,
            ${NODE_MATH_SELECT_SQL},
            COUNT(*) OVER ()::text AS total
     FROM claim_relationships cr
     JOIN claims c ON c.id = cr.parent_claim_id
     LEFT JOIN assessments a ON a.claim_id = cr.parent_claim_id AND a.is_current = true
     ${NODE_MATH_JOIN_SQL}
     WHERE cr.child_claim_id = $1 AND c.state = 'active'
     ORDER BY c.importance DESC, a.confidence DESC NULLS LAST, c.text
     LIMIT $2 OFFSET $3`,
    [claimId, limit, offset]
  );
  if (rows.length === 0) {
    const [count] = await rawQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM claim_relationships cr
         JOIN claims c ON c.id = cr.parent_claim_id
        WHERE cr.child_claim_id = $1 AND c.state = 'active'`,
      [claimId]
    );
    return { dependents: [], total: parseInt(count?.count ?? "0", 10) };
  }
  return {
    dependents: rows.map(({ total: _total, ...dep }) => dependentRow(dep)),
    total: parseInt(rows[0]!.total, 10),
  };
}

/**
 * Get direct subclaim count for a claim.
 */
export async function getSubclaimCount(claimId: string): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM claim_relationships cr
       JOIN claims c ON c.id = cr.child_claim_id
      WHERE cr.parent_claim_id = $1 AND c.state = 'active'`,
    [claimId]
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}

/**
 * Assemble the fetched edges into a nested tree, depth-first from the root.
 *
 * A shared subclaim appears under every parent that links it (each occurrence
 * carrying that edge's relation/reasoning/argument), but its own children are
 * rendered only at its first occurrence — later occurrences are stubs with
 * `subtree_collapsed` set, which is what keeps a diamond from duplicating an
 * entire subtree in the serialized payload.
 */
function assembleTree(
  root: TreeRootRow,
  childEdges: Map<string, TreeEdgeRow[]>,
  truncatedParents: Set<string>
): TreeNode {
  const expanded = new Set<string>();

  const render = (
    node: TreeRootRow | TreeEdgeRow,
    edge: TreeEdgeRow | null,
    depth: number
  ): TreeNode => {
    const first = !expanded.has(node.id);
    if (first) expanded.add(node.id);
    const edges = childEdges.get(node.id) ?? [];

    const treeNode: MathTreeNode = {
      id: node.id,
      text: node.text,
      claim_type: node.claim_type,
      state: node.state,
      depth,
      relation_type: edge?.relation_type ?? null,
      reasoning: edge?.reasoning ?? null,
      confidence: edge?.confidence ?? null,
      assessment_status: node.assessment_status,
      assessment_confidence: node.assessment_confidence,
      assessment_credence: node.assessment_credence,
      seed_credence: node.seed_credence,
      argument_id: edge?.argument_id ?? null,
      argument_name: edge?.argument_name ?? null,
      argument_stance: edge?.argument_stance ?? null,
      argument_content: edge?.argument_content ?? null,
      argument_verdict: edge?.argument_verdict ?? null,
      argument_evaluation: edge?.argument_evaluation ?? null,
      ...mathFields(node),
      argument_lean_check: edge ? leanCheckSummaryFromLateral(edge) : null,
      children: first ? edges.map((e) => render(e, e, depth + 1)) : [],
    };
    if (!first && edges.length > 0) treeNode.subtree_collapsed = true;
    if (truncatedParents.has(node.id)) treeNode.children_truncated = true;
    return treeNode;
  };

  return render(root, null, 0);
}
