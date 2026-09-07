import type {
  AssessmentStatus, CheckKind, ClaimDetail, ClaimType, DependentClaim, RelationType,
  Stance, TreeNode,
} from "@/lib/types";
import { orderByMention } from "@/lib/claim-links";
import { isAssumesRelation } from "@/lib/ontology";
import { liveBountyMicro } from "@/lib/prizes";

// ---------------------------------------------------------------------------
// The map view's layout engine (issue #79, "The View from a Claim").
//
// Deterministic banded slotting, not force-directed: the focus claim sits on a
// fixed vertical spine with its dependents above ("rests on this") and its
// decomposition below ("this rests on"), detail falling off with graph
// distance — tier-1 chips, tier-2 chips, tier-3 glyph minims. Named arguments
// group their subclaims under stance-tinted pills, FOR fanning left of centre
// and AGAINST right, so the shape of the dispute is legible before any text is
// read. Everything is computed in "world" coordinates centred on x=0 at the
// focus card; GraphView scales the world to fit the stage.
// ---------------------------------------------------------------------------

export type BedrockKind = "fact" | "open" | "value" | "theorem";

// Bedrock is a property of the ontology, not a column: an atomic claim bottoms
// out as a checkable fact, a genuinely open empirical question, a value
// premise (constitution §2), or, in mathematics, a theorem whose proof a
// machine has checked (docs/mathematics.md §8.3). We infer the flavour from
// claim type + status (+ the check) and only for leaves, so the marking never
// overstates what the graph knows.
export function bedrockOf(
  claimType: ClaimType | null,
  status: AssessmentStatus | null,
  leaf: boolean,
  checked: CheckKind | null = null,
): BedrockKind | null {
  if (!leaf) return null;
  if (claimType === "mathematical" && checked === "proof") return "theorem";
  if (claimType === "normative" || claimType === "evaluative") return "value";
  if (claimType === "empirical_verifiable" && (status === "verified" || status === "contradicted")) {
    return "fact";
  }
  if (status === "contested") return "open";
  return null;
}

export const BEDROCK: Record<BedrockKind, { tag: string; note: string }> = {
  fact: {
    tag: "bedrock · fact",
    note: "Bedrock: a verified fact. It is checked directly against sources; nothing lies beneath it.",
  },
  open: {
    tag: "bedrock · open question",
    note: "Bedrock: a genuinely open empirical question. The graph records the disagreement rather than resolving it.",
  },
  value: {
    tag: "bedrock · value premise",
    note: "Bedrock: a fundamental value premise. Disagreement here is not empirical; the graph makes that visible.",
  },
  theorem: {
    tag: "bedrock · theorem",
    note: "Bedrock: a theorem whose proof a machine has checked against its published formal statement. The checker confirms the proof; the verdict is still the steward's judgment of the claim as worded.",
  },
};

// What one node on the map knows about its claim. Tree children, dependents and
// the focus claim all normalise into this shape.
export interface ClaimBits {
  id: string;
  text: string;
  claimType: ClaimType | null;
  status: AssessmentStatus | null;
  confidence: number | null;       // verdict confidence — meta, not P(true)
  credence: number | null;         // the Steward's P(claim true), when stated (#238)
  // Steward-seeded prior credence (#285): the parent Steward's preliminary
  // P(true), carried only while the claim is unassessed. A confident seed
  // tints the node's unassessed glyph; it never fills `status` or `credence`.
  seedCredence?: number | null;
  relation: RelationType | null;   // the edge that connects it toward the focus
  reasoning: string | null;        // why that edge holds (claim_relationships.reasoning)
  argumentId: string | null;
  argumentName: string | null;
  argumentStance: Stance | null;
  childCount: number;
  bedrock: BedrockKind | null;
  // Mathematics (docs/mathematics.md §8.3): a live bounty's amount, drawn as
  // a double ring and a $ mark; an accepted machine check, drawn as ⊢; and
  // whether a published formal statement exists. The amount is not painted
  // on the node: the map orients, the claim page informs.
  prizeMicroUsd: number | null;
  checked: CheckKind | null;
  formal: boolean;
  up: boolean;                     // true for dependents (edge points at the focus)
  // Zero children in the response does NOT always mean atomic (#160):
  // a shared subclaim's repeat occurrence carries its children only at the
  // first occurrence (subtree_collapsed), and the node cap can drop children
  // (children_truncated). Both must suppress the atomic tag and bedrock hatch.
  collapsed?: boolean;
  truncated?: boolean;
}

export interface LNode {
  key: string;
  kind: "focus" | "t1" | "t2" | "mini" | "dep" | "depstub" | "pill" | "more" | "side";
  x: number;                       // centre-x in world coordinates
  y: number;                       // top-y in world coordinates
  w: number;
  h: number;
  claim?: ClaimBits;
  node?: TreeNode;                 // the subtree, for optimistic recentering
  pill?: { argId: string; name: string; stance: Stance };
  more?: { label: string; action: "group" | "deps"; key: string };
  expandable?: boolean;
  expandedNow?: boolean;
}

export interface LEdge {
  x1: number; y1: number; x2: number; y2: number;
  rel: string;                     // relation type, or "spine" for focus→pill
  ids: string[];                   // claim ids this edge touches (for hover highlight)
  mini?: boolean;
  horiz?: boolean;
}

export interface LLabel { x: number; y: number; rel: RelationType; text: string }

export type LMisc =
  | { kind: "band"; x: number; y: number; text: string }
  | { kind: "deplabel"; x: number; y: number; n: number; dist: (AssessmentStatus | null)[]; pending: boolean }
  | { kind: "plinth"; x: number; y: number; w: number; bedrock: BedrockKind | null; note: string };

export interface Layout {
  nodes: LNode[];
  edges: LEdge[];
  labels: LLabel[];
  misc: LMisc[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  focus: { x: number; y: number };  // centre of the focus card, for scroll-centering
}

export interface LayoutOptions {
  expanded: Set<string>;    // tier-1 ids whose children are shown
  moreOpen: Set<string>;    // argument-group keys with the overflow unfolded
  depsOpen: boolean;        // dependents band unfolded into stub rows
  compact: boolean;         // narrow screens: tighter degree-of-interest caps
  plinthNote: string;       // empty-state copy under a leaf focus
  depsPending: boolean;     // dependents not yet loaded (optimistic recenter)
  // The focus's prize, check, and statement marks while the optimistic
  // recentre's partial detail has not fetched them: carried from the clicked
  // node so a prized claim does not lose its ring for the 280 ms until the
  // fetch lands. Null once the full detail is in.
  focusMarks?: Pick<ClaimBits, "prizeMicroUsd" | "checked" | "formal"> | null;
}

// Node dimensions and gaps (world px). Detail falls off with distance: the
// focus is a full card, tier 1 a readable chip, tier 2 a two-line chip, tier 3
// a glyph-only minim.
const W = { focus: 420, t1: 150, t2: 118, mini: 30, dep: 172, depstub: 132, more: 58, side: 156 };
const H = { t1: 112, t2: 76, mini: 18, dep: 58, depstub: 46, more: 34, pill: 22, side: 88 };

// The focus card's height tracks its text: the hero clamps at three lines, so
// estimate the line count from length (conservative chars-per-line so a
// misjudged wrap gains whitespace, never an overflowing status band).
function focusHeight(text: string): number {
  const lines = Math.min(3, Math.max(1, Math.ceil(text.length / 40)));
  return 88 + lines * 26;
}
const GAP = 10;
const GRPGAP = 26;

interface ChildEntry { node: TreeNode; groupKey: string }

export function computeLayout(detail: ClaimDetail, opts: LayoutOptions): Layout {
  const caps = opts.compact
    ? { t1: 2, t2: 3, dep: 2 }
    : { t1: 3, t2: 4, dep: 3 };

  const nodes: LNode[] = [];
  const edges: LEdge[] = [];
  const labels: LLabel[] = [];
  const misc: LMisc[] = [];
  const seen = new Set<string>();  // one node per claim id on the map (it's a DAG)

  const focusId = detail.claim.id;
  seen.add(focusId);
  const children = detail.tree?.children ?? [];
  const focusH = focusHeight(detail.claim.text);

  const treeBits = (n: TreeNode): ClaimBits => ({
    id: n.id,
    text: n.text,
    claimType: n.claim_type,
    status: n.assessment_status,
    confidence: n.assessment_confidence,
    // The API already nulls the seed once a node is assessed; the guard here
    // keeps the invariant even against a fixture or an optimistic partial.
    seedCredence: n.assessment_status == null ? n.seed_credence ?? null : null,
    credence: n.assessment_credence ?? null,
    relation: n.relation_type,
    reasoning: n.reasoning,
    argumentId: n.argument_id,
    argumentName: n.argument_name,
    argumentStance: n.argument_stance,
    childCount: n.children.length,
    // A node is only a leaf if its children are genuinely absent — not elided
    // as a shared-subclaim repeat or dropped by the response's node cap.
    bedrock: bedrockOf(
      n.claim_type,
      n.assessment_status,
      n.children.length === 0 && !n.subtree_collapsed && !n.children_truncated,
      n.checked ?? null,
    ),
    prizeMicroUsd: n.bounty_micro_usd ?? null,
    checked: n.checked ?? null,
    formal: !!n.formal,
    up: false,
    collapsed: !!n.subtree_collapsed,
    truncated: !!n.children_truncated,
  });

  // ---- dependents band (above the focus) ----------------------------------
  const deps = (detail.dependents ?? []).filter((d) => d.id !== focusId);
  const depVis = deps.slice(0, caps.dep);
  const depRest = opts.depsOpen ? deps.slice(caps.dep) : [];
  const hiddenDeps = deps.length - depVis.length;

  const yDep = 8;
  interface DepRow { items: { dep: DependentClaim; stub: boolean }[]; h: number }
  const depRows: DepRow[] = [];
  if (deps.length) {
    depRows.push({ items: depVis.map((dep) => ({ dep, stub: false })), h: H.dep });
    if (opts.depsOpen) {
      for (let i = 0; i < depRest.length; i += 8) {
        depRows.push({
          items: depRest.slice(i, i + 8).map((dep) => ({ dep, stub: true })),
          h: H.depstub,
        });
      }
    }
  }
  const depBlockH = depRows.reduce((a, r) => a + r.h + 12, 0);
  const yFocus = yDep + Math.max(depBlockH, 58) + 44;

  let ry = yDep;
  depRows.forEach((row, ri) => {
    const ws = row.items.map((r) => (r.stub ? W.depstub : W.dep));
    const moreW = ri === 0 && (hiddenDeps > 0 || opts.depsOpen) ? W.more + GAP : 0;
    const rw = ws.reduce((a, b) => a + b, 0) + (row.items.length - 1) * GAP + moreW;
    let rx = -rw / 2;
    row.items.forEach((r, i) => {
      if (seen.has(r.dep.id)) { rx += ws[i] + GAP; return; }
      seen.add(r.dep.id);
      const cx = rx + ws[i] / 2;
      nodes.push({
        key: r.dep.id,
        kind: r.stub ? "depstub" : "dep",
        x: cx, y: ry, w: ws[i], h: row.h,
        claim: {
          id: r.dep.id,
          text: r.dep.text,
          claimType: r.dep.claim_type,
          status: r.dep.assessment_status,
          confidence: r.dep.assessment_confidence,
          credence: r.dep.assessment_credence ?? null,
          relation: r.dep.relation_type,
          reasoning: r.dep.reasoning ?? null,
          argumentId: null, argumentName: null, argumentStance: null,
          childCount: 0,
          bedrock: null,
          prizeMicroUsd: r.dep.bounty_micro_usd ?? null,
          checked: r.dep.checked ?? null,
          formal: !!r.dep.formal,
          up: true,
        },
      });
      // Edge from the dependent down to the focus card's top edge; the landing
      // x is squeezed toward the card centre so many edges stay legible.
      const lx = Math.max(-W.focus / 2 + 40, Math.min(W.focus / 2 - 40, cx * 0.35));
      edges.push({ x1: cx, y1: ry + row.h, x2: lx, y2: yFocus, rel: r.dep.relation_type, ids: [r.dep.id] });
      if (!r.stub) {
        labels.push({ x: (cx + lx) / 2, y: (ry + row.h + yFocus) / 2 + (i % 2 ? 10 : -4), rel: r.dep.relation_type, text: r.dep.relation_type });
      }
      rx += ws[i] + GAP;
    });
    if (ri === 0 && (hiddenDeps > 0 || opts.depsOpen)) {
      nodes.push({
        key: "more:deps",
        kind: "more",
        x: rx + W.more / 2, y: ry + 8, w: W.more, h: H.more,
        more: { label: opts.depsOpen ? "fewer" : `+${hiddenDeps}`, action: "deps", key: "deps" },
      });
    }
    ry += row.h + 12;
  });

  const depLabel: LMisc = {
    kind: "deplabel",
    x: 0, // right-aligned into the shared left gutter, set once bounds are known
    y: yDep + 4,
    n: deps.length,
    dist: deps.map((d) => d.assessment_status),
    pending: opts.depsPending,
  };
  misc.push(depLabel);

  // ---- downward: children grouped by argument ------------------------------
  // Assumption edges break the vertical grammar deliberately: a framework
  // premise sits BESIDE the claim (a sidenote), not beneath it in a lane.
  const presup: TreeNode[] = [];
  const laneChildren: TreeNode[] = [];
  for (const c of children) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (isAssumesRelation(c.relation_type) && presup.length < 3) presup.push(c);
    else laneChildren.push(c);
  }

  // Group by argument. Following lib/ontology's groupByArgument: a group is
  // "named" only when argument_name is present; everything else pools into the
  // unnamed group, which renders with zero chrome (the transparent one-argument
  // case from the constitution).
  const byGroup = new Map<string, ChildEntry[]>();
  const groupMeta = new Map<string, { name: string; stance: Stance }>();
  for (const c of laneChildren) {
    const key = c.argument_name && c.argument_id ? c.argument_id : "_";
    if (key !== "_" && !groupMeta.has(key)) {
      groupMeta.set(key, { name: c.argument_name!, stance: c.argument_stance ?? "neutral" });
    }
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push({ node: c, groupKey: key });
  }
  // FOR fans left of centre, AGAINST right, the unnamed group holds the centre.
  const order: string[] = [];
  for (const [k, m] of groupMeta) if (m.stance === "for") order.push(k);
  for (const [k, m] of groupMeta) if (m.stance === "neutral") order.push(k);
  if (byGroup.has("_")) order.push("_");
  for (const [k, m] of groupMeta) if (m.stance === "against") order.push(k);

  const hasPills = order.some((k) => k !== "_");
  const yPill = yFocus + focusH + 86;
  const yT1 = hasPills ? yPill + H.pill + 40 : yFocus + focusH + 92;
  const yT2 = yT1 + H.t1 + 50;
  const yT3 = yT2 + H.t2 + 34;

  const t2list = (t1: TreeNode): (TreeNode | { overflow: number })[] => {
    if (!opts.expanded.has(t1.id)) return [];
    const kids = t1.children.filter((k) => !seen.has(k.id));
    const shown = kids.slice(0, caps.t2);
    const out: (TreeNode | { overflow: number })[] = [...shown];
    if (kids.length > caps.t2) out.push({ overflow: kids.length - caps.t2 });
    return out;
  };
  const slotW = (t1: TreeNode): number => {
    const t2 = t2list(t1);
    if (!t2.length) return W.t1;
    return Math.max(W.t1, t2.length * (W.t2 + 6) - 6);
  };

  const groups = order.map((key) => {
    // Within an argument, the written form's reading order wins (#201) — and
    // it decides which members survive the t1 cap when the group is closed.
    const members = orderByMention(
      byGroup.get(key)!,
      (m) => m.node.id,
      byGroup.get(key)![0]?.node.argument_content,
    );
    const open = opts.moreOpen.has(key);
    const vis = open ? members : members.slice(0, caps.t1);
    const extra = members.length - vis.length;
    const slots = vis.map((m) => slotW(m.node));
    const meta = key === "_" ? null : groupMeta.get(key)!;
    const rowW = slots.reduce((a, b) => a + b, 0) + Math.max(0, slots.length - 1) * GAP
      + (extra > 0 || open ? W.more + GAP : 0);
    // Uppercase at 0.56rem with 0.07em tracking runs ~8.3px/char; the previous
    // 6.4 undershot, and a centred overflow clips BOTH ends of the name. Cap at
    // the focus card's width — past that the CSS ellipsis takes over.
    const pillW = meta
      ? Math.min(W.focus, Math.max(130, (meta.name.length + meta.stance.length + 3) * 8.3 + 50))
      : 0;
    return { key, meta, vis, extra, open, slots, rowW, w: Math.max(rowW, pillW), pillW };
  });

  const totalW = groups.reduce((a, g) => a + g.w, 0) + Math.max(0, groups.length - 1) * GRPGAP;
  let gx = -totalW / 2;

  for (const g of groups) {
    const gc = gx + g.w / 2;
    let srcX = 0;
    let srcY = yFocus + focusH;
    if (g.meta) {
      nodes.push({
        key: `pill:${g.key}`, kind: "pill",
        x: gc, y: yPill, w: g.pillW, h: H.pill,
        pill: { argId: g.key, name: g.meta.name, stance: g.meta.stance },
      });
      edges.push({ x1: 0, y1: yFocus + focusH, x2: gc, y2: yPill, rel: "spine", ids: [`pill:${g.key}`] });
      srcX = gc;
      srcY = yPill + H.pill;
    }
    let px = gx + (g.w - g.rowW) / 2;
    g.vis.forEach((m, i) => {
      const sw = g.slots[i];
      const cx = px + sw / 2;
      const t1 = m.node;
      nodes.push({
        key: t1.id, kind: "t1",
        x: cx, y: yT1, w: W.t1, h: H.t1,
        claim: treeBits(t1),
        node: t1,
        expandable: t1.children.length > 0,
        expandedNow: opts.expanded.has(t1.id),
      });
      const rel = t1.relation_type ?? "requires";
      edges.push({ x1: srcX, y1: srcY, x2: cx, y2: yT1, rel, ids: [t1.id] });
      // Alternate label heights so adjacent siblings' labels never touch.
      labels.push({ x: (srcX + cx) / 2, y: (srcY + yT1) / 2 + (i % 2 ? 10 : -4), rel, text: rel });

      const t2 = t2list(t1);
      const t2w = t2.length * (W.t2 + 6) - 6;
      let tx = cx - t2w / 2;
      for (const te of t2) {
        if ("overflow" in te) {
          nodes.push({
            key: `t2more:${t1.id}`, kind: "more",
            x: tx + W.t2 / 2, y: yT2 + 6, w: W.t2 * 0.6, h: H.t2 * 0.6,
            more: { label: `+${te.overflow}`, action: "group", key: "" },
          });
          tx += W.t2 + 6;
          continue;
        }
        // Re-check at draw time: t2list snapshots `seen` before earlier
        // branches' minis run, so a shared subclaim already drawn as a mini
        // elsewhere would be drawn twice here — duplicate node, duplicate
        // React key (#230). First placement wins; keep the slot's spacing.
        if (seen.has(te.id)) {
          tx += W.t2 + 6;
          continue;
        }
        seen.add(te.id);
        nodes.push({ key: te.id, kind: "t2", x: tx + W.t2 / 2, y: yT2, w: W.t2, h: H.t2, claim: treeBits(te), node: te });
        edges.push({ x1: cx, y1: yT1 + H.t1, x2: tx + W.t2 / 2, y2: yT2, rel: te.relation_type ?? "requires", ids: [te.id, t1.id] });
        // tier-3: glyph-only minims — the periphery in miniature
        const t3 = te.children.filter((k) => !seen.has(k.id)).slice(0, 3);
        const t3w = t3.length * (W.mini + 5) - 5;
        let mx = tx + W.t2 / 2 - t3w / 2;
        for (const me of t3) {
          seen.add(me.id);
          nodes.push({ key: me.id, kind: "mini", x: mx + W.mini / 2, y: yT3, w: W.mini, h: H.mini, claim: treeBits(me), node: me });
          edges.push({ x1: tx + W.t2 / 2, y1: yT2 + H.t2, x2: mx + W.mini / 2, y2: yT3, rel: me.relation_type ?? "requires", ids: [me.id], mini: true });
          mx += W.mini + 5;
        }
        tx += W.t2 + 6;
      }
      px += sw + GAP;
    });
    if (g.extra > 0 || g.open) {
      nodes.push({
        key: `more:${g.key}`, kind: "more",
        x: px + W.more / 2, y: yT1 + H.t1 / 2 - H.more / 2, w: W.more, h: H.more,
        more: { label: g.open ? "fewer" : `+${g.extra} more`, action: "group", key: g.key },
      });
    }
    gx += g.w + GRPGAP;
  }

  // ---- assumption sidenotes (left flank of the focus) ----------------------
  presup.forEach((p, i) => {
    const sx = -(W.focus / 2 + 88 + W.side / 2);
    const sy = yFocus + 4 + i * (H.side + 12);
    nodes.push({ key: p.id, kind: "side", x: sx, y: sy, w: W.side, h: H.side, claim: treeBits(p), node: p });
    edges.push({
      x1: -W.focus / 2, y1: yFocus + focusH / 2,
      x2: sx + W.side / 2, y2: sy + H.side / 2,
      rel: "assumes", ids: [p.id], horiz: true,
    });
    labels.push({ x: (-W.focus / 2 + sx + W.side / 2) / 2, y: yFocus + focusH / 2 - 12 + i * (H.side + 12), rel: "assumes", text: "assumes" });
  });

  // ---- the focus card -------------------------------------------------------
  // Carries its own ClaimBits so hovering the centred claim fills the preview
  // panel just like any other node (no edge note — it is the vantage point).
  const focusMarks = opts.focusMarks ?? {
    prizeMicroUsd: liveBountyMicro(detail.bounty),
    checked: detail.verification?.kind ?? null,
    formal: !!detail.formalization,
  };
  nodes.push({
    key: focusId, kind: "focus", x: 0, y: yFocus, w: W.focus, h: focusH,
    claim: {
      id: focusId,
      text: detail.claim.text,
      claimType: detail.claim.claim_type,
      status: detail.assessment?.status ?? null,
      confidence: detail.assessment?.confidence ?? null,
      credence: detail.assessment?.claim_credence ?? null,
      seedCredence: detail.assessment ? null : detail.seed?.credence ?? null,
      relation: null,
      reasoning: null,
      argumentId: null, argumentName: null, argumentStance: null,
      childCount: children.length,
      bedrock: bedrockOf(
        detail.claim.claim_type,
        detail.assessment?.status ?? null,
        children.length === 0 && !detail.tree?.children_truncated,
        focusMarks.checked,
      ),
      ...focusMarks,
      up: false,
      truncated: !!detail.tree?.children_truncated,
    },
  });
  const focusCentre = { x: 0, y: yFocus + focusH / 2 };

  // ---- empty state: the plinth ---------------------------------------------
  let bottom = yFocus + focusH;
  if (!children.length) {
    misc.push({
      kind: "plinth",
      x: 0, y: yFocus + focusH + 36, w: W.focus * 0.82,
      bedrock: bedrockOf(
        detail.claim.claim_type,
        detail.assessment?.status ?? null,
        !detail.tree?.children_truncated,
        focusMarks.checked,
      ),
      note: opts.plinthNote,
    });
    bottom = yFocus + focusH + 36 + 90;
  } else {
    const anyT3 = nodes.some((n) => n.kind === "mini");
    const anyT2 = nodes.some((n) => n.kind === "t2" || (n.kind === "more" && n.y >= yT2));
    bottom = anyT3 ? yT3 + H.mini : anyT2 ? yT2 + H.t2 : yT1 + H.t1;
  }

  // ---- the shared left gutter -------------------------------------------------
  // Band labels and the dependents summary right-align into one gutter just
  // left of everything placed, so they can never collide with nodes (or each
  // other — they live on different rows of the same rail).
  let leftmost = -W.focus / 2;
  let maxX = W.focus / 2;
  for (const n of nodes) {
    leftmost = Math.min(leftmost, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
  }
  const gutterX = leftmost - 44;
  depLabel.x = gutterX;
  if (children.length) {
    misc.push({ kind: "band", x: gutterX, y: yT1 + 38, text: "this rests on ↓" });
  }

  // ---- bounds ---------------------------------------------------------------
  const bounds = { minX: gutterX - 150, maxX, minY: 0, maxY: bottom + 16 };

  return { nodes, edges, labels, misc, bounds, focus: focusCentre };
}

// Which tier-1 subclaims start expanded after a recenter: the first few that
// actually have children, so the map opens showing depth without drowning it.
export function defaultExpanded(detail: ClaimDetail, compact: boolean): Set<string> {
  const out = new Set<string>();
  const cap = compact ? 2 : 3;
  for (const c of detail.tree?.children ?? []) {
    if (out.size >= cap) break;
    if (c.children.length && !isAssumesRelation(c.relation_type)) out.add(c.id);
  }
  return out;
}
