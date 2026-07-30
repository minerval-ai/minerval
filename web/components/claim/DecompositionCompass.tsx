"use client";

import { useEffect, useState } from "react";
import type { TreeNode } from "@/lib/types";
import {
  decompositionEffects, effectCounts, topLevelEffects, groupByArgument,
  unassessedTintOf, EFFECT, EFFECT_ORDER,
  UNASSESSED_TINT, UNASSESSED_TINT_ORDER, type UnassessedTint,
  DEFINED_IN, BASIS,
} from "@/lib/ontology";
import { Term } from "@/components/Term";
import styles from "./margins.module.css";

// Scrollspy at argument granularity (issues #202, #204). The centre column tags
// each top-level argument block with data-arg-anchor; we watch which one spans a
// reading line near the top of the viewport, so the jump-list can mark where the
// reader is. Argument blocks are siblings, so the last one in document order
// under the line is the one being read. Null until the reader reaches the tree.
function useActiveArg(): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const tree = document.querySelector(".tree");
    if (!tree) return;
    const intersecting = new Set<Element>();
    const pick = () => {
      let best: Element | null = null;
      for (const el of intersecting) {
        if (!best || best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
      }
      if (best) setActive(best.getAttribute("data-arg-anchor"));
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) intersecting.add(e.target);
          else intersecting.delete(e.target);
        }
        pick();
      },
      // a zero-height reading line 28% down the viewport
      { rootMargin: "-28% 0px -72% 0px" },
    );
    const observe = () => {
      io.disconnect();
      intersecting.clear();
      tree.querySelectorAll("[data-arg-anchor]").forEach((el) => io.observe(el));
    };
    observe();
    // opening an edge's "why" reveal changes block heights; re-observe is cheap
    const mo = new MutationObserver(observe);
    mo.observe(tree, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
  return active;
}

// Smooth-scroll the reading column to an argument block, clearing the sticky
// site header so its heading isn't tucked underneath.
function scrollToArg(key: string) {
  const el = document.querySelector(`[data-arg-anchor="${CSS.escape(key)}"]`);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - 80;
  window.scrollTo({ top: y, behavior: "smooth" });
}

// The decomposition "compass" in the left margin: an ambient status distribution
// (by effect on the claim, not raw subclaim status) over the ambient bar, then a
// prose-free jump-list of the claim's top-level lines of reasoning. The reading
// happens in the centre column (#204); the rail only summarises and navigates.
export function DecompositionCompass({ tree }: { tree: TreeNode }) {
  // Direct subclaims only (#189): the same population the centre column
  // renders, so the bar, the count, and the reading below it never disagree.
  // Flattening the whole descendant tree put deep grandchildren on equal
  // footing with this claim's own lines of reasoning — and a sub-premise of an
  // opposing argument would render as a peer of the claim's direct arguments.
  // The recursive subtree contributes only the quiet total under the count.
  const scored = topLevelEffects(tree);
  const counts = effectCounts(scored);
  const total = scored.length;
  const deepTotal = decompositionEffects(tree).length;
  // Assessed effects render solid; the unassessed remainder renders hatched,
  // split by direction, so a claim whose in-favour side is still queued never
  // reads as all-against (#189). Where the parent Steward seeded a confident
  // prior credence (#285), the seed's direction refines the structural edge
  // lean — a stronger tint, still hatched, still labelled unassessed.
  const present = EFFECT_ORDER.filter((e) => e !== "unassessed" && counts[e] > 0);
  const tintCounts: Record<UnassessedTint, number> = {
    "seed-for": 0, "lean-for": 0, "seed-against": 0, "lean-against": 0,
  };
  for (const s of scored) {
    const t = unassessedTintOf(s);
    if (t) tintCounts[t] += 1;
  }
  const tintsPresent = UNASSESSED_TINT_ORDER.filter((t) => tintCounts[t] > 0);
  // The same top-level groups the centre renders, keyed on the same argKey so
  // a click scrolls to the right block.
  const groups = groupByArgument(scored);
  const namedCount = groups.filter((g) => g.named).length;
  const activeArg = useActiveArg();

  // Atomic claim: nothing to summarise. Show a quiet resting note, no bar.
  if (total === 0) {
    return (
      <aside className={styles.rail} aria-label="Decomposition">
        <div className={styles.railHead} style={{ cursor: "default" }}>
          <span className="sc">Decomposition</span>
          <span className={styles.railCount}>
            0<span className={styles.railCountUnit}>subclaims</span>
          </span>
        </div>
        <p className={styles.emptyNote}>
          Atomic — this claim bottoms out in a bedrock fact, a contested question,
          or a value premise, and does not decompose further.
        </p>
      </aside>
    );
  }

  return (
    <aside className={styles.rail} aria-label="Decomposition compass">
      <div className={styles.railHead} style={{ cursor: "default" }}>
        <span className="sc">Decomposition</span>
        <span className={styles.railCount}>
          {total}
          <span className={styles.railCountUnit}>direct subclaim{total === 1 ? "" : "s"}</span>
        </span>
        {/* the two counts a reader might meet must be labelled, not left to
            fight: the compass reads this claim's own subclaims, the map holds
            the rest (#189) */}
        {deepTotal > total && (
          <span className={styles.railTotal}>{deepTotal} in the full decomposition</span>
        )}
      </div>

      {/* the compass: how the direct subclaims bear on THIS claim */}
      <div className={styles.distBar} title="how the direct subclaims bear on this claim" aria-hidden>
        {present.map((e) => (
          <span key={e} className={EFFECT[e].cls} style={{ width: `${(counts[e] / total) * 100}%` }} />
        ))}
        {tintsPresent.map((t) => (
          <span
            key={`unassessed-${t}`}
            className={`${styles.unassessedSeg}${UNASSESSED_TINT[t].seeded ? ` ${styles.seededSeg}` : ""} ${UNASSESSED_TINT[t].cls}`}
            style={{ width: `${(tintCounts[t] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className={styles.legend}>
        {present.map((e) => (
          <li key={e} className={EFFECT[e].cls}>
            <span className={`swatch ${EFFECT[e].cls}`} aria-hidden />
            <span className={styles.legendN}>{counts[e]}</span>
            <Term gloss={EFFECT[e].gloss} href={DEFINED_IN.effect} className={styles.legendLbl} align="start">
              {EFFECT[e].label}
            </Term>
          </li>
        ))}
        {tintsPresent.map((t) => (
          <li key={`unassessed-${t}`} className={UNASSESSED_TINT[t].cls}>
            <span
              className={`swatch ${styles.unassessedSwatch}${UNASSESSED_TINT[t].seeded ? ` ${styles.seededSwatch}` : ""} ${UNASSESSED_TINT[t].cls}`}
              aria-hidden
            />
            <span className={styles.legendN}>{tintCounts[t]}</span>
            <Term gloss={UNASSESSED_TINT[t].gloss} href={DEFINED_IN.effect} className={styles.legendLbl} align="start">
              {UNASSESSED_TINT[t].label}
            </Term>
          </li>
        ))}
      </ul>
      <p className={styles.compassNote}>by effect on this claim, not by subclaim status</p>

      {/* jump-list: the top-level lines of reasoning. Clicking scrolls the centre
          column to that block; the active one tracks the reading position. No
          prose in the rail — reading a written form in a narrow margin is unkind,
          and the centre already carries it at full width (#204). */}
      <p className={styles.jumpLabel}>
        {namedCount > 0 ? `${namedCount} argument${namedCount === 1 ? "" : "s"}` : "the basis"}
      </p>
      <ul className={styles.jumpList}>
        {groups.map((g) => {
          const key = g.id ?? "basis";
          const active = key === activeArg;
          return (
            <li key={key}>
              <button
                type="button"
                className={`${styles.jumpItem}${active ? ` ${styles.jumpItemActive}` : ""}`}
                onClick={() => scrollToArg(key)}
                title={g.named ? undefined : BASIS.gloss}
              >
                <span className={`swatch ${EFFECT[g.net].cls}`} aria-hidden />
                <span className={styles.jumpName}>{g.name ?? BASIS.label}</span>
                <span className={styles.jumpCount}>{g.nodes.length}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
