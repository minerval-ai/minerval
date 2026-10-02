import type { ExamView, Group } from "./model";
import s from "./source.module.css";

const EXAMINED_ANY = "#8a8378";

// The document as a strip, one cell per passage sized by its length, so what
// was NOT examined shows as plainly as what was. A marked passage (one a
// claim asserts or engages) carries a rule along its top.
export function CoverageStrip({
  groups, exams = [], only, thin,
}: { groups: Group[]; exams?: ExamView[]; only?: ExamView | null; thin?: boolean }) {
  const leaves = groups.flatMap((g) => g.leaves);
  if (leaves.length === 0) return null;
  const pool = only ? [only] : exams;
  return (
    <div className={`${s.strip} ${thin ? s.thin : ""}`} role="img" aria-label={label(leaves.length, pool, leaves)}>
      {leaves.map(({ seg }) => {
        const by = pool.filter((ev) => ev.covered.has(seg.id));
        const bg = by.length === 0 ? undefined : only ? only.color : EXAMINED_ANY;
        const marked = !thin && seg.instances.length > 0;
        return (
          <span
            key={seg.id}
            className={`${s.cell} ${marked ? s.markedCell : ""}`}
            style={{ flex: `${Math.max(1, seg.char_end - seg.char_start)} 1 0`, background: bg }}
            title={`${seg.label ?? seg.kind}: ${by.length ? `examined (${by.map((e) => e.code).join(", ")})` : "not examined"}`}
          />
        );
      })}
    </div>
  );
}

function label(n: number, pool: ExamView[], leaves: Array<{ seg: { id: string } }>) {
  const covered = leaves.filter(({ seg }) => pool.some((ev) => ev.covered.has(seg.id))).length;
  return `${covered} of ${n} passages examined`;
}

export { EXAMINED_ANY };
