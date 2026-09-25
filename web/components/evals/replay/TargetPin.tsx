"use client";

import { credenceSeries, type CredencePoint, type InterimGraph, type ReplayArm } from "@/lib/replay-core";
import { nodeStatusMeta } from "@/lib/ontology";
import { Swatch } from "@/components/Assessment";
import type { Nav } from "./hash";
import s from "./replay.module.css";

// The adversarial target, pinned above the graph with its credence over the
// arm's events: a step line, one point per assessment, the playhead marked.

export function CredenceSpark({ series, count, index, width = 160, height = 28 }: { series: CredencePoint[]; count: number; index: number; width?: number; height?: number }) {
  const pad = 3;
  const n = Math.max(1, count - 1);
  // index -1 is the state before the recording: drawn at the left edge.
  const x = (i: number) => pad + (Math.max(0, i) / n) * (width - 2 * pad);
  const y = (v: number) => height - pad - v * (height - 2 * pad);
  const pts = series.filter((p) => p.credence != null).map((p) => ({ x: x(p.index), y: y(p.credence!), p }));
  // step line: hold each value until the next assessment
  let d = "";
  pts.forEach((pt, i) => {
    if (i === 0) d += `M${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    else d += ` H${pt.x.toFixed(1)} V${pt.y.toFixed(1)}`;
  });
  if (pts.length) d += ` H${x(count - 1).toFixed(1)}`;
  const label = pts.map((pt) => pt.p.credence!.toFixed(2)).join(" → ") || "no credence";
  return (
    <svg className={s.spark} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`credence over events: ${label}`}>
      <title>{label}</title>
      <line x1={pad} x2={width - pad} y1={y(0.5)} y2={y(0.5)} className={s.sparkMid} />
      <line x1={x(Math.min(index, count - 1))} x2={x(Math.min(index, count - 1))} y1={pad} y2={height - pad} className={s.sparkNow} />
      {d ? <path d={d} className={s.sparkLine} /> : null}
      {pts.map((pt, i) => (
        <circle key={i} cx={pt.x} cy={pt.y} r={pt.p.index <= index ? 2.4 : 1.6} className={pt.p.index <= index ? s.sparkDot : s.sparkDotAhead} />
      ))}
    </svg>
  );
}

export function TargetPin({ arm, claimId, graph, index, nav, direction }: { arm: ReplayArm; claimId: string; graph: InterimGraph; index: number; nav: Nav; direction?: "up" | "down" | null }) {
  const c = graph.byId[claimId] ?? null;
  const text = c?.text ?? arm.final.claims.find((x) => x.id === claimId)?.text ?? claimId;
  const series = credenceSeries(arm, claimId);
  const meta = nodeStatusMeta(c?.status ?? null);
  return (
    <div className={s.pin}>
      <div className={s.pinHead}>
        <span className="sc">target{direction ? ` · attacker wants it ${direction}` : ""}</span>
        <CredenceSpark series={series} count={arm.events.length} index={index} />
      </div>
      <button type="button" className={`${s.linklike} ${s.pinText}`} onClick={() => nav.openClaim(arm.key, claimId)}>{text}</button>
      <p className={s.nowMeta}>
        <Swatch status={c?.status ?? null} /> {meta.label}
        {c?.credence != null ? <> · credence {c.credence.toFixed(2)}</> : null}
        {c?.confidence != null ? <> · verdict confidence {c.confidence.toFixed(2)}</> : null}
      </p>
    </div>
  );
}
