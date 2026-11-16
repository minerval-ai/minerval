import { when, type ExamView, type Group } from "./model";
import { Tick } from "./Notes";
import s from "./source.module.css";

// The passages the graph's work has touched, by the section each sits in,
// with how many claims mark it and, per examination, whether it was
// examined. The document's own outline is not repeated here: on a scraped
// page it is mostly the site's navigation, forty headings over one quoted
// passage. Wide screens only; the page reads in order without it.
export function OutlineRail({
  groups, exams, findings,
}: {
  groups: Group[];
  exams: ExamView[];
  /** Segments an examination found something in, which lead the text as marked passages do. */
  findings: ReadonlySet<string>;
}) {
  const leaves = groups.flatMap((g) => g.leaves);
  const marked = leaves.filter((l) => l.seg.instances.length > 0).length;
  const lead = groups.flatMap((g) =>
    g.leaves
      .filter((l) => l.seg.instances.length > 0 || findings.has(l.seg.id))
      .map((l) => ({ id: l.seg.id, label: [g.label, l.sub, l.seg.label].filter(Boolean).join(" · ") || "Opening", marks: l.seg.instances.length })),
  );
  return (
    <aside className={s.rail} aria-label="Quoted passages">
      {leaves.length > 0 && (
        <nav>
          <div className={s.railHead}>
            <span className="sc">Quoted</span>
            <span className={s.railSub}>{marked} of {leaves.length} passages marked</span>
          </div>
          {lead.length > 0 ? (
            <ul className={s.olist}>
              {lead.map((l) => (
                <li key={l.id}>
                  <a href={`#seg-${l.id}`}>
                    <span>{l.label}</span>
                    <span className={s.omarks}>{l.marks || ""}</span>
                    {exams.length > 0 && (
                      <span className={s.ocells}>
                        {exams.map((ev) => {
                          const on = ev.covered.has(l.id);
                          return (
                            <span
                              key={ev.exam.id}
                              className={s.ocell}
                              style={on ? { background: ev.color, borderColor: ev.color } : undefined}
                              title={`${ev.code}: ${on ? "examined" : "not examined"}`}
                            />
                          );
                        })}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.railNone}>None yet</p>
          )}
        </nav>
      )}
      <div>
        <div className={s.railHead}><span className="sc">Examinations</span></div>
        {exams.length ? (
          <ul className={s.exl}>
            {exams.map((ev) => (
              <li key={ev.exam.id}>
                <Tick ev={ev} />
                <a href={`#exam-${ev.exam.id}`} style={{ color: "inherit" }}>
                  {ev.exam.scope === "claim" ? "While assessing a claim" : "Document review"}
                  <span className={s.date}>{when(ev.exam.created_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.railNone}>None</p>
        )}
      </div>
      <nav>
        <div className={s.railHead}><span className="sc">Contents</span></div>
        <ul className={s.jl}>
          <li><a href="#examinations">Examinations</a></li>
          <li><a href="#text">Text</a></li>
          <li><a href="#lineage">Lineage</a></li>
          <li><a href="#record">Record</a></li>
          <li><a href="#history">History</a></li>
        </ul>
      </nav>
    </aside>
  );
}
