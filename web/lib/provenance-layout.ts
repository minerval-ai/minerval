import type { ProvenanceEdge, ProvenanceStory, StoryNode } from "./types";

// ---------------------------------------------------------------------------
// The origins-first provenance map's grouping and folding (#507). Pure: the
// story in, a tree of display items out, so ProvenanceMap only draws.
//
// Every item is a source (or a count standing for several); the claim is
// never one. The story view hangs everything from the top row, origins and
// untraced apart; the focus view puts one source on the spine with its
// lineage above and what draws on it below. Breadth first throughout, so a
// source reachable two ways sits at its shallowest layer, under the first
// parent that reaches it; its other parents are named on the card.
// Shallow by default: two layers below the top, deeper ones fold into a count
// that opens in place. Nothing here weighs anything; order is the story's own
// (depth, standing, divergence, downstream count, copies).
// ---------------------------------------------------------------------------

export type Relation = ProvenanceEdge["relation_type"];
export type Fidelity = ProvenanceEdge["fidelity"];

export interface ItemEdge { relation: Relation; fidelity: Fidelity }

export interface CardItem {
  kind: "card";
  key: string;
  /** One source, or several like siblings merged into a counted stack. */
  members: StoryNode[];
  /** The edge from this item up to its parent in the drawing; null at the top. */
  edge: ItemEdge | null;
  /** 0: top row (or the focus), 1: first layer, 2: deeper. */
  level: number;
  /** Other sources it draws on that the drawing places elsewhere. */
  also: StoryNode[];
  children: Item[];
}
export interface FoldItem {
  kind: "fold";
  key: string;
  count: number;
  noun: "restatements" | "responses" | "copies" | "sources";
  diverging: number;
}
export interface MoreItem { kind: "more"; key: string; count: number }
export type Item = CardItem | FoldItem | MoreItem;

export interface StoryLayout {
  origins: Item[];
  untraced: Item[];
  /** Derived sources nothing at the top reaches (a loop with no way in). */
  unanchored: Item[];
}

export interface UpItem {
  card: CardItem;
  /** The next layer up from this parent, as chips. */
  parents: CardItem[];
  /** Ancestors beyond those chips. */
  further: number;
}
export interface FocusLayout {
  focus: CardItem;
  upstream: UpItem[];
  /** Parents left out of the row, behind "more:up". */
  upMore: number;
}

const SEVERITY: Fidelity[] = ["distorted", "misattributed", "strengthened", "weakened", "unclear", "faithful"];
export const DIVERGENT = new Set<Fidelity>(["strengthened", "weakened", "distorted", "misattributed"]);

export const RELATION_LABEL: Record<Relation, string> = {
  repeats: "repeats",
  derives_from: "derives from",
  reanalyzes: "reanalyzes",
  republishes: "republishes",
  cites_as_evidence: "cites as evidence",
  responds_to: "responds to",
};

export function edgeLabel(e: ItemEdge): string {
  if (e.relation === "responds_to" && e.fidelity === "faithful") return RELATION_LABEL.responds_to;
  return `${RELATION_LABEL[e.relation]} · ${e.fidelity}`;
}

function worse(a: ItemEdge, b: ItemEdge): ItemEdge {
  return SEVERITY.indexOf(b.fidelity) < SEVERITY.indexOf(a.fidelity) ? b : a;
}

/** Everything a node draws on, one edge per upstream source (the most divergent when several). */
export function upstreamOf(n: StoryNode): Map<string, ItemEdge> {
  const out = new Map<string, ItemEdge>();
  for (const u of n.upstream) {
    const e: ItemEdge = { relation: u.relation_type, fidelity: u.fidelity };
    const had = out.get(u.source_id);
    out.set(u.source_id, had ? worse(had, e) : e);
  }
  // A republished copy draws on its original; a copy carries it over as is.
  for (const id of n.copy_of) if (!out.has(id)) out.set(id, { relation: "republishes", fidelity: "faithful" });
  return out;
}

interface Ctx {
  byId: Map<string, StoryNode>;
  down: Map<string, Array<{ id: string; edge: ItemEdge }>>;
  open: ReadonlySet<string>;
  /** How many first-layer cards fit across the map. */
  slots: number;
  /** Small stories show every sibling; large ones cap each row. */
  relaxed: boolean;
}

function context(story: ProvenanceStory, open: ReadonlySet<string>, slots: number): Ctx {
  const byId = new Map(story.nodes.map((n) => [n.source.id, n]));
  const down = new Map<string, Array<{ id: string; edge: ItemEdge }>>();
  // story.nodes is already in display order, so each list inherits it.
  for (const n of story.nodes) {
    for (const [up, edge] of upstreamOf(n)) {
      if (!byId.has(up)) continue;
      const list = down.get(up) ?? [];
      list.push({ id: n.source.id, edge });
      down.set(up, list);
    }
  }
  return { byId, down, open, slots: Math.max(1, slots), relaxed: story.nodes.length <= 8 };
}

function card(members: StoryNode[], edge: ItemEdge | null, level: number): CardItem {
  const key = members.length > 1 ? `stack:${members[0].source.id}` : members[0].source.id;
  return { kind: "card", key, members, edge, level, also: [], children: [] };
}

// Like siblings (same relation and fidelity, each drawing on this parent
// alone) merge into one counted stack; a stack opened in place lists them.
function group(ctx: Ctx, kids: Array<{ id: string; edge: ItemEdge }>, level: number): CardItem[] {
  const out: CardItem[] = [];
  const stacks = new Map<string, CardItem>();
  for (const k of kids) {
    const n = ctx.byId.get(k.id)!;
    // A source with a standing of its own (an origin answering another) keeps its own card.
    const single = n.standing === "derived" && upstreamOf(n).size === 1;
    const sig = `${k.edge.relation}|${k.edge.fidelity}`;
    const into = single ? stacks.get(sig) : undefined;
    if (into) { into.members.push(n); continue; }
    const c = card([n], k.edge, level);
    out.push(c);
    if (single) stacks.set(sig, c);
  }
  // Display order only: departures first, responses last, else the story's own order.
  const rank = (c: CardItem) =>
    c.edge?.relation === "responds_to" ? 2 : c.edge && DIVERGENT.has(c.edge.fidelity) ? 0 : 1;
  out.sort((a, b) => rank(a) - rank(b));
  const result: CardItem[] = [];
  for (const c of out) {
    if (c.members.length > 1) {
      c.key = `stack:${c.members[0].source.id}`;
      if (ctx.open.has(c.key)) {
        for (const m of c.members) result.push(card([m], c.edge, level));
        continue;
      }
    }
    result.push(c);
  }
  return result;
}

// The first layer fans across the map, so it takes what fits; deeper layers
// hang in a column under their card, so they cap at a glanceable few.
function capFor(ctx: Ctx, level: number): number {
  if (level === 1) return ctx.slots;
  return ctx.relaxed ? Infinity : 3;
}

function sourcesIn(items: Item[]): number {
  let n = 0;
  for (const it of items) n += it.kind === "card" ? it.members.length : it.count;
  return n;
}

/**
 * Hang each item's unseen downstream under it, breadth first, to `maxLevel`
 * layers (an opened fold lets one item go a layer further), then fold the
 * rest of every leaf's descendants into a single count.
 */
function grow(ctx: Ctx, tops: CardItem[], seen: Set<string>, maxLevel: number) {
  let frontier: CardItem[] = tops;
  for (let level = 1; frontier.length && level < 64; level++) {
    const next: CardItem[] = [];
    for (const it of frontier) {
      if (level > maxLevel && !ctx.open.has(`fold:${it.key}`)) continue;
      const kids: Array<{ id: string; edge: ItemEdge }> = [];
      const local = new Set<string>();
      for (const m of it.members) {
        for (const k of ctx.down.get(m.source.id) ?? []) {
          if (seen.has(k.id) || local.has(k.id)) continue;
          local.add(k.id);
          kids.push(k);
        }
      }
      if (!kids.length) continue;
      for (const k of kids) seen.add(k.id);
      const cards = group(ctx, kids, level);
      const cap = ctx.open.has(`more:${it.key}`) ? Infinity : capFor(ctx, level);
      // A first-layer overflow sits below the row, so it does not take a slot.
      const shown = cards.length > cap ? cards.slice(0, level === 1 ? cap : cap - 1) : cards;
      const hidden = cards.slice(shown.length);
      it.children = [...shown];
      if (hidden.length) it.children.push({ kind: "more", key: `more:${it.key}`, count: sourcesIn(hidden) });
      next.push(...shown);
    }
    frontier = next;
  }

  // Folds, shallowest leaves first so a shared descendant counts once.
  const leaves: CardItem[] = [];
  const walk = (it: CardItem) => {
    const cs = it.children.filter((c): c is CardItem => c.kind === "card");
    if (!it.children.length) leaves.push(it);
    cs.forEach(walk);
  };
  tops.forEach(walk);
  leaves.sort((a, b) => a.level - b.level);
  for (const leaf of leaves) {
    const acc: string[] = [];
    const rels = new Set<string>();
    let diverging = 0;
    const stack = leaf.members.map((m) => m.source.id);
    while (stack.length) {
      const id = stack.pop()!;
      for (const k of ctx.down.get(id) ?? []) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        acc.push(k.id);
        stack.push(k.id);
        rels.add(k.edge.relation);
        if (ctx.byId.get(k.id)!.diverges) diverging++;
      }
    }
    if (!acc.length) continue;
    leaf.children = [{ kind: "fold", key: `fold:${leaf.key}`, count: acc.length, noun: nounFor(rels), diverging }];
  }

  // Name the parents the tree could not draw the card under.
  const placedUnder = new Map<string, Set<string>>();
  const note = (it: CardItem, parent: CardItem | null) => {
    for (const m of it.members) placedUnder.set(m.source.id, new Set(parent ? parent.members.map((p) => p.source.id) : []));
    for (const c of it.children) if (c.kind === "card") note(c, it);
  };
  tops.forEach((t) => note(t, null));
  const fill = (it: CardItem, isTop: boolean) => {
    if (!isTop && it.members.length === 1) {
      const n = it.members[0];
      const under = placedUnder.get(n.source.id) ?? new Set();
      it.also = [...upstreamOf(n).keys()]
        .filter((id) => !under.has(id))
        .map((id) => ctx.byId.get(id))
        .filter((x): x is StoryNode => !!x);
    }
    for (const c of it.children) if (c.kind === "card") fill(c, false);
  };
  tops.forEach((t) => fill(t, true));
}

function nounFor(rels: Set<string>): FoldItem["noun"] {
  const all = [...rels];
  if (all.every((r) => r === "repeats" || r === "republishes")) return all.every((r) => r === "republishes") ? "copies" : "restatements";
  if (all.every((r) => r === "responds_to")) return "responses";
  return "sources";
}

const TOP_CAP = { origin: 6, untraced: 3, unanchored: 4 } as const;

function capTop(ctx: Ctx, items: CardItem[], lane: keyof typeof TOP_CAP): Item[] {
  const cap = ctx.open.has(`more:lane:${lane}`) || ctx.relaxed ? Infinity : TOP_CAP[lane];
  if (items.length <= cap) return items;
  const shown = items.slice(0, cap - 1);
  return [...shown, { kind: "more", key: `more:lane:${lane}`, count: items.length - shown.length }];
}

/** The origins-first story: the top row in its two lanes, two layers below each. */
export function layoutStory(story: ProvenanceStory, open: ReadonlySet<string>, slots: number): StoryLayout {
  const ctx = context(story, open, slots);
  const seen = new Set<string>();
  const top = story.nodes.filter((n) => n.depth === 0);
  const origins = top.filter((n) => n.standing === "origin").map((n) => card([n], null, 0));
  const untraced = top.filter((n) => n.standing !== "origin").map((n) => card([n], null, 0));
  const shownOrigins = capTop(ctx, origins, "origin");
  const shownUntraced = capTop(ctx, untraced, "untraced");
  const tops = [...shownOrigins, ...shownUntraced].filter((i): i is CardItem => i.kind === "card");
  // Hidden top cards stay unseen-but-claimed so their trees are not grafted elsewhere.
  for (const n of top) seen.add(n.source.id);
  grow(ctx, tops, seen, 2);

  const loose = story.nodes.filter((n) => n.depth === null && !seen.has(n.source.id)).map((n) => card([n], null, 2));
  return { origins: shownOrigins, untraced: shownUntraced, unanchored: capTop(ctx, loose, "unanchored") };
}

/** One source on the spine: two layers of lineage above, two of what draws on it below. */
export function layoutFocus(story: ProvenanceStory, focusId: string, open: ReadonlySet<string>, slots: number): FocusLayout | null {
  const ctx = context(story, open, slots);
  const f = ctx.byId.get(focusId);
  if (!f) return null;
  const seen = new Set<string>([focusId]);
  const upstream: UpItem[] = [];
  for (const [id, edge] of upstreamOf(f)) {
    const p = ctx.byId.get(id);
    if (!p || seen.has(id)) continue;
    seen.add(id);
    upstream.push({ card: card([p], edge, 1), parents: [], further: 0 });
  }
  const chipCap = 3;
  let upMore = 0;
  if (upstream.length > ctx.slots && !open.has("more:up")) {
    // Hidden parents stay claimed so they do not resurface as grandparents.
    upMore = upstream.length - ctx.slots;
    upstream.splice(ctx.slots);
  }
  for (const u of upstream) {
    const gps = [...upstreamOf(u.card.members[0])].filter(([id]) => ctx.byId.has(id) && !seen.has(id));
    for (const [id] of gps) seen.add(id);
    u.parents = gps.slice(0, chipCap).map(([id, edge]) => card([ctx.byId.get(id)!], edge, 2));
    // Everything further up, counted once.
    const further = new Set<string>(gps.slice(chipCap).map(([id]) => id));
    const stack = u.parents.map((c) => c.members[0].source.id);
    while (stack.length) {
      for (const id of upstreamOf(ctx.byId.get(stack.pop()!)!).keys()) {
        if (!ctx.byId.has(id) || further.has(id) || seen.has(id)) continue;
        further.add(id);
        stack.push(id);
      }
    }
    u.further = further.size;
  }
  const focus = card([f], null, 0);
  grow(ctx, [focus], seen, 2);
  return { focus, upstream, upMore };
}

/** Plain counts for the line above the map: structure, never weight. */
export function storyCounts(story: ProvenanceStory) {
  return {
    sources: story.counts.sources,
    origins: story.counts.origins,
    untraced: story.counts.untraced,
    underlying: story.counts.underlying,
    diverging: story.nodes.filter((n) => n.diverges).length,
  };
}

/** A story worth drawing: any source at all. A lone untraced source still shows, honestly, as untraced. */
export function hasStory(story: ProvenanceStory | null | undefined): story is ProvenanceStory {
  return !!story && story.nodes.length > 0;
}
