import Link from "next/link";
import { MapDiagram } from "@/components/evals/Diagrams";
import { fmtDate, loadEvalsData } from "@/lib/evals";
import { GROUPS, TOPICS, indexRow } from "./guide";
import s from "./evals.module.css";

// The evals index (#368): a table. One row per eval: the property it checks,
// its standing, when it last ran, what it found, what it costs. Everything
// else is behind the link. Rendered from files committed to the repository.

export const metadata = {
  title: "Evals · Minerval",
  description: "The tests run on the agents that build the claim graph: what each checks, when it last ran, what it found, what it costs.",
};

export default function EvalsIndex() {
  const d = loadEvalsData();
  const evals = TOPICS.filter((t) => t.kind === "eval");
  const background = TOPICS.filter((t) => t.kind === "background");

  return (
    <div className={s.wide}>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <h1>Evals</h1>
      <p className="lede" style={{ fontSize: "1.02rem", marginBottom: "1.2rem" }}>
        The properties of the claim graph we can measure, and the test for each. Click a row.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table className={s.index}>
          <colgroup>
            <col className={s.cEval} /><col className={s.cProp} /><col className={s.cStatus} /><col className={s.cLast} /><col className={s.cResult} /><col className={s.cCost} />
          </colgroup>
          <thead>
            <tr>
              <th>eval</th>
              <th>property checked</th>
              <th>status</th>
              <th>last run</th>
              <th>result</th>
              <th>cost</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.filter((g) => g.key !== "background").map((g) => {
              const rows = evals.filter((t) => t.group === g.key);
              if (rows.length === 0) return null;
              return [
                <tr key={`g-${g.key}`} className={s.groupRow}><td colSpan={6}>{g.title}</td></tr>,
                ...rows.map((t) => {
                  const r = indexRow(t.slug, d);
                  return (
                    <tr key={t.slug}>
                      <td className={s.name}><Link href={`/docs/evals/${t.slug}`}>{t.title}</Link></td>
                      <td className={s.prop}>{r?.property ?? t.line}</td>
                      <td className={s.dimcell}>
                        <span className={`tag${r?.statusKind === "notyet" ? ` ${s.notyet}` : ""}`}>{r?.status ?? ""}</span>
                      </td>
                      <td className={s.dimcell}>{r?.lastRun ?? ""}</td>
                      <td>{r?.result ?? ""}</td>
                      <td className={s.dimcell}>{r?.cost ?? ""}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>

      <details style={{ margin: "0.4rem 0 1.2rem" }}>
        <summary className="sc" style={{ cursor: "pointer" }}>How they fit together</summary>
        <MapDiagram />
      </details>

      <p className="sc" style={{ margin: "1.6rem 0 0.2rem" }}>Background</p>
      <p className={s.bg}>
        {background.map((t) => (
          <Link key={t.slug} href={`/docs/evals/${t.slug}`}>{t.title}</Link>
        ))}
      </p>
      <p className={s.small} style={{ marginTop: "1.2rem" }}>
        Rendered from files committed to the repository, synced {fmtDate(d.index.syncedAt)} at commit <code>{d.index.gitCommit}</code>. Nothing here reads a live database.
      </p>
    </div>
  );
}
