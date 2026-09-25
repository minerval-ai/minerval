"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClaimLinkKind, RelatedClaim } from "@/lib/types";
import { nodeStatusMeta } from "@/lib/ontology";
import styles from "./margins.module.css";

// How each lateral link kind reads on the page (#436). These are see-alsos,
// never dependencies: the map, the tree, and the assessment do not see them.
const KIND: Record<ClaimLinkKind, { label: string; gloss: string }> = {
  rival_explanation: {
    label: "rival explanation",
    gloss: "A competing account of the same event or phenomenon; evidence for one bears on the other.",
  },
  counterpart_position: {
    label: "counterpart",
    gloss: "The other half of one public position; a reader of either would want both.",
  },
  related: {
    label: "related",
    gloss: "A claim worth reading beside this one, without a tighter fit.",
  },
};

// The right-margin see-also rail: claims linked laterally to this one. Absent
// entirely when there are none; a claim with no lateral links is the common
// case and needs no resting state.
export function RelatedRail({ related }: { related: RelatedClaim[] }) {
  const [whyOpen, setWhyOpen] = useState<Set<string>>(new Set());
  const n = related.length;
  if (n === 0) return null;

  function toggleWhy(id: string) {
    setWhyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className={styles.rail} aria-label="Related claims">
      <div className={styles.railHead} style={{ cursor: "default" }}>
        <span className="sc">See also</span>
        <span className={styles.railCount}>
          {n}
          <span className={styles.railCountUnit}>claim{n === 1 ? "" : "s"}</span>
        </span>
      </div>
      <ul className={`${styles.depList} ${n > 8 ? styles.scrollList : ""}`}>
        {related.map((r) => {
          const kind = KIND[r.kind] ?? KIND.related;
          const st = nodeStatusMeta(r.assessment_status);
          const why = whyOpen.has(r.link_id);
          return (
            <li key={r.link_id} className={styles.depItem}>
              <div className={styles.depEdge}>
                <span className={`swatch ${st.cls}`} title={`${st.label}: ${st.def}`} aria-hidden />
                <span className="relation" title={kind.gloss}>{kind.label}</span>
                <span className={styles.depConf}>{st.label}</span>
                {r.reasoning && (
                  <button
                    type="button"
                    className={styles.whyToggle}
                    onClick={() => toggleWhy(r.link_id)}
                    aria-expanded={why}
                  >
                    {why ? "▾ why" : "▸ why"}
                  </button>
                )}
              </div>
              <Link href={`/claims/${r.id}`} className={styles.depText}>
                {r.text}
              </Link>
              {why && r.reasoning && <p className={styles.depWhy}>{r.reasoning}</p>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
