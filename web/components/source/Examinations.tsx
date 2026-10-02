import Link from "next/link";
import { modelDisplayName } from "@/lib/model-names";
import { agentName, when, type ExamView, type Group } from "./model";
import { FindingNote, Tick } from "./Notes";
import { CoverageStrip } from "./CoverageStrip";
import s from "./source.module.css";

// Each examination as its own record (#507): who commissioned it and for
// what, its brief and facets, what it covered and what it did not, and its
// findings. Nothing here rules on a finding or on the source.
export function Examinations({
  exams, groups, segmented, names, shown, onShow,
}: {
  exams: ExamView[];
  groups: Group[];
  segmented: boolean;
  names: Map<string, string>;
  shown: string | null;
  onShow: (id: string) => void;
}) {
  return (
    <section id="examinations">
      <h2 className={s.h2}>
        Examinations {exams.length > 0 && <span className={s.cnt}>{exams.length}</span>}
      </h2>
      {exams.length === 0 && <p className={s.empty}>None recorded.</p>}
      <div className={s.exams}>
        {exams.map((ev) => {
          const { exam } = ev;
          const on = shown === exam.id;
          const { examined, notExamined } = coverageWords(ev, groups);
          const citing = new Set(exam.findings.flatMap((f) => f.cited_by_claims));
          const audits = exam.findings.reduce((n, f) => n + f.audit_notes.length, 0);
          const spent = exam.runs.reduce((n, r) => n + r.spent_usd, 0);
          const models = [...new Set(exam.runs.map((r) => modelDisplayName(r.model)))];
          const unfinished = exam.runs.filter((r) => r.status !== "completed");
          return (
            <article key={exam.id} id={`exam-${exam.id}`} className={`${s.exam} ${on ? s.on : ""}`}>
              <div className={s.exh}>
                <Tick ev={ev} />
                {exam.scope === "claim" ? (
                  <span className={s.exk}>Commissioned while assessing</span>
                ) : (
                  <span className={s.exk}>Document review</span>
                )}
                {exam.claim && (
                  <Link className={s.exc} href={`/claims/${exam.claim.id}`}>{exam.claim.text}</Link>
                )}
                {exam.trigger === "mandate" && <span className="tag">for a mandate</span>}
                {segmented && (
                  <button type="button" className={s.exbtn} aria-pressed={on} onClick={() => onShow(exam.id)}>
                    {on ? "Shown on text" : "Show on text"}
                  </button>
                )}
              </div>
              <p className={s.brief}>{exam.brief}</p>
              {segmented && <CoverageStrip groups={groups} only={ev} thin />}
              <dl className={s.kv}>
                <dt>Examined</dt>
                <dd>{examined}</dd>
                <dt>Not examined</dt>
                <dd>{notExamined}</dd>
                <dt>Facets</dt>
                <dd>{exam.facets.join(" · ")}</dd>
              </dl>
              <div className={s.exf}>
                <span>{when(exam.created_at)}</span>
                <span>Requested by {agentName(exam.requested_by)}</span>
                {models.length > 0 && <span>Researcher · {models.join(", ")}</span>}
                {exam.runs.length > 0 && <span className={s.mono}>${spent.toFixed(2)}</span>}
                {unfinished.map((r) => <span key={r.id}>run {r.status.replace(/_/g, " ")}</span>)}
                <span>{exam.findings.length} {exam.findings.length === 1 ? "finding" : "findings"}</span>
                <span>cited in {citing.size} {citing.size === 1 ? "claim's reading" : "claims' readings"}</span>
                <span>{audits} {audits === 1 ? "audit note" : "audit notes"}</span>
              </div>
              {exam.findings.length > 0 && (
                <details className={s.flist}>
                  <summary>Findings · {exam.findings.length}</summary>
                  {exam.findings.map((f) => (
                    <div key={f.id} className={s.fitem}>
                      <FindingNote
                        f={f}
                        ev={ev}
                        names={names}
                        full
                        where={
                          f.segment_id ? (
                            <a href={`#seg-${f.segment_id}`}>at {f.segment_label ?? placeOf(f.segment_id, groups)}</a>
                          ) : (
                            <span>not on a passage</span>
                          )
                        }
                      />
                    </div>
                  ))}
                </details>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function placeOf(segId: string, groups: Group[]): string {
  for (const g of groups) {
    const i = g.leaves.findIndex((l) => l.seg.id === segId);
    if (i >= 0) return `${g.label ?? "opening"}, ¶${i + 1}`;
  }
  return "a passage";
}

// Coverage in the document's own section names: whole, in part, or not.
function coverageWords(ev: ExamView, groups: Group[]): { examined: string; notExamined: string } {
  if (groups.length === 0) {
    return { examined: "Not recorded against passages", notExamined: "Not recorded" };
  }
  const yes: string[] = [];
  const no: string[] = [];
  for (const g of groups) {
    const name = g.label ?? "Opening";
    const n = g.leaves.filter((l) => ev.covered.has(l.seg.id)).length;
    if (n === 0) no.push(name);
    else if (n >= g.leaves.length) yes.push(name);
    else {
      yes.push(`${name} (${n} of ${g.leaves.length})`);
      no.push(`rest of ${name}`);
    }
  }
  return {
    examined: yes.length ? yes.join(" · ") : "Nothing recorded",
    notExamined: no.length ? no.join(" · ") : "Nothing; the whole text",
  };
}
