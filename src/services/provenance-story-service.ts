/**
 * The origins-first reading of a claim's provenance (#507): the shape the
 * map on the claim page draws, top to bottom, as the claim's story.
 *
 * Every node is a source; the claim itself is not one, it is the page the
 * map sits on. A source is in the story when it states the claim (it has an
 * instance) or when a source that states it draws on it (an edge target);
 * the second kind is an underlying source, a document the claim rests on
 * without stating it, and it can be where the story begins.
 *
 * Each node gets a standing:
 *  - `derived`: something upstream is recorded for it, an edge from one of
 *    its assertions or its being a republished copy of another source in
 *    the story.
 *  - `origin`: nothing upstream, and either the Steward recorded it as the
 *    beginning or its kind is a primary one (PRIMARY_SOURCE_TYPES).
 *  - `untraced`: nothing upstream and nothing that says it is a beginning.
 *    Shown apart from origins, never in their row, so a source nobody has
 *    followed upstream does not pass for one that has none.
 * A Steward's root row overrides the derivation either way, except that
 * "untraced" cannot hide an upstream edge that has since been recorded.
 *
 * Everything else here is structure, never weight: depth below the top row,
 * how many sources draw on a node (directly and in all), how many copies it
 * has, and whether its own assertion diverged from what it drew on. Ordering
 * puts divergence first, then downstream count, with copies (reach) only as
 * a tie-break. How much any of it matters is the Steward's to say, in the
 * map's summary.
 */
import { rawQuery } from "../db/client.js";
import { PRIMARY_SOURCE_TYPES } from "../schemas/common.js";

export type StoryStanding = "origin" | "untraced" | "derived";

/** What the standing rests on, so a reader can tell a judgment from a derivation. */
export type StoryBasis = "steward" | "primary_source_kind" | "upstream" | "none";

/** Fidelities that mean the assertion did not carry over as the upstream document had it. */
const DIVERGENT_FIDELITIES = new Set(["strengthened", "weakened", "distorted", "misattributed"]);

export interface StorySource {
  id: string;
  title: string;
  url: string | null;
  source_type: string;
}

export interface StoryEdgeInput {
  from_instance_id: string;
  from_source_id: string;
  to_source_id: string;
  relation_type: string;
  fidelity: string;
}

export interface StoryRootInput {
  source_id: string;
  status: "origin" | "untraced";
  basis: string;
  created_by: string;
  updated_at: string;
}

export interface StoryInput {
  sources: StorySource[];
  /** Instances of the claim: which sources state it. */
  instances: Array<{ id: string; source_id: string }>;
  edges: StoryEdgeInput[];
  /** republishes pairs among, or out of, the story's sources: parent is the original. */
  republishes: Array<{ parent_source_id: string; child_source_id: string }>;
  roots: StoryRootInput[];
}

export interface StoryNode {
  source: StorySource;
  instance_ids: string[];
  /** Drawn on by the claim's sources without stating the claim itself. */
  underlying: boolean;
  standing: StoryStanding;
  basis: StoryBasis;
  /** The Steward's recorded judgment, when there is one. */
  root: { status: "origin" | "untraced"; basis: string; created_by: string; updated_at: string } | null;
  /** Layers below the top row; null when no top node reaches it (a loop of responses with no way in). */
  depth: number | null;
  /** What this source's assertions draw on, one entry per (source, relation, fidelity). */
  upstream: Array<{ source_id: string; relation_type: string; fidelity: string }>;
  /** Sources in the story this one is a republished copy of. */
  copy_of: string[];
  /** Sources in the story that draw on this one directly, or copy it. */
  downstream: number;
  /** Sources in the story that rest on this one, directly or through others. */
  downstream_total: number;
  /** Republished copies of this source anywhere in the graph: the derived reach signal. */
  copies: number;
  /** One of this source's own assertions departs from what it draws on. */
  diverges: boolean;
}

export interface ProvenanceStory {
  claim_id: string;
  /** Ordered for drawing: by depth, origins before untraced at the top, then divergence, then downstream count. */
  nodes: StoryNode[];
  counts: { sources: number; origins: number; untraced: number; derived: number; underlying: number };
}

const STANDING_RANK: Record<StoryStanding, number> = { origin: 0, untraced: 1, derived: 2 };

/** Build the story from rows already loaded. Pure, so the rules are testable without a database. */
export function buildProvenanceStory(claimId: string, input: StoryInput): ProvenanceStory {
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const instancesBySource = new Map<string, string[]>();
  for (const i of input.instances) {
    if (!byId.has(i.source_id)) continue;
    const list = instancesBySource.get(i.source_id) ?? [];
    list.push(i.id);
    instancesBySource.set(i.source_id, list);
  }

  // Downstream adjacency within the story: upstream source -> sources resting on it.
  const down = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const set = down.get(from) ?? new Set<string>();
    set.add(to);
    down.set(from, set);
  };

  const upstream = new Map<string, Map<string, { source_id: string; relation_type: string; fidelity: string }>>();
  const diverges = new Set<string>();
  for (const e of input.edges) {
    if (!byId.has(e.from_source_id) || !byId.has(e.to_source_id)) continue;
    const key = `${e.to_source_id}|${e.relation_type}|${e.fidelity}`;
    const map = upstream.get(e.from_source_id) ?? new Map();
    map.set(key, { source_id: e.to_source_id, relation_type: e.relation_type, fidelity: e.fidelity });
    upstream.set(e.from_source_id, map);
    link(e.to_source_id, e.from_source_id);
    if (DIVERGENT_FIDELITIES.has(e.fidelity)) diverges.add(e.from_source_id);
  }

  const copyOf = new Map<string, Set<string>>();
  const copies = new Map<string, Set<string>>();
  for (const r of input.republishes) {
    const set = copies.get(r.parent_source_id) ?? new Set<string>();
    set.add(r.child_source_id);
    copies.set(r.parent_source_id, set);
    if (byId.has(r.parent_source_id) && byId.has(r.child_source_id)) {
      const of = copyOf.get(r.child_source_id) ?? new Set<string>();
      of.add(r.parent_source_id);
      copyOf.set(r.child_source_id, of);
      link(r.parent_source_id, r.child_source_id);
    }
  }

  const roots = new Map(input.roots.filter((r) => byId.has(r.source_id)).map((r) => [r.source_id, r]));

  const standing = new Map<string, { standing: StoryStanding; basis: StoryBasis }>();
  for (const s of input.sources) {
    const root = roots.get(s.id);
    const hasUpstream = (upstream.get(s.id)?.size ?? 0) > 0 || (copyOf.get(s.id)?.size ?? 0) > 0;
    let value: { standing: StoryStanding; basis: StoryBasis };
    if (root?.status === "origin") value = { standing: "origin", basis: "steward" };
    else if (hasUpstream) value = { standing: "derived", basis: "upstream" };
    else if (root?.status === "untraced") value = { standing: "untraced", basis: "steward" };
    else if (PRIMARY_SOURCE_TYPES.has(s.source_type)) value = { standing: "origin", basis: "primary_source_kind" };
    else value = { standing: "untraced", basis: "none" };
    standing.set(s.id, value);
  }

  // Depth: breadth-first from the top row (every origin and untraced node).
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const s of input.sources) {
    if (standing.get(s.id)!.standing !== "derived") {
      depth.set(s.id, 0);
      queue.push(s.id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const next of down.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(id)! + 1);
      queue.push(next);
    }
  }

  const reach = (id: string): number => {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      for (const next of down.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen.size - 1;
  };

  const nodes: StoryNode[] = input.sources.map((s) => {
    const root = roots.get(s.id);
    const st = standing.get(s.id)!;
    return {
      source: s,
      instance_ids: instancesBySource.get(s.id) ?? [],
      underlying: !instancesBySource.has(s.id),
      standing: st.standing,
      basis: st.basis,
      root: root
        ? { status: root.status, basis: root.basis, created_by: root.created_by, updated_at: root.updated_at }
        : null,
      depth: depth.get(s.id) ?? null,
      upstream: [...(upstream.get(s.id)?.values() ?? [])],
      copy_of: [...(copyOf.get(s.id) ?? [])],
      downstream: down.get(s.id)?.size ?? 0,
      downstream_total: reach(s.id),
      copies: copies.get(s.id)?.size ?? 0,
      diverges: diverges.has(s.id),
    };
  });

  nodes.sort(
    (a, b) =>
      (a.depth ?? Infinity) - (b.depth ?? Infinity) ||
      STANDING_RANK[a.standing] - STANDING_RANK[b.standing] ||
      Number(b.diverges) - Number(a.diverges) ||
      b.downstream_total - a.downstream_total ||
      b.copies - a.copies ||
      a.source.title.localeCompare(b.source.title) ||
      a.source.id.localeCompare(b.source.id)
  );

  return {
    claim_id: claimId,
    nodes,
    counts: {
      sources: nodes.length,
      origins: nodes.filter((n) => n.standing === "origin").length,
      untraced: nodes.filter((n) => n.standing === "untraced").length,
      derived: nodes.filter((n) => n.standing === "derived").length,
      underlying: nodes.filter((n) => n.underlying).length,
    },
  };
}

/** Load a claim's provenance rows and build its origins-first story. */
export async function getProvenanceStory(claimId: string): Promise<ProvenanceStory> {
  const [instances, edges, roots] = await Promise.all([
    rawQuery<{ id: string; source_id: string }>(
      `SELECT id, source_id FROM claim_instances WHERE claim_id = $1`,
      [claimId]
    ),
    rawQuery<StoryEdgeInput>(
      `SELECT e.from_instance_id, ci.source_id AS from_source_id, e.to_source_id,
              e.relation_type, e.fidelity
         FROM claim_provenance_edges e
         JOIN claim_instances ci ON ci.id = e.from_instance_id
        WHERE ci.claim_id = $1`,
      [claimId]
    ),
    rawQuery<{ source_id: string; status: "origin" | "untraced"; basis: string; created_by: string; updated_at: Date }>(
      `SELECT source_id, status, basis, created_by, updated_at
         FROM claim_provenance_roots WHERE claim_id = $1`,
      [claimId]
    ),
  ]);
  const ids = [...new Set([...instances.map((i) => i.source_id), ...edges.map((e) => e.to_source_id)])];
  if (ids.length === 0) {
    return buildProvenanceStory(claimId, { sources: [], instances: [], edges: [], republishes: [], roots: [] });
  }
  const [sources, republishes] = await Promise.all([
    rawQuery<StorySource>(
      `SELECT id, title, url, source_type FROM sources WHERE id = ANY($1::uuid[])`,
      [ids]
    ),
    rawQuery<{ parent_source_id: string; child_source_id: string }>(
      `SELECT parent_source_id, child_source_id FROM source_relationships
        WHERE relation_type = 'republishes' AND parent_source_id = ANY($1::uuid[])`,
      [ids]
    ),
  ]);
  return buildProvenanceStory(claimId, {
    sources,
    instances,
    edges,
    republishes,
    roots: roots.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() })),
  });
}
