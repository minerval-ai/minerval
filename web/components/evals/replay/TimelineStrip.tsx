"use client";

import type { ReplayArm } from "@/lib/replay-core";
import { agentClass, agentMeta } from "./vocab";
import s from "./replay.module.css";

// One block per event, coloured by agent, the current one marked, with the
// source boundaries ticked so the two-arm view shows where each source lands.

export function TimelineStrip({
  arm, index, onIndex, sourceOrder, compact,
}: {
  arm: ReplayArm;
  index: number;
  onIndex: (i: number) => void;
  sourceOrder: number[];
  compact?: boolean;
}) {
  return (
    <div className={`${s.strip}${compact ? ` ${s.stripCompact}` : ""}`} role="list" aria-label={`${arm.label}: events`}>
      {arm.events.map((e, i) => {
        const boundary = i > 0 && sourceOrder[i] !== sourceOrder[i - 1];
        return (
          <button
            key={e.seq}
            type="button"
            role="listitem"
            className={`${s.tick} ${agentClass(e.agent)}${i === index ? ` ${s.tickNow}` : ""}${i < index ? ` ${s.tickPast}` : ""}${boundary ? ` ${s.tickBoundary}` : ""}${e.outcome === "error" ? ` ${s.tickErr}` : ""}`}
            title={`#${e.seq} ${agentMeta(e.agent).label}: ${e.title}`}
            aria-label={`Event ${e.seq}, ${agentMeta(e.agent).label}: ${e.title}`}
            aria-current={i === index ? "step" : undefined}
            onClick={() => onIndex(i)}
          />
        );
      })}
    </div>
  );
}
