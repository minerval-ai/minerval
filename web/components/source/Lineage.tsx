import Link from "next/link";
import type { LineageEntry, LineageSide, SourceContext } from "@/lib/types";
import {
  DIVERGENT_FIDELITY, FIDELITY_WORD, clip, kindLabel, partialDate, plural, relationWords,
} from "./model";
import s from "./source.module.css";

// What this document draws on and what draws on it, across every claim it
// bears on (#507). Relations are said in words with their fidelity; a
// divergent one is flagged as on the claim map, and nothing is ranked.
export function Lineage({ context, title }: { context: SourceContext | null | undefined; title: string }) {
  const lin = context?.lineage;
  const st = context?.prominence.structure;
  const sub = st
    ? [
        st.origin_on ? `Origin on ${plural(st.origin_on, "claim")}` : null,
        st.underlying_on ? `underlying on ${st.underlying_on}` : null,
        st.claims ? `in ${plural(st.claims, "claim's map", "claims' maps")}` : null,
      ].filter(Boolean).join(" · ")
    : "";
  return (
    <section id="lineage">
      <h2 className={s.h2}>
        Lineage {st && st.claims > 0 && <span className={s.cnt}>across {plural(st.claims, "claim")}</span>}
      </h2>
      {!lin ? (
        <p className={s.empty}>Not recorded.</p>
      ) : (
        <div className={`${s.lin} ${lin.draws_on.total + lin.drawn_on_by.total === 0 ? s.linEmpty : ""}`}>
          <div className={s.spine} aria-hidden />
          <Side label="Draws on" side={lin.draws_on} dir="up" />
          <div className={s.focus}>
            <span className="sc">This source</span>
            <div className={s.focusName}>{clip(title, 90)}</div>
            <div className={s.focusSub}>{sub || "No recorded edges"}</div>
          </div>
          <Side label="Drawn on by" side={lin.drawn_on_by} dir="down" />
        </div>
      )}
    </section>
  );
}

function Side({ label, side, dir }: { label: string; side: LineageSide; dir: "up" | "down" }) {
  return (
    <>
      <span className={`sc ${s.tl}`}>
        {label} · {side.total || "none recorded"}
      </span>
      {side.entries.map((e) => <EntryCard key={e.source.id} e={e} dir={dir} />)}
      {side.rest.length > 0 && (
        <div className={s.t2row}>
          {side.rest.map((r) => (
            <span key={r.source_type} className={s.t2}>
              <b>{kindLabel(r.source_type)} · {r.sources}</b>
              {Object.keys(r.fidelity).length > 0 && " · "}
              {Object.entries(r.fidelity)
                .sort((a, b) => b[1] - a[1])
                .map(([f, n]) => `${n} ${FIDELITY_WORD[f] ?? f}`)
                .join(" · ")}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function EntryCard({ e, dir }: { e: LineageEntry; dir: "up" | "down" }) {
  const div = e.diverges ? e.relations.find((r) => DIVERGENT_FIDELITY.has(r.fidelity)) : undefined;
  const date = partialDate(e.source.published_date);
  return (
    <div className={`${s.t1} ${e.diverges ? s.divergent : ""}`}>
      <Link className={s.t1name} href={`/sources/${e.source.id}`}>{e.source.title}</Link>
      <span className={s.t1meta}>
        <span className="tag kind">{kindLabel(e.source.source_type)}</span>
        {date && <span>{date}</span>}
        <span>{plural(e.claims, "claim")}</span>
      </span>
      {e.diverges && <span className={s.diverges}>Diverges · {div ? FIDELITY_WORD[div.fidelity] ?? div.fidelity : "see the claim maps"}</span>}
      <span className={s.t1rel}>{relationWords(e.relations, dir)}</span>
    </div>
  );
}
