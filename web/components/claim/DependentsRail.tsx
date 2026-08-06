"use client";

import { useState } from "react";
import Link from "next/link";
import type { DependentClaim } from "@/lib/types";
import {
  RELATION, STATUS_ORDER, statusMeta, nodeStatusMeta, UNASSESSED_META,
  DEFINED_IN, STEWARD_SOURCE,
} from "@/lib/ontology";
import { Term } from "@/components/Term";
import styles from "./margins.module.css";

// Above this many dependents, a dot-per-claim row stops being legible, so we
// switch the ambient marker to a status-distribution bar instead.
const DOT_CAP = 18;

// null status → "unassessed", a pending state — never the "Unknown" verdict,
// which is an assessed outcome (#160).
function statusKey(status: string | null): string {
  return nodeStatusMeta(status).cls.replace("st-", "");
}

// Reading order for counts/legend: verdicts first, the pending tail last.
const KEY_ORDER: string[] = [...STATUS_ORDER, "unassessed"];

function keyMeta(key: string) {
  return key === "unassessed" ? UNASSESSED_META : statusMeta(key);
}

// The right-margin rail: claims that depend on this one (reverse decomposition
// edges). Ambient by default — a count and a marker — expanding to the full list.
export function DependentsRail({ dependents }: { dependents: DependentClaim[] }) {
  const [open, setOpen] = useState(false);
  // Per-item disclosure of the edge's reasoning: the rail is too narrow to
  // show every explanation at once (#199).
  const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set());
  const n = dependents.length;

  function toggleWhy(id: string) {
    setWhyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Nothing builds on this yet — a quiet resting state rather than a blank gap.
  if (n === 0) {
    return (
      <aside className={styles.rail} aria-label="Claims that depend on this one">
        <div className={styles.railHead} style={{ cursor: "default" }}>
          <span className="sc">Depended on by</span>
          <span className={styles.railCount}>
            0<span className={styles.railCountUnit}>claims</span>
          </span>
        </div>
        <p className={styles.emptyNote}>Nothing in the graph builds on this claim yet.</p>
      </aside>
    );
  }

  const counts: Record<string, number> = {};
  for (const d of dependents) {
    const k = statusKey(d.assessment_status);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const present = KEY_ORDER.filter((s) => counts[s]);

  return (
    <aside className={styles.rail} aria-label="Claims that depend on this one">
      <button type="button" className={styles.railHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="sc">Depended on by</span>
        <span className={styles.railCount}>
          {n}
          <span className={styles.railCountUnit}>claim{n === 1 ? "" : "s"}</span>
        </span>
      </button>

      {/* ambient marker: one dot per claim while that stays legible, else a bar */}
      {n <= DOT_CAP ? (
        <div className={styles.dotRow} aria-hidden>
          {dependents.map((d) => (
            <span key={d.id} className={`${styles.dot} st-${statusKey(d.assessment_status)}`} title={d.text} />
          ))}
        </div>
      ) : (
        <>
          <div className={styles.distBar} title="status of the dependent claims" aria-hidden>
            {present.map((s) => (
              <span key={s} className={`st-${s}`} style={{ width: `${(counts[s] / n) * 100}%` }} />
            ))}
          </div>
          <ul className={styles.legend}>
            {present.map((s) => (
              <li key={s} className={`st-${s}`}>
                <span className={`swatch st-${s}`} aria-hidden />
                <span className={styles.legendN}>{counts[s]}</span>
                <Term
                  gloss={keyMeta(s).def}
                  href={s === "unassessed" ? DEFINED_IN.importance : DEFINED_IN.status}
                  className={styles.legendLbl}
                  align="end"
                >
                  {keyMeta(s).label}
                </Term>
              </li>
            ))}
          </ul>
        </>
      )}

      <button type="button" className={styles.railToggle} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾ hide" : "▸ show what builds on this"}
      </button>

      {open && (
        <ul className={`${styles.depList} ${n > 8 ? styles.scrollList : ""}`}>
          {dependents.map((d) => {
            const rel = RELATION[d.relation_type];
            const st = nodeStatusMeta(d.assessment_status);
            const why = whyOpen.has(d.id);
            return (
              <li key={d.id} className={styles.depItem}>
                <div className={styles.depEdge}>
                  <span className={`swatch ${st.cls}`} title={`${st.label}: ${st.def}`} aria-hidden />
                  {rel && (
                    <Term
                      gloss={rel.gloss}
                      href={DEFINED_IN.relation}
                      source={STEWARD_SOURCE}
                      className={`relation ${rel.cls}`}
                      align="end"
                    >
                      {rel.label}
                    </Term>
                  )}
                  {/* Status label only — the bare verdict-confidence number
                      that used to follow it read as P(claim true) (#160). */}
                  <span className={styles.depConf}>{st.label}</span>
                  {d.reasoning && (
                    <button
                      type="button"
                      className={styles.whyToggle}
                      onClick={() => toggleWhy(d.id)}
                      aria-expanded={why}
                    >
                      {why ? "▾ why" : "▸ why"}
                    </button>
                  )}
                </div>
                <Link href={`/claims/${d.id}`} className={styles.depText}>
                  {d.text}
                </Link>
                {why && d.reasoning && (
                  <p className={styles.depWhy}>
                    {rel && <span className={`relation ${rel.cls} ${styles.depWhyRel}`}>{rel.label} this claim</span>}
                    {d.reasoning}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
