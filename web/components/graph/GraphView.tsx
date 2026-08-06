"use client";

import Link from "next/link";
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import type {
  AssessmentStatus, ClaimDetail, ClaimType, RelationType, TreeNode,
} from "@/lib/types";
import type { DataSource } from "@/lib/data";
import {
  CLAIM_TYPE_LABEL, RELATION, STATUS, STATUS_ORDER,
  claimTypeMeta, decompositionNote, statusMeta,
  nodeStatusMeta, UNASSESSED_META, VERDICT_CONFIDENCE_GLOSS, CREDENCE_GLOSS,
  DEFINED_IN, STEWARD_SOURCE, isAssumesRelation,
  seedVerity, SEED_PRELIM_GLOSS,
} from "@/lib/ontology";
import { buildClaimTextMap } from "@/lib/claim-links";
import { ArgumentText } from "@/components/ArgumentText";
import { Term } from "@/components/Term";
import {
  BEDROCK, bedrockOf, computeLayout, defaultExpanded,
  type ClaimBits, type LEdge, type LNode, type Layout,
} from "./layout";
import { useRouter } from "next/navigation";
import styles from "./graph.module.css";

// ---------------------------------------------------------------------------
// The claim map (issue #79): a navigable focus+context view of one claim's
// neighbourhood — dependents above, decomposition below, down to bedrock.
// Clicking any claim recentres the map on it; the map at /claims/:id/map and
// the page at /claims/:id are two views of the same address. Orientation
// happens here; investigation happens on the page.
// ---------------------------------------------------------------------------

// Client-side cache of claim details, keyed by id. Recentring onto a claim the
// user has already visited (or arrived from) is instant; everything else is one
// BFF fetch. Module-level so it survives route transitions within the session.
const CACHE = new Map<string, ClaimDetail>();
const INFLIGHT = new Map<string, Promise<ClaimDetail | null>>();

async function fetchDetail(id: string): Promise<ClaimDetail | null> {
  const cached = CACHE.get(id);
  if (cached) return cached;
  const running = INFLIGHT.get(id);
  if (running) return running;
  const p = fetch(`/api/claims/${encodeURIComponent(id)}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { detail: ClaimDetail };
      CACHE.set(id, body.detail);
      return body.detail;
    })
    .catch(() => null)
    .finally(() => INFLIGHT.delete(id));
  INFLIGHT.set(id, p);
  return p;
}

// Optimistic detail for a claim we only know as a node of the current view:
// enough to recentre instantly (the subtree carries structure when we have it);
// the real fetch fills in dependents, arguments and importance.
function partialFrom(bits: ClaimBits, node?: TreeNode): ClaimDetail {
  return {
    claim: {
      id: bits.id,
      text: bits.text,
      claim_type: bits.claimType ?? "empirical_derived",
      state: "active",
      decomposition_status: "pending",
      importance: 0.5,
      created_by: "",
      created_at: "",
      updated_at: "",
    },
    assessment: bits.status
      ? {
          id: "", status: bits.status, confidence: bits.confidence ?? 0,
          claim_credence: bits.credence,
          summary: "", reasoning_trace: "", subclaim_summary: {}, assessed_at: "",
        }
      : null,
    subclaim_count: node?.children.length ?? 0,
    tree: node,
    dependents: undefined, // unknown until the fetch lands
    arguments: undefined,
  };
}

function findInTree(root: TreeNode | undefined, id: string): TreeNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findInTree(c, id);
    if (hit) return hit;
  }
  return null;
}

interface View { detail: ClaimDetail; partial: boolean }

interface PreviewState {
  kind: "claim" | "pill";
  claim?: ClaimBits;
  isFocus?: boolean;
  pill?: { argId: string; name: string; stance: string; desc: string | null };
  /** A clicked pill pins its explanation with a steer toward the claims (#249). */
  nudge?: boolean;
}

// The map's grammar, taught where the vocabulary already is (#253): the legend
// keys the shapes, in the same Term popovers as the statuses and relations.
// Node-level explanation belongs to the margin preview instead — the shapes'
// overflow clipping rules Terms out inside them, and the preview is the map's
// one consistent tooltip surface (pinned on click for pills, #249).
const MAP_KEY = {
  claim: "A box is a claim: a single proposition the graph assesses, with its own page and map. Click any claim to centre the map on it.",
  argument: "A pill is an argument: one line of reasoning stating how the claims beneath it combine to bear on the claim above it, for or against. Arguments are not destinations; click their claims to explore.",
} as const;

// Which status-colour family an unassessed node borrows when the parent
// Steward seeded it with a confident prior credence (#285): greenish when the
// seed says likely true, reddish when likely false, neutral otherwise. The
// node's glyph stays the hollow unassessed ◌ — a tint, never a verdict.
function seedTintKey(seedCredence: number | null | undefined): string {
  const v = seedVerity(seedCredence);
  return v > 0 ? "supported" : v < 0 ? "contradicted" : "unassessed";
}

// null is "unassessed" (pending), never the assessed "Unknown" verdict (#160).
// An unassessed node with a confident seed borrows that direction's tint.
function statusVars(
  status: AssessmentStatus | null,
  seedCredence?: number | null,
): React.CSSProperties {
  const s = status ?? seedTintKey(seedCredence);
  return {
    color: `var(--st-${s})`,
    background: `var(--st-${s}-tint)`,
    borderColor: `var(--st-${s})`,
  };
}

function edgePath(e: LEdge, ox: number, oy: number): string {
  const x1 = e.x1 - ox, y1 = e.y1 - oy, x2 = e.x2 - ox, y2 = e.y2 - oy;
  if (e.horiz) {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const dy = (y2 - y1) * 0.5;
  return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
}

const BED_CLS: Record<string, string> = {
  fact: styles.bedFact, open: styles.bedOpen, value: styles.bedValue,
};

function Glyph({
  status, size, seedCredence,
}: { status: AssessmentStatus | null; size?: string; seedCredence?: number | null }) {
  // nodeStatusMeta: an unassessed claim gets the hollow ◌, not Unknown's "?"
  // — "not yet judged" and "judged unknowable" are different facts (#160).
  // With a confident steward-seeded prior (#285) the hollow glyph borrows the
  // seed's tint: still ◌, still unassessed, but scannable.
  const meta = nodeStatusMeta(status);
  return (
    <span
      className={styles.glyph}
      style={{
        color: status ? `var(--st-${status})` : `var(--st-${seedTintKey(seedCredence)})`,
        fontSize: size,
      }}
      aria-hidden
    >
      {meta.glyph}
    </span>
  );
}

function BedStrip({ bed }: { bed: ClaimBits["bedrock"] }) {
  if (!bed) return null;
  return (
    <>
      <div className={`${styles.bed} ${BED_CLS[bed]}`} style={{ height: 5 }} />
      <div className={styles.bedTag}>{BEDROCK[bed].tag}</div>
    </>
  );
}

export function GraphView({
  initialDetail, source, embed = false,
}: {
  initialDetail: ClaimDetail;
  source: DataSource;
  /** Contained mode for the home page: no toolbar/trail, fixed-height stage,
      and no URL or global-keyboard side effects. */
  embed?: boolean;
}) {
  CACHE.set(initialDetail.claim.id, initialDetail);

  const router = useRouter();
  // The embedded live map links out on click; the offline sample keeps walking
  // in place, because fixture subclaims have no pages of their own to open.
  const linkOut = embed && source === "live";
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1200, h: 640 });
  const compact = box.w < 700;

  const [view, setView] = useState<View>({ detail: initialDetail, partial: false });
  const [trail, setTrail] = useState<{ id: string; text: string }[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(initialDetail, false));
  const [moreOpen, setMoreOpen] = useState<Set<string>>(new Set());
  const [depsOpen, setDepsOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [edgesShown, setEdgesShown] = useState(true);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // At narrow widths the preview renders as a fixed bottom sheet over the
  // stage's lower edge; its measured height lets the map centre in the band
  // that stays visible above it.
  const previewRef = useRef<HTMLElement>(null);
  const [sheetH, setSheetH] = useState(0);

  const focusId = view.detail.claim.id;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  // ---- stage measurement ----------------------------------------------------
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- sheet measurement ------------------------------------------------------
  // Touch has no hover, so on a phone every recentre also opens the preview
  // sheet — the focus must therefore centre in the space above it, or each tap
  // lands the clicked claim behind the sheet. Observed, not assumed: the sheet
  // is as tall as its content, up to the CSS cap.
  useEffect(() => {
    const el = previewRef.current;
    if (!compact || embed || !el) {
      setSheetH(0);
      return;
    }
    const ro = new ResizeObserver(() => setSheetH(el.offsetHeight));
    ro.observe(el);
    setSheetH(el.offsetHeight);
    return () => ro.disconnect();
  }, [preview, compact, embed]);

  // ---- recentring -------------------------------------------------------------
  const settle = useCallback((id: string, detail: ClaimDetail) => {
    if (focusRef.current !== id) return;
    setView({ detail, partial: false });
  }, []);

  const recenter = useCallback(
    (id: string, opts?: { push?: boolean; viaTrail?: boolean; text?: string }) => {
      if (id === focusRef.current) return;
      const current = view.detail;
      if (!opts?.viaTrail) {
        setTrail((t) => [...t.slice(-11), { id: current.claim.id, text: current.claim.text }]);
      }
      const cached = CACHE.get(id);
      if (cached) {
        setView({ detail: cached, partial: false });
        setExpanded(defaultExpanded(cached, compact));
      } else {
        // Optimistic: the clicked node's subtree (when it lives in the current
        // tree) renders immediately; the fetch fills in the rest.
        const node = findInTree(current.tree, id) ?? undefined;
        const bits: ClaimBits | undefined = node
          ? {
              id: node.id, text: node.text, claimType: node.claim_type,
              status: node.assessment_status, confidence: node.assessment_confidence,
              credence: node.assessment_credence ?? null,
              seedCredence: node.assessment_status == null ? node.seed_credence ?? null : null,
              relation: node.relation_type, reasoning: node.reasoning,
              argumentId: node.argument_id, argumentName: node.argument_name,
              argumentStance: node.argument_stance,
              childCount: node.children.length,
              bedrock: bedrockOf(
                node.claim_type,
                node.assessment_status,
                node.children.length === 0 && !node.subtree_collapsed && !node.children_truncated,
              ),
              up: false,
              collapsed: !!node.subtree_collapsed,
              truncated: !!node.children_truncated,
            }
          : (current.dependents ?? [])
              .filter((d) => d.id === id)
              .map((d): ClaimBits => ({
                id: d.id, text: d.text, claimType: d.claim_type,
                status: d.assessment_status, confidence: d.assessment_confidence,
                credence: d.assessment_credence ?? null,
                relation: d.relation_type, reasoning: null,
                argumentId: null, argumentName: null, argumentStance: null,
                childCount: 0, bedrock: null, up: true,
              }))[0];
        if (!bits) return;
        const partial = partialFrom(bits, node);
        // Seed the optimistic view with what we already know of the new
        // neighbourhood, so the old focus stays on the map as context while the
        // fetch completes — recentring never blanks the mental map.
        if (node) {
          partial.dependents = [{
            id: current.claim.id,
            text: current.claim.text,
            claim_type: current.claim.claim_type,
            relation_type: node.relation_type ?? "requires",
            assessment_status: current.assessment?.status ?? null,
            assessment_confidence: current.assessment?.confidence ?? null,
          }];
        } else if (bits.up && current.tree) {
          partial.tree = {
            id: bits.id, text: bits.text,
            claim_type: bits.claimType ?? "empirical_derived",
            state: "active", depth: 0,
            relation_type: null, reasoning: null, confidence: null,
            assessment_status: bits.status, assessment_confidence: bits.confidence,
            argument_id: null, argument_name: null, argument_stance: null,
            children: [{
              ...current.tree,
              relation_type: bits.relation ?? "requires",
              reasoning: null,
              argument_id: null, argument_name: null, argument_stance: null,
            }],
          };
        }
        setView({ detail: partial, partial: true });
        setExpanded(defaultExpanded(partial, compact));
        void fetchDetail(id).then((full) => {
          if (full) {
            settle(id, full);
            setExpanded((prev) => (focusRef.current === id ? defaultExpanded(full, compact) : prev));
          }
        });
      }
      setMoreOpen(new Set());
      setDepsOpen(false);
      setEdgesShown(false);
      window.setTimeout(() => setEdgesShown(true), 280);
      if (opts?.push !== false && !embed) {
        window.history.pushState({ minervalMap: id }, "", `/claims/${encodeURIComponent(id)}/map`);
      }
    },
    [view.detail, compact, settle, embed],
  );

  // Browser back/forward walks the same recentring path.
  useEffect(() => {
    if (embed) return;
    const onPop = () => {
      const m = /\/claims\/([^/]+)\/map/.exec(window.location.pathname);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      if (id === focusRef.current) return;
      setTrail((t) => (t.length && t[t.length - 1].id === id ? t.slice(0, -1) : t));
      recenter(id, { push: false, viaTrail: true });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [recenter, embed]);

  // Keyboard: ↓ into the decomposition, ↑ to a dependent, ⌫ back along the trail.
  // Skipped in embed mode: the home page owns the window's keys.
  useEffect(() => {
    if (embed) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
      if (ev.key === "Backspace") {
        ev.preventDefault();
        setTrail((t) => {
          if (!t.length) return t;
          const last = t[t.length - 1];
          recenter(last.id, { viaTrail: true });
          return t.slice(0, -1);
        });
      } else if (ev.key === "ArrowDown") {
        const kid = (view.detail.tree?.children ?? []).find((c) => !isAssumesRelation(c.relation_type));
        if (kid) recenter(kid.id);
      } else if (ev.key === "ArrowUp") {
        const dep = (view.detail.dependents ?? [])[0];
        if (dep) recenter(dep.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.detail, recenter, embed]);

  // ---- layout -----------------------------------------------------------------
  const plinthNote = useMemo(() => {
    const d = view.detail;
    if (view.partial) return "Loading decomposition…";
    // A childless root is only bedrock when the cap didn't drop its children.
    const rootTruncated = !!d.tree?.children_truncated;
    const bed = bedrockOf(d.claim.claim_type, d.assessment?.status ?? null, !rootTruncated);
    if (bed && (d.tree?.children.length ?? 0) === 0) return BEDROCK[bed].note;
    if (rootTruncated && (d.tree?.children.length ?? 0) === 0) {
      return "This view is size-capped; open the claim page to see the full decomposition.";
    }
    return decompositionNote({
      decompositionStatus: d.claim.decomposition_status,
      assessed: Boolean(d.assessment),
      stewardState: d.claim.steward_state,
    });
  }, [view]);

  const layout: Layout = useMemo(
    () =>
      computeLayout(view.detail, {
        expanded, moreOpen, depsOpen, compact, plinthNote,
        depsPending: view.partial,
      }),
    [view, expanded, moreOpen, depsOpen, compact, plinthNote],
  );

  // ---- fit: the world scales to the stage; scroll exists only at floor scale ---
  // The fit is symmetric around x=0 (the focus spine), not around the bounding
  // box's centre: the left gutter labels would otherwise push the focus card
  // visually right of centre. Costs a little scale when one side is heavy;
  // buys the reading that the centred claim IS the centre.
  const PAD = 48;
  const halfW = Math.max(-layout.bounds.minX, layout.bounds.maxX) + PAD;
  const contentW = halfW * 2;
  const contentH = layout.bounds.maxY - layout.bounds.minY + PAD * 2;
  // The stage's usable height: on a phone the open preview sheet covers the
  // stage's lower edge, so the world fits and centres in the band above it.
  // Clamped so a tall sheet can never squeeze the band away entirely; zero on
  // desktop and in embed, where the preview floats clear of the map.
  const sheetOverlap = compact && !embed ? Math.min(sheetH, box.h * 0.55) : 0;
  const availH = box.h - sheetOverlap;
  const fit = Math.min(1, box.w / contentW, availH / contentH);
  const SCALE_FLOOR = compact ? 0.7 : 0.55; // below this, text stops being text
  const scale = Math.max(fit, SCALE_FLOOR);
  const scrollable = fit < SCALE_FLOOR - 1e-6;
  const spacerW = Math.max(contentW * scale, box.w);
  const spacerH = Math.max(contentH * scale, box.h);
  const tx = spacerW / 2; // world x=0 lands dead centre
  const ty = Math.max(0, (availH - contentH * scale) / 2) + (PAD - layout.bounds.minY) * scale;

  // When the stage does scroll, land each recentre with the focus card in view
  // — in the band above the sheet, when one is open. Re-runs when the sheet
  // opens, closes or resizes, so the focus stays in the visible band.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !scrollable) return;
    el.scrollTo({
      left: layout.focus.x * scale + tx - box.w / 2,
      top: (layout.focus.y - 120) * scale + ty - availH / 2,
      behavior: "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, scrollable, sheetOverlap]);

  // Entering nodes fade in (exit/enter classes; moves are CSS-transitioned FLIPs).
  const prevKeys = useRef<Set<string>>(new Set());
  const currentKeys = new Set(layout.nodes.map((n) => n.key));
  useEffect(() => {
    const el = stageRef.current;
    if (el) {
      const fresh = el.querySelectorAll('[data-enter="1"]');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fresh.forEach((n) => n.removeAttribute("data-enter"));
      }));
    }
    prevKeys.current = currentKeys;
  });

  // ---- interactions -------------------------------------------------------------
  const showClaimPreview = useCallback((bits: ClaimBits, isFocus: boolean) => {
    setPreview({ kind: "claim", claim: bits, isFocus });
    setHoverId(bits.id);
  }, []);

  const onNodeClick = (n: LNode) => {
    if (n.kind === "pill") {
      // No dead clicks (#249): an argument is not a recentre target, so the
      // click pins the explanation the hover preview already carries, with a
      // nudge toward the claims — and, while that preview stays open, rings
      // the claims this argument rests on (see nudgeArgId below).
      setPreview({
        kind: "pill",
        nudge: true,
        pill: {
          argId: n.pill!.argId, name: n.pill!.name, stance: n.pill!.stance,
          desc: argDesc(n.pill!.argId),
        },
      });
      return;
    }
    if (n.kind === "more" && n.more) {
      if (n.more.action === "deps") setDepsOpen((v) => !v);
      else if (n.more.key) {
        setMoreOpen((prev) => {
          const next = new Set(prev);
          if (next.has(n.more!.key)) next.delete(n.more!.key);
          else next.add(n.more!.key);
          return next;
        });
      }
      return;
    }
    if (n.claim && n.claim.id !== focusId) {
      // Embedded (home) map: a click is a commitment, not a step. Open the
      // claim in the full-screen map rather than walking the graph inside the
      // small stage; browser back then returns to the untouched home (#254).
      if (linkOut) {
        router.push(`/claims/${encodeURIComponent(n.claim.id)}/map`);
        return;
      }
      // The preview follows the recentre: same claim, now the centred one, and
      // its edge note explains the step just taken.
      setPreview({ kind: "claim", claim: n.claim, isFocus: true });
      recenter(n.claim.id);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---- render helpers -------------------------------------------------------------
  const d = view.detail;
  const focusStatus = d.assessment?.status ?? null;
  const focusMeta = statusMeta(focusStatus);
  const argDesc = (argId: string | null): string | null =>
    (d.arguments ?? []).find((a) => a.id === argId)?.content ?? null;
  // Canonical text for every claim in the focus tree, so a written form's
  // [[claim:<id>]] references render as the claims they name.
  const treeTexts = buildClaimTextMap(d.tree);
  // While a clicked pill's preview is pinned, ring the claims that argument
  // rests on — the destinations the pill itself is not (#249). Derived, not
  // stored: the highlight lives exactly as long as the pinned preview.
  const nudgeArgId = preview?.kind === "pill" && preview.nudge ? preview.pill?.argId : null;

  const nodeBody = (n: LNode) => {
    switch (n.kind) {
      case "focus":
        return (
          <>
            <div className={styles.eyebrow}>
              <Term
                gloss={claimTypeMeta(d.claim.claim_type)?.gloss ?? MAP_KEY.claim}
                href={claimTypeMeta(d.claim.claim_type) ? DEFINED_IN.claimType : DEFINED_IN.claim}
                align="start"
                className="sc"
              >
                claim{d.claim.claim_type ? ` · ${CLAIM_TYPE_LABEL[d.claim.claim_type as ClaimType]}` : ""}
              </Term>
              <Link className={styles.pageLink} href={`/claims/${d.claim.id}`} title="Open the claim page: provenance, discourse, assessment">
                claim page ↗&#xFE0E;
              </Link>
            </div>
            <div className={styles.heroText}>{d.claim.text}</div>
            <div className={styles.focusBand}>
              {d.assessment ? (
                <Term gloss={focusMeta.def} href={DEFINED_IN.status} align="start" className={`badge ${focusMeta.cls}`}>
                  <span className="badge-glyph">{focusMeta.glyph}</span>
                  {focusMeta.label}
                </Term>
              ) : (
                <Term gloss={UNASSESSED_META.def} href={DEFINED_IN.importance} align="start" className="badge unassessed">
                  unassessed
                </Term>
              )}
              {/* Credence beside the badge, as on the claim page and the hover
                  preview (#238): the reader's number, P(claim true), labelled
                  with its word. Importance pips used to sit here and read as
                  exactly this — an unlabelled meter next to a verdict. The
                  importance band now lives on the claim page, worded. Verdict
                  confidence stays meta and stays in the hover preview,
                  labelled, never a bare number beside the badge (#160). */}
              {d.assessment?.claim_credence != null && (
                <Term gloss={CREDENCE_GLOSS} href={DEFINED_IN.confidence} align="start" className={styles.confNum}>
                  credence {d.assessment.claim_credence.toFixed(2)}
                </Term>
              )}
              {/* Steward-seeded prior (#285): an unassessed focus with a seed
                  shows the preliminary figure beside the dashed badge, worded
                  as what it is — never the assessed "credence". */}
              {!d.assessment && d.seed?.credence != null && (
                <Term gloss={SEED_PRELIM_GLOSS} href={DEFINED_IN.confidence} align="start" className={styles.confNum}>
                  preliminary credence {d.seed.credence.toFixed(2)}
                </Term>
              )}
            </div>
          </>
        );
      case "t1": {
        const c = n.claim!;
        return (
          <>
            <div className={styles.chipHead}>
              <Glyph status={c.status} seedCredence={c.seedCredence} />
            </div>
            <div className={styles.t1Text}>{c.text}</div>
            <div className={styles.chipFoot}>
              {/* Zero children here is only "atomic" when nothing was elided:
                  a shared subclaim's repeat occurrence and a cap-truncated
                  node both arrive childless without being leaves (#160). */}
              {c.childCount > 0 ? (
                <button
                  type="button"
                  className={styles.expander}
                  onClick={(ev) => { ev.stopPropagation(); toggleExpand(c.id); }}
                  aria-expanded={n.expandedNow}
                >
                  {n.expandedNow ? "▾" : "▸"} {c.childCount}{c.truncated ? "+" : ""} subclaim{c.childCount > 1 || c.truncated ? "s" : ""}
                </button>
              ) : c.collapsed ? (
                // The tag's meaning lives in the margin preview, which hovering
                // this node already opens — one tooltip surface, not two (#253).
                <span className={styles.atomicTag}>shared · shown elsewhere</span>
              ) : c.truncated ? (
                <span className={styles.atomicTag}>more on its map</span>
              ) : c.bedrock ? null : (
                <span className={styles.atomicTag}>atomic</span>
              )}
            </div>
            {/* bedrock replaces the atomic tag — the hatch already says atomic */}
            <BedStrip bed={c.bedrock} />
          </>
        );
      }
      case "t2": {
        const c = n.claim!;
        return (
          <>
            <div className={styles.chipHead}><Glyph status={c.status} size="0.56rem" seedCredence={c.seedCredence} /></div>
            <div className={styles.t2Text}>{c.text}</div>
            <BedStrip bed={c.bedrock} />
          </>
        );
      }
      case "mini":
        return nodeStatusMeta(n.claim!.status).glyph;
      case "side": {
        const c = n.claim!;
        return (
          <>
            <div className={styles.chipHead}>
              <Glyph status={c.status} size="0.56rem" seedCredence={c.seedCredence} />
              <span className={styles.atomicTag}>assumed</span>
            </div>
            <div className={styles.sideText}>{c.text}</div>
            <BedStrip bed={c.bedrock} />
          </>
        );
      }
      case "dep":
      case "depstub": {
        const c = n.claim!;
        return (
          <>
            <div className={styles.chipHead}>
              <Glyph status={c.status} size="0.58rem" />
            </div>
            <div className={styles.depText}>{c.text}</div>
          </>
        );
      }
      case "pill":
        return (
          <>
            <span>{n.pill!.name}</span>
            <span className={styles.pillStance}>· {n.pill!.stance}</span>
          </>
        );
      case "more":
        return n.more!.label;
    }
  };

  const kindClass: Record<LNode["kind"], string> = {
    focus: styles.focus, t1: styles.t1, t2: styles.t2, mini: styles.mini,
    dep: styles.dep, depstub: styles.depstub, pill: styles.pill,
    more: styles.more, side: styles.side,
  };

  const ox = layout.bounds.minX;
  const oy = layout.bounds.minY;

  return (
    <div className={embed ? undefined : styles.bleed}>
      {/* toolbar: the map is one view of the claim's address (not in embed) */}
      {!embed && (
        <div className={styles.toolbar}>
          <span className="sc"><Link href={`/claims/${focusId}`}>← claim page</Link></span>
          <span className="sc" style={{ color: "var(--ink-soft)" }}>map view</span>
          {source === "fixture" && (
            <Term gloss="The API is not connected, so this map shows a built-in design fixture rather than live claims." className="tag">
              fixture data
            </Term>
          )}
          <span className={`sc ${styles.hint}`} style={{ color: "var(--faint)" }}>
            click a claim to focus on it · hover to preview · ⌫ back
          </span>
        </div>
      )}

      {/* trail of the walk so far (not in embed) */}
      {!embed && (
        <div className={styles.trail} aria-label="Trail">
          <span className="sc" style={{ fontSize: "0.56rem" }}>trail</span>
          {trail.slice(-4).map((t, i, arr) => (
            <span key={`${t.id}:${i}`} style={{ display: "inline-flex", gap: "0.45rem", alignItems: "center" }}>
              <button
                type="button"
                className={styles.trailLink}
                onClick={() => {
                  const cut = trail.length - arr.length + i;
                  setTrail(trail.slice(0, cut));
                  recenter(t.id, { viaTrail: true });
                }}
              >
                {t.text}
              </button>
              <span className={styles.trailSep}>›</span>
            </span>
          ))}
          <span className={styles.trailHere}>{d.claim.text}</span>
        </div>
      )}

      {/* the stage */}
      <div
        ref={stageRef}
        className={`${styles.stage}${embed ? ` ${styles.embedStage}` : ""}${scrollable ? ` ${styles.scrollable}` : ""}`}
        role="figure"
        aria-label={`Claim map focused on: ${d.claim.text}`}
      >
        <div style={{ width: spacerW, height: spacerH, position: "relative" }}>
          <div
            className={styles.plane}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          >
            <svg
              className={styles.edges}
              style={{
                left: ox, top: oy, position: "absolute",
                width: layout.bounds.maxX - ox, height: layout.bounds.maxY - oy,
                opacity: edgesShown ? 1 : 0,
              }}
              viewBox={`0 0 ${layout.bounds.maxX - ox} ${layout.bounds.maxY - oy}`}
              aria-hidden
            >
              {layout.edges.map((e, i) => (
                <path
                  key={i}
                  d={edgePath(e, ox, oy)}
                  data-rel={e.rel}
                  className={[
                    e.mini ? styles.miniEdge : "",
                    hoverId && e.ids.includes(hoverId) ? styles.hl : "",
                  ].join(" ").trim() || undefined}
                />
              ))}
            </svg>

            {layout.nodes.map((n) => {
              const fresh = !prevKeys.current.has(n.key);
              const isMini = n.kind === "mini";
              const interactive = (n.claim && n.claim.id !== focusId) || n.kind === "pill";
              return (
                <div
                  key={n.key}
                  className={[
                    styles.gnode,
                    kindClass[n.kind],
                    n.kind === "pill"
                      ? n.pill!.stance === "for" ? styles.pillFor
                        : n.pill!.stance === "against" ? styles.pillAgainst : styles.pillNeutral
                      : "",
                    (n.kind === "t1" || n.kind === "side")
                      && nudgeArgId != null && n.claim?.argumentId === nudgeArgId
                      ? styles.nudged : "",
                  ].join(" ").trim()}
                  data-enter={fresh ? "1" : undefined}
                  style={{
                    left: n.x - n.w / 2,
                    top: n.y,
                    width: n.w,
                    height: n.h,
                    ...(isMini ? statusVars(n.claim!.status, n.claim!.seedCredence) : null),
                  }}
                  role={interactive ? "button" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={n.claim ? n.claim.text : n.pill ? `argument · ${n.pill.name} · ${n.pill.stance}` : undefined}
                  onClick={() => onNodeClick(n)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onNodeClick(n); }
                  }}
                  onMouseEnter={() => {
                    if (n.claim) showClaimPreview(n.claim, n.kind === "focus");
                    else if (n.kind === "pill") {
                      // Re-hovering the pinned pill keeps the pin; hovering it
                      // fresh shows the plain preview, no nudge.
                      setPreview((prev) => (
                        prev?.kind === "pill" && prev.nudge && prev.pill?.argId === n.pill!.argId
                          ? prev
                          : {
                              kind: "pill",
                              pill: { argId: n.pill!.argId, name: n.pill!.name, stance: n.pill!.stance, desc: argDesc(n.pill!.argId) },
                            }
                      ));
                    }
                  }}
                  onMouseLeave={() => setHoverId(null)}
                >
                  {n.kind === "focus" ? nodeBody(n) : nodeBody(n)}
                </div>
              );
            })}

            {layout.labels.map((lb, i) => (
              <span
                key={`${lb.text}:${i}`}
                className={`relation ${RELATION[lb.rel as RelationType]?.cls ?? "rel-requires"} ${styles.elabel}`}
                style={{ left: lb.x, top: lb.y, opacity: edgesShown ? 1 : 0 }}
              >
                {lb.text}
              </span>
            ))}

            {layout.misc.map((m, i) => {
              if (m.kind === "band") {
                return (
                  <div key={`band:${m.text}`} className={styles.band} style={{ left: m.x, top: m.y }}>
                    {m.text}
                  </div>
                );
              }
              if (m.kind === "deplabel") {
                // Keyed by cls suffix so a null status counts as "unassessed"
                // (pending), never as the assessed "Unknown" verdict (#160).
                const counts = new Map<string, number>();
                for (const st of m.dist) {
                  const k = st ?? "unassessed";
                  counts.set(k, (counts.get(k) ?? 0) + 1);
                }
                return (
                  <div key="deplabel" className={styles.depLabel} style={{ left: m.x - 130, top: m.y }}>
                    {m.pending ? (
                      <span className={styles.depNone}>…</span>
                    ) : m.n === 0 ? (
                      <span className={styles.depNone}>Nothing in the graph builds on this claim yet.</span>
                    ) : (
                      <>
                        <span className={styles.depCount}>{m.n}</span>
                        <span className={styles.depUnit}>depended on by</span>
                        <span className={styles.distBar}>
                          {[...counts.entries()].map(([k, nn]) => (
                            <i
                              key={k}
                              className={`st-${k}`}
                              style={{ width: `${(nn / m.dist.length) * 100}%` }}
                            />
                          ))}
                        </span>
                      </>
                    )}
                  </div>
                );
              }
              // plinth
              return (
                <div key="plinth" className={styles.plinth} style={{ left: m.x - m.w / 2, top: m.y, width: m.w }}>
                  <div className={`${styles.bed} ${styles.bedLg} ${m.bedrock ? BED_CLS[m.bedrock] : styles.bedNone}`} />
                  <div className={styles.plinthNote}>{m.note}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* the margin-note preview: selectable, linked, persistent — and itself
            a recentre target: clicking the note walks to the claim it describes
            (links, buttons, and in-progress text selections excepted) */}
        {preview && (
          <aside
            ref={previewRef}
            className={`${styles.preview}${
              preview.kind === "claim" && preview.claim && !preview.isFocus ? ` ${styles.previewClickable}` : ""
            }`}
            aria-live="polite"
            onClick={(ev) => {
              if (preview.kind !== "claim" || !preview.claim || preview.isFocus) return;
              if ((ev.target as HTMLElement).closest("a, button")) return;
              const sel = window.getSelection();
              if (sel && !sel.isCollapsed) return;
              setPreview({ ...preview, isFocus: true });
              recenter(preview.claim.id);
            }}
          >
            {preview.kind === "pill" && preview.pill ? (
              <>
                <div className={styles.previewHead}>
                  <span className="sc">argument · {preview.pill.stance}</span>
                  <button type="button" className={styles.previewClose} onClick={() => setPreview(null)} aria-label="Close preview">✕</button>
                </div>
                <p className={styles.previewText} style={{ fontWeight: 600 }}>{preview.pill.name}</p>
                {preview.pill.desc && (
                  <div className={styles.previewNote}>
                    <ArgumentText content={preview.pill.desc} texts={treeTexts} />
                  </div>
                )}
                {preview.nudge && (
                  <div className={styles.previewNudge}>
                    An argument is not a destination on this map; the claims it
                    rests on are. Click one of the claims highlighted beneath it
                    to keep exploring.
                  </div>
                )}
                <div className={styles.previewFoot}>
                  <span>an argument states how its subclaims combine to bear on the claim</span>
                </div>
              </>
            ) : preview.claim ? (
              (() => {
                const c = preview.claim!;
                const meta = nodeStatusMeta(c.status);
                const rel = c.relation ? RELATION[c.relation] : null;
                return (
                  <>
                    <div className={styles.previewHead}>
                      <span className="sc">
                        claim{c.claimType ? ` · ${CLAIM_TYPE_LABEL[c.claimType]}` : ""}
                      </span>
                      <button type="button" className={styles.previewClose} onClick={() => setPreview(null)} aria-label="Close preview">✕</button>
                    </div>
                    <p className={styles.previewText}>{c.text}</p>
                    <div className={styles.previewRow}>
                      {/* the dashed unassessed badge, not a status-coloured one:
                          no verdict exists for this claim yet (#160) */}
                      <span className={`badge ${c.status ? meta.cls : "unassessed"}`} title={meta.def}>
                        {c.status && <span className="badge-glyph">{meta.glyph}</span>}
                        {meta.label}
                      </span>
                      {/* Credence beside the badge (#238): the reader's number,
                          P(claim true), mirroring the claim page's hierarchy.
                          Labelled and meterless (#160); rendered only when the
                          Steward stated one — per constitution §10 the omission
                          is itself information, so no placeholder. */}
                      {c.credence != null && (
                        <span className={styles.confNum} title={CREDENCE_GLOSS}>
                          credence {c.credence.toFixed(2)}
                        </span>
                      )}
                      {/* Steward-seeded prior (#285), labelled preliminary so
                          it can never read as an assessed credence. Shown for
                          any seeded figure — the tint needs confidence, but
                          the number itself is honest at any value. */}
                      {c.status == null && c.seedCredence != null && (
                        <span className={styles.confNum} title={SEED_PRELIM_GLOSS}>
                          preliminary credence {c.seedCredence.toFixed(2)}
                        </span>
                      )}
                    </div>
                    {/* Verdict confidence is meta ("is the badge right?"), so
                        it steps back to a quiet line of its own (#238). */}
                    {c.confidence != null && (
                      <div className={styles.previewQuiet} title={VERDICT_CONFIDENCE_GLOSS}>
                        verdict confidence {c.confidence.toFixed(2)}
                      </div>
                    )}
                    {rel && (
                      <div className={styles.previewNote}>
                        <span className={`relation ${rel.cls} ${styles.relLine}`}>
                          {c.up ? `${rel.label} this claim` : rel.label}
                          {c.argumentName ? ` · ${c.argumentName}` : ""}
                        </span>
                        {c.reasoning || rel.gloss}
                      </div>
                    )}
                    {/* What the node's drawing means (#253): shared, size-capped
                        and atomic states explained here, in the map's one
                        tooltip surface, instead of clipped native titles. */}
                    {c.collapsed && (
                      <div className={styles.previewNote}>
                        A shared subclaim: it also appears elsewhere on this map,
                        where its decomposition is drawn. Focus on it to see it in full.
                      </div>
                    )}
                    {c.truncated && (
                      <div className={styles.previewNote}>
                        This view is size-capped, so this claim&apos;s subclaims are
                        not drawn here. Focus on it to see them.
                      </div>
                    )}
                    {!preview.isFocus && !c.up && !c.collapsed && !c.truncated
                      && !c.bedrock && c.childCount === 0 && (
                      <div className={styles.previewNote}>
                        Atomic: no decomposition is recorded beneath this claim.
                      </div>
                    )}
                    {c.bedrock && (
                      <div className={styles.previewNote} style={{ borderLeftColor: `var(--st-${c.status ?? "unknown"})` }}>
                        {BEDROCK[c.bedrock].note}
                      </div>
                    )}
                    <div className={styles.previewFoot}>
                      <span>
                        {preview.isFocus
                          ? "the claim in focus"
                          : linkOut
                            ? "click to open this claim in the full map"
                            : "click to focus the map on this claim"}
                      </span>
                      <Link href={`/claims/${c.id}`}>open claim page ↗&#xFE0E;</Link>
                    </div>
                  </>
                );
              })()
            ) : null}
          </aside>
        )}
      </div>

      {/* legend — a figure caption, not app chrome */}
      <div className={styles.legend} data-tour="legend">
        {/* the map's grammar first (#253): what the shapes are, before what
            their colours and edges say */}
        <span className={styles.legendGroup}>
          <Term gloss={MAP_KEY.claim} href={DEFINED_IN.claim} align="start" className={styles.legendItem}>
            <span className={styles.legendClaim} aria-hidden />claim
          </Term>
          <Term gloss={MAP_KEY.argument} href={DEFINED_IN.argument} align="start" className={styles.legendItem}>
            <span className={styles.legendPill} aria-hidden />argument
          </Term>
        </span>
        <span className={styles.legendRule} />

        <span className={styles.legendGroup}>
          {STATUS_ORDER.map((s) => (
            <Term key={s} gloss={STATUS[s].def} href={DEFINED_IN.status} className={styles.legendItem}>
              <span className={`${styles.legendGlyph} ${STATUS[s].cls}`}>{STATUS[s].glyph}</span>
              {STATUS[s].label.toLowerCase()}
            </Term>
          ))}
          <Term gloss={UNASSESSED_META.def} href={DEFINED_IN.importance} className={styles.legendItem}>
            <span className={`${styles.legendGlyph} ${UNASSESSED_META.cls}`}>{UNASSESSED_META.glyph}</span>
            unassessed
          </Term>
        </span>
        <span className={styles.legendRule} />
        <span className={styles.legendGroup}>
          <span className={styles.legendItem}><span className={`${styles.legendBed} ${styles.bedFact}`} />verified fact</span>
          <span className={styles.legendItem}><span className={`${styles.legendBed} ${styles.bedOpen}`} />open question</span>
          <span className={styles.legendItem}><span className={`${styles.legendBed} ${styles.bedValue}`} />value premise</span>
        </span>
        <span className={styles.legendRule} />
        <span className={styles.legendGroup}>
          <Term gloss={RELATION.supports.gloss} href={DEFINED_IN.relation} source={STEWARD_SOURCE} className={styles.legendItem}>
            <span className={styles.legendEdge} style={{ borderColor: "rgba(79,125,74,.7)" }} /><span className="rel-supports">supports</span>
          </Term>
          <Term gloss={RELATION.contradicts.gloss} href={DEFINED_IN.relation} source={STEWARD_SOURCE} className={styles.legendItem}>
            <span className={`${styles.legendEdge} ${styles.dashed}`} style={{ borderColor: "rgba(143,58,44,.7)" }} /><span className="rel-contradicts">contradicts</span>
          </Term>
          <Term gloss={RELATION.assumes.gloss} href={DEFINED_IN.relation} source={STEWARD_SOURCE} className={styles.legendItem}>
            <span className={`${styles.legendEdge} ${styles.dotted}`} style={{ borderColor: "rgba(154,109,18,.8)" }} /><span className="rel-assumes">assumes</span>
          </Term>
          <Term gloss={RELATION.requires.gloss} href={DEFINED_IN.relation} source={STEWARD_SOURCE} className={styles.legendItem}>
            <span className={styles.legendEdge} style={{ borderColor: "var(--rule)" }} />requires
          </Term>
        </span>
        <span className={styles.legendCaption}>
          {linkOut
            ? "Hover a claim to preview it; click one to open the full-screen map."
            : embed
              ? "Hover a claim to preview it; click one to focus the map on it."
              : "Fig. Detail falls off with distance; every claim is an address."}
        </span>
      </div>
    </div>
  );
}
