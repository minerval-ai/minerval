import { when, type ExamView, type Group } from "./model";
import { Tick } from "./Notes";
import s from "./source.module.css";

// The document's own outline, with how many passages each claim's work has
// marked and, per examination, whether a section was examined in full, in
// part, or not at all. Wide screens only; the page reads in order without it.
export function OutlineRail({ groups, exams }: { groups: Group[]; exams: ExamView[] }) {
  const leaves = groups.flatMap((g) => g.leaves);
  const marked = leaves.filter((l) => l.seg.instances.length > 0).length;
  return (
    <aside className={s.rail} aria-label="Outline">
      {groups.length > 0 && (
        <nav>
          <div className={s.railHead}>
            <span className="sc">Outline</span>
            <span className={s.railSub}>{marked} of {leaves.length} passages marked</span>
          </div>
          <ul className={s.olist}>
            {groups.map((g) => {
              const marks = g.leaves.filter((l) => l.seg.instances.length > 0).length;
              return (
                <li key={g.id}>
                  <a href={`#grp-${g.id}`}>
                    <span>{g.label ?? "Opening"}</span>
                    <span className={s.omarks}>{marks || ""}</span>
                    {exams.length > 0 && (
                      <span className={s.ocells}>
                        {exams.map((ev) => {
                          const n = g.leaves.filter((l) => ev.covered.has(l.seg.id)).length;
                          const style =
                            n === 0
                              ? undefined
                              : n >= g.leaves.length
                                ? { background: ev.color, borderColor: ev.color }
                                : { background: `repeating-linear-gradient(90deg, ${ev.color} 0 3px, transparent 3px 5px)`, borderColor: ev.color };
                          return (
                            <span
                              key={ev.exam.id}
                              className={s.ocell}
                              style={style}
                              title={`${ev.code}: ${n === 0 ? "not examined" : n >= g.leaves.length ? "examined" : "examined in part"}`}
                            />
                          );
                        })}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
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
