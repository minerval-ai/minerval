import { useState } from "react";
import type { DocumentInstance, DocumentSegment, ExaminationFinding, SourceDocument } from "@/lib/types";
import { tableRows, type ExamView, type Group, type Leaf } from "./model";
import { FindingNote, ReadingNote, Tick } from "./Notes";
import { CoverageStrip, EXAMINED_ANY } from "./CoverageStrip";
import s from "./source.module.css";

type Findings = Map<string, Array<{ f: ExaminationFinding; ev: ExamView }>>;

// The document as annotated text (#507), in the document's own order. A
// passage a claim asserts or engages is marked, and the margin carries each
// such claim's reading; passages nothing touches fold by section, so the
// picture of the whole is built from many claims' work, none leading it.
export function AnnotatedText({
  doc, groups, exams, findings, names, shown, setShown,
}: {
  doc: SourceDocument | null;
  groups: Group[];
  exams: ExamView[];
  findings: Findings;
  names: Map<string, string>;
  shown: string | null;
  setShown: (id: string | null) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const only = exams.find((e) => e.exam.id === shown) ?? null;
  const leaves = groups.flatMap((g) => g.leaves);
  const marked = leaves.filter((l) => l.seg.instances.length > 0).length;
  const anchored = leaves.reduce((n, l) => n + (findings.get(l.seg.id)?.length ?? 0), 0);
  const unanchored = doc?.unanchored ?? [];

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section id="text">
      <h2 className={s.h2}>
        Text
        {groups.length > 0 && (
          <span className={s.cnt}>
            {leaves.length} passages · {marked} marked
            {exams.length > 0 && ` · ${anchored} ${anchored === 1 ? "finding" : "findings"} anchored`}
          </span>
        )}
      </h2>

      {!doc ? (
        <p className={s.empty}>Not recorded.</p>
      ) : !doc.segmented ? (
        <p className={s.empty} style={{ marginBottom: ".6rem" }}>
          {doc.total_chars > 0
            ? "Stored, not yet divided into passages."
            : "No stored copy. Only the passages claims quote are recorded."}
        </p>
      ) : (
        <>
          {exams.length > 0 && (
            <div className={s.chips} role="group" aria-label="Examination shown on the text">
              <button type="button" className={`${s.chip} ${!only ? s.on : ""}`} aria-pressed={!only} onClick={() => setShown(null)}>
                All examinations
              </button>
              {exams.map((ev) => (
                <button
                  key={ev.exam.id}
                  type="button"
                  className={`${s.chip} ${only === ev ? s.on : ""}`}
                  aria-pressed={only === ev}
                  onClick={() => setShown(only === ev ? null : ev.exam.id)}
                >
                  <Tick ev={ev} small /> {ev.short}
                </button>
              ))}
            </div>
          )}
          <CoverageStrip groups={groups} exams={exams} only={only} />
          <div className={s.stripl}>
            {exams.length > 0 ? (
              <>
                <span>
                  <span className={s.sw2} style={{ background: only ? only.color : EXAMINED_ANY }} />
                  {only ? `Examined in ${only.code}` : "Examined"}
                </span>
                <span><span className={s.sw2} style={{ background: "var(--rule-soft)" }} />Not examined</span>
              </>
            ) : (
              <span><span className={s.sw2} style={{ background: "var(--rule-soft)" }} />No examination yet</span>
            )}
            <span>
              <span className={s.sw2} style={{ background: "var(--rule-soft)", borderTop: "3px solid var(--ink)" }} />
              Marked passage
            </span>
          </div>

          {groups.map((g) => (
            <GroupBlock
              key={g.id}
              g={g}
              open={open.has(g.id)}
              onToggle={() => toggle(g.id)}
              exams={exams}
              only={only}
              findings={findings}
              names={names}
            />
          ))}
        </>
      )}

      {unanchored.length > 0 && (
        <>
          {doc?.segmented && (
            <h3 className={s.h2}>
              Not found in the text <span className={s.cnt}>{unanchored.length}</span>
            </h3>
          )}
          {unanchored.map((i) => (
            <QuotedRow key={i.instance_id} inst={i} />
          ))}
        </>
      )}
      {doc && !doc.segmented && unanchored.length === 0 && (
        <p className={s.empty} style={{ marginTop: ".5rem" }}>No claim quotes it yet.</p>
      )}
    </section>
  );
}

function GroupBlock({
  g, open, onToggle, exams, only, findings, names,
}: {
  g: Group;
  open: boolean;
  onToggle: () => void;
  exams: ExamView[];
  only: ExamView | null;
  findings: Findings;
  names: Map<string, string>;
}) {
  const isMarked = (l: Leaf) => l.seg.instances.length > 0 || (findings.get(l.seg.id)?.length ?? 0) > 0;
  const hidden = g.leaves.filter((l) => !isMarked(l));
  const visible = open ? g.leaves : g.leaves.filter(isMarked);
  const marks = g.leaves.filter((l) => l.seg.instances.length > 0).length;
  const unit = unitOf(hidden.length ? hidden : g.leaves);
  let lastSub: string | null = null;

  return (
    <div className={s.group} id={`grp-${g.id}`}>
      {g.label && (
        <div className={s.gh}>
          {g.label}
          <span className={s.cnt}>
            {g.leaves.length} {unitOf(g.leaves, g.leaves.length)}
            {marks > 0 && ` · ${marks} marked`}
          </span>
        </div>
      )}
      {visible.map((l) => {
        const showSub = l.sub && l.sub !== lastSub;
        lastSub = l.sub;
        return (
          <div key={l.seg.id}>
            {showSub && <div className={s.sub}>{l.sub}</div>}
            <PassageRow leaf={l.seg} exams={exams} only={only} findings={findings.get(l.seg.id) ?? []} names={names} />
          </div>
        );
      })}
      {hidden.length > 0 && (
        <button type="button" className={s.fold} aria-expanded={open} onClick={onToggle}>
          {open ? `Fold unmarked ${unit}` : `${hidden.length} unmarked ${unitOf(hidden, hidden.length)}`}
        </button>
      )}
    </div>
  );
}

function unitOf(leaves: Leaf[], n = 2): string {
  const kinds = new Set(leaves.map((l) => l.seg.kind));
  const one = kinds.size === 1 ? [...kinds][0] : "passage";
  const word = one === "reference" ? "reference" : one === "note" ? "note" : one === "table" ? "table" : "passage";
  return n === 1 ? word : `${word}s`;
}

function PassageRow({
  leaf, exams, only, findings, names,
}: {
  leaf: DocumentSegment;
  exams: ExamView[];
  only: ExamView | null;
  findings: Array<{ f: ExaminationFinding; ev: ExamView }>;
  names: Map<string, string>;
}) {
  const by = (only ? [only] : exams).filter((ev) => ev.covered.has(leaf.id));
  const dim = only && by.length === 0;
  const marked = leaf.instances.length > 0;
  const kindCls = leaf.kind === "reference" ? s.ref : leaf.kind === "note" ? s.knote : "";
  return (
    <div className={`${s.prow} ${dim ? s.dim : ""}`} id={`seg-${leaf.id}`}>
      <div className={s.gut}>
        {by.map((ev) => <Tick key={ev.exam.id} ev={ev} small />)}
      </div>
      <div className={`${s.ptext} ${marked ? s.marked : findings.length ? s.found : ""} ${kindCls}`}>
        {leaf.label && <span className={s.plabel}>{leaf.label}</span>}
        <SegmentText seg={leaf} />
      </div>
      {(marked || findings.length > 0) && (
        <div className={s.mg}>
          {leaf.instances.map((i) => <ReadingNote key={i.instance_id} inst={i} />)}
          {findings.map(({ f, ev }) => (
            <FindingNote key={f.id} f={f} ev={ev} names={names} off={!!only && only !== ev} />
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentText({ seg }: { seg: DocumentSegment }) {
  const text = seg.text ?? "";
  if (seg.kind === "table") {
    const rows = tableRows(text);
    return (
      <div className={s.ptab}>
        {rows ? (
          <table>
            <thead>
              <tr>{rows[0]!.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre>{text}</pre>
        )}
      </div>
    );
  }
  return <p>{text}</p>;
}

// A claim's quoted passage that is not in (or has no) stored text: shown as
// the claim recorded it, with the reading beside it.
function QuotedRow({ inst }: { inst: DocumentInstance }) {
  return (
    <div className={s.prow}>
      <div className={s.gut} />
      <div className={`${s.ptext} ${s.marked}`}>
        <span className={s.plabel}>As quoted</span>
        <p className={s.quote}>{inst.verbatim_text}</p>
      </div>
      <div className={s.mg}>
        <ReadingNote inst={inst} />
      </div>
    </div>
  );
}
