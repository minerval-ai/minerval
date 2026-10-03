import { useState } from "react";
import Link from "next/link";
import type { SourceContext } from "@/lib/types";
import { agentName, clip, HISTORY_WORD, when } from "./model";
import s from "./source.module.css";

const SHOWN = 8;

// What has been done to and about the document, newest first (#507).
export function History({ context }: { context: SourceContext | null | undefined }) {
  const [all, setAll] = useState(false);
  const rows = context?.history ?? [];
  const visible = all ? rows : rows.slice(0, SHOWN);
  return (
    <section id="history">
      <h2 className={s.h2}>
        History {rows.length > 0 && <span className={s.cnt}>{rows.length}</span>}
      </h2>
      {!context ? (
        <p className={s.empty}>Not recorded.</p>
      ) : rows.length === 0 ? (
        <p className={s.empty}>Nothing recorded yet.</p>
      ) : (
        <>
          <ol className={s.hist}>
            {visible.map((h, i) => (
              <li key={i}>
                <span className={s.hd}>{when(h.at)}</span>
                <span className={s.hw}>{HISTORY_WORD[h.kind] ?? h.kind}</span>
                <span>
                  {h.by !== "graph" && <span className={s.quiet}>{byLine(h.by, h.claim)} · </span>}
                  {h.text}
                  {h.claim && h.by !== "claim_steward" && (
                    <> · <Link href={`/claims/${h.claim.id}`}>{clip(h.claim.text, 60)}</Link></>
                  )}
                </span>
              </li>
            ))}
          </ol>
          {rows.length > SHOWN && (
            <button type="button" className={s.fold} style={{ paddingLeft: 0 }} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Show the latest only" : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function byLine(by: string, claim: { id: string; text: string } | null) {
  if (by === "claim_steward" && claim) {
    return <>Steward of <Link href={`/claims/${claim.id}`}>&ldquo;{clip(claim.text, 48)}&rdquo;</Link></>;
  }
  const name = agentName(by);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
