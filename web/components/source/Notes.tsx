import Link from "next/link";
import type { DocumentInstance, ExaminationFinding } from "@/lib/types";
import { Swatch } from "@/components/Assessment";
import { statusMeta } from "@/lib/ontology";
import { agentName, clip, SUPPORT_CLS, SUPPORT_WORD, when, type ExamView } from "./model";
import s from "./source.module.css";

export function Tick({ ev, small }: { ev: ExamView; small?: boolean }) {
  return (
    <span
      className={`${s.tick} ${small ? s.tickSm : ""}`}
      style={{ background: ev.color }}
      title={`Examination ${ev.code}: ${ev.short}`}
      aria-label={`Examination ${ev.code}`}
    >
      {ev.code}
    </span>
  );
}

// One claim's appearance at a passage, and that claim's Steward's reading of
// it, in that claim's voice. The page's own words stop at the label.
export function ReadingNote({ inst }: { inst: DocumentInstance }) {
  const r = inst.reading;
  return (
    <div className={s.note}>
      <Link className={s.nclaim} href={`/claims/${inst.claim.id}`}>{inst.claim.text}</Link>
      <span className={s.nmeta}>
        {inst.claim.status ? (
          <>
            <Swatch status={inst.claim.status} />
            <span className={statusMeta(inst.claim.status).cls}>{statusMeta(inst.claim.status).label}</span>
          </>
        ) : (
          <>
            <span className="swatch st-unassessed" aria-hidden />
            <span>Unassessed</span>
          </>
        )}
        {inst.stance === "denies" && <span className="tag" title="This passage denies the claim as stated.">denies</span>}
      </span>
      {r ? (
        <>
          <span className={s.nvoice}>Reading · this claim&rsquo;s Steward</span>
          <p className={s.nread}>
            <b className={SUPPORT_CLS[r.support]}>{SUPPORT_WORD[r.support] ?? r.support}.</b>
            {r.note ? ` ${r.note}` : ""}
            {!r.source_read && <span className={s.caution}> Read from the quoted passage alone.</span>}
          </p>
        </>
      ) : (
        <p className={`${s.nread} ${s.caution}`}>Not yet read by this claim&rsquo;s Steward.</p>
      )}
    </div>
  );
}

// A finding, attributed to the examination that made it. No disposition: the
// page shows who cites it and what the Audit agent noted, nothing more.
export function FindingNote({
  f, ev, names, off, full, where,
}: {
  f: ExaminationFinding;
  ev: ExamView;
  names: Map<string, string>;
  off?: boolean;
  full?: boolean;
  where?: React.ReactNode;
}) {
  const cited = f.cited_by_claims;
  return (
    <div className={`${s.fcard} ${off ? s.off : ""}`}>
      <span className={s.fh}>
        <Tick ev={ev} small />
        <span>{f.facet}</span>
        {where}
        <span>{when(f.created_at)}</span>
      </span>
      <p className={s.fstate}>{f.statement}</p>
      {full && f.evidence && (
        <p className={s.fev}>
          <span className="sc">Evidence</span> {f.evidence}
        </p>
      )}
      <p className={s.fcite}>
        {cited.length ? (
          <>
            Cited in the reading of{" "}
            {cited.map((id, i) => (
              <span key={id}>
                {i > 0 && "; "}
                <Link href={`/claims/${id}`}>{clip(names.get(id) ?? id, 48)}</Link>
              </span>
            ))}
          </>
        ) : (
          <span className={s.caution}>Not cited by any claim&rsquo;s reading</span>
        )}
      </p>
      {f.audit_notes.map((n, i) => (
        <p key={i} className={s.audit}>
          <span className="sc">Audit note</span> · {agentName(n.created_by)} · {when(n.created_at)}
          <br />
          {n.note}
        </p>
      ))}
    </div>
  );
}
