"use client";

import { useId } from "react";
import type { GraphLayout, InterimGraph, ReplayArm } from "@/lib/replay-core";
import { nodeStatusMeta } from "@/lib/ontology";
import s from "./replay.module.css";

// One arm's graph as it stood after the current event, drawn as inline SVG
// in world coordinates from a layout computed once on the FINAL graph: nodes
// appear in place, so the picture never jumps. Chips follow the claim map's
// tier chips: paper card, hairline border, fill/border by status token, the
// unassessed hatched; a merged claim greys out; the claims the current event
// touched pulse; matched claims light up across arms on hover.

export interface GraphCanvasProps {
  arm: ReplayArm;
  layout: GraphLayout;
  graph: InterimGraph;
  /** Claims the current event touched. */
  pulse: Set<string>;
  /** Claims to highlight (hovered claim and its pair in the other arm). */
  highlight: Set<string>;
  /** Claims the agreement metric could not pair. */
  unmatched: Set<string>;
  /** The adversarial target, pinned. */
  target?: string | null;
  selected?: string | null;
  onHover: (claimId: string | null) => void;
  onSelect: (claimId: string) => void;
}

const REL_STROKE: Record<string, string> = {
  supports: "var(--st-supported)",
  contradicts: "var(--st-contradicted)",
  assumes: "var(--st-contested)",
  presupposes: "var(--st-contested)",
  defines: "var(--link)",
  requires: "var(--faint)",
  specifies: "var(--faint)",
};

export function GraphCanvas(p: GraphCanvasProps) {
  const { arm, layout, graph } = p;
  const uid = useId().replace(/:/g, "");
  const hatch = `hatch-${uid}`;
  const sourceTitle = new Map(arm.sources.map((src) => [src.id, src.title ?? src.id]));
  const landed = new Set(graph.sources.map((src) => src.id));
  const W = Math.max(layout.width, 1);
  const H = Math.max(layout.height, 1);

  return (
    <svg
      className={s.canvas}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ aspectRatio: `${W} / ${H}`, maxHeight: "34rem" }}
      role="img"
      aria-label={`${arm.label}: ${graph.claims.length} of ${layout.nodes.length} claims so far`}
    >
      <defs>
        <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--st-unassessed)" strokeWidth="0.8" opacity="0.45" />
        </pattern>
      </defs>

      {/* source groups along the top row */}
      {arm.sources.length > 0 && layout.groups.map((g) => (
        <g key={g.key || "none"} className={landed.has(g.key) ? s.groupOn : s.groupOff}>
          <line x1={g.x} y1={22} x2={g.x + g.w} y2={22} className={s.groupRule} />
          <text x={g.x} y={16} className={s.groupLabel}>
            {g.key ? sourceTitle.get(g.key) ?? g.key : "no source"}
          </text>
        </g>
      ))}

      {/* edges, as they appear */}
      <g className={s.edges}>
        {graph.edges.map((e) => {
          const a = layout.byId[e.parentId];
          const b = layout.byId[e.childId];
          if (!a || !b) return null;
          const x1 = a.x + a.w / 2, y1 = a.y + a.h;
          const x2 = b.x + b.w / 2, y2 = b.y;
          const dy = Math.max(18, (y2 - y1) / 2);
          const d = y2 > y1
            ? `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`
            : `M${x1},${a.y} C${x1},${a.y - 30} ${x2},${b.y + b.h + 30} ${x2},${b.y + b.h}`;
          const lit = p.highlight.has(e.parentId) && p.highlight.has(e.childId);
          return (
            <path
              key={e.id}
              d={d}
              className={`${s.edge}${lit ? ` ${s.edgeLit}` : ""}`}
              stroke={REL_STROKE[e.relation] ?? "var(--rule)"}
              strokeDasharray={e.relation === "contradicts" ? "5 3" : e.relation === "assumes" ? "1.5 3" : undefined}
            >
              <title>{e.relation}</title>
            </path>
          );
        })}
      </g>

      {/* nodes, revealed in place */}
      {layout.nodes.map((n) => {
        const c = graph.byId[n.id];
        if (!c) return null;
        const meta = nodeStatusMeta(c.status);
        const merged = c.merged != null;
        const cls = [
          s.node,
          `st-${c.status ?? "unassessed"}`,
          p.pulse.has(n.id) ? s.pulse : "",
          p.highlight.has(n.id) ? s.lit : "",
          p.selected === n.id ? s.sel : "",
          merged ? s.merged : "",
          p.target === n.id ? s.target : "",
        ].filter(Boolean).join(" ");
        return (
          <g
            key={n.id}
            className={cls}
            transform={`translate(${n.x},${n.y})`}
            onMouseEnter={() => p.onHover(n.id)}
            onMouseLeave={() => p.onHover(null)}
            onClick={() => p.onSelect(n.id)}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") p.onSelect(n.id); }}
            role="button"
            aria-label={`${c.text} — ${meta.label}${c.credence != null ? `, credence ${c.credence.toFixed(2)}` : ""}`}
          >
            <rect className={s.nodeBg} width={n.w} height={n.h} rx="3" />
            {c.status == null ? <rect width={n.w} height={n.h} rx="3" fill={`url(#${hatch})`} pointerEvents="none" /> : null}
            <rect className={s.nodeTint} width={n.w} height={n.h} rx="3" pointerEvents="none" />
            <rect className={s.nodeRing} x="-3" y="-3" width={n.w + 6} height={n.h + 6} rx="5" pointerEvents="none" />
            <foreignObject width={n.w} height={n.h} pointerEvents="none">
              <div className={s.chip}>
                <div className={s.chipHead}>
                  <span className={`${s.glyph} ${meta.cls}`} aria-hidden>{meta.glyph}</span>
                  <span className={s.chipStatus}>{merged ? "merged" : meta.label}</span>
                  {c.credence != null ? <span className={s.chipNum}>{c.credence.toFixed(2)}</span> : null}
                  {p.unmatched.has(n.id) ? <span className={s.chipFlag} title="the agreement metric found no counterpart in the other arm">no pair</span> : null}
                </div>
                <div className={s.chipText}>{c.text}</div>
                {c.instances > 1 ? <span className={s.chipInst}>×{c.instances}</span> : null}
              </div>
            </foreignObject>
            <title>{c.text}</title>
          </g>
        );
      })}
    </svg>
  );
}
