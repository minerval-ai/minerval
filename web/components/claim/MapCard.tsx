import Link from "next/link";
import type { TreeNode } from "@/lib/types";
import styles from "./margins.module.css";

// The map affordance (#192). "▸ VIEW AS MAP" was easy to miss and clashed in
// case with the outline beside it; the invitation is now a figure: a sketch of
// this claim's own first-level decomposition, drawn from the real tree, that
// opens the map view. Statuses colour the subclaim dots the same way the map
// colours its glyphs; an unassessed subclaim stays a hollow dashed dot, and a
// subclaim with a live prize wears the map's double ring.
const W = 208;
const H = 88;

export function MapCard({ claimId, tree }: { claimId: string; tree?: TreeNode }) {
  const children = (tree?.children ?? []).slice(0, 7);
  const n = children.length;

  const focusW = 84, focusH = 24;
  const focusX = (W - focusW) / 2, focusY = 8;
  const rowY = 66, dotR = 4.5;
  const edgeTopY = focusY + focusH;
  const xs = children.map((_, i) =>
    n === 1 ? W / 2 : 26 + (i * (W - 52)) / Math.max(1, n - 1),
  );

  return (
    <Link
      href={`/claims/${claimId}/map`}
      className={styles.mapCard}
      aria-label="View this claim as a map"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.mapCardFig} aria-hidden>
        {xs.map((x, i) => (
          <path
            key={i}
            d={`M${W / 2},${edgeTopY} C${W / 2},${(edgeTopY + rowY) / 2} ${x},${(edgeTopY + rowY) / 2} ${x},${rowY - dotR - 2}`}
            fill="none"
            stroke="var(--rule)"
            strokeWidth="1"
          />
        ))}
        <rect
          x={focusX} y={focusY} width={focusW} height={focusH} rx="2.5"
          fill="var(--paper-card)" stroke="var(--ink-soft)" strokeWidth="1"
        />
        {/* text-line hints inside the focus card */}
        <line x1={focusX + 9} y1={focusY + 9.5} x2={focusX + focusW - 9} y2={focusY + 9.5} stroke="var(--rule)" strokeWidth="1.6" />
        <line x1={focusX + 9} y1={focusY + 15.5} x2={focusX + focusW - 26} y2={focusY + 15.5} stroke="var(--rule)" strokeWidth="1.6" />
        {children.map((c) => c.bounty_micro_usd != null ? (
          <circle
            key={`ring-${c.id}`} cx={xs[children.indexOf(c)]} cy={rowY} r={dotR + 3}
            fill="none" stroke="var(--ink-soft)" strokeWidth="1"
          />
        ) : null)}
        {children.map((c, i) =>
          c.assessment_status ? (
            <circle
              key={c.id} cx={xs[i]} cy={rowY} r={dotR}
              fill={`var(--st-${c.assessment_status})`} opacity="0.85"
            />
          ) : (
            <circle
              key={c.id} cx={xs[i]} cy={rowY} r={dotR}
              fill="none" stroke="var(--st-unassessed)" strokeDasharray="2 1.6"
            />
          ),
        )}
      </svg>
      <span className={styles.mapCardLabel}>
        View as map <span aria-hidden>→</span>
      </span>
    </Link>
  );
}
