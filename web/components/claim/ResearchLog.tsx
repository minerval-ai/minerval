import type { ResearchRunSummary } from "@/lib/types";
import { formatUsd, fmtDate } from "@/lib/format";
import { modelDisplayName } from "@/lib/model-names";

// The research log (#298): what the claim's Steward has delegated to the
// researcher, disclosed the way solver attempts are: the date, the model,
// the metered cost, and how the run ended. The brief is shown in full; the
// report is the instrument's own narrative to the Steward, weighed there,
// and is not presented to readers as the graph's voice. Renders nothing
// when no run has been launched.

const STATUS_LINE: Record<string, string> = {
  completed: "reported",
  budget: "reached its budget before reporting",
  paused: "paused by the operator",
  timeout: "reached its time cap before reporting",
  refused: "the model declined the task",
  failed: "failed",
  running: "in progress",
};

export function ResearchLog({ runs }: { runs: ResearchRunSummary[] | null | undefined }) {
  if (!runs || runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  return (
    <section>
      <h2>Research</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        Investigations the claim&rsquo;s Steward delegated to the platform&rsquo;s researcher.
        Each is disclosed with its cost; what it found entered the assessment only as
        evidence the Steward weighed.
      </p>
      <ul className="attempt-log">
        {sorted.map((r) => (
          <li key={r.id} className="attempt-row">
            <span className="sc">{fmtDate(r.finished_at ?? r.started_at)}</span>
            <span className="attempt-body">
              {modelDisplayName(r.model)}
              {" · "}
              <span className="mono">{formatUsd(r.spent_micro_usd)}</span> of compute
              {" · "}
              {STATUS_LINE[r.status] ?? r.status}
              <details className="reasoning-detail" style={{ margin: ".3rem 0 0" }}>
                <summary>The brief</summary>
                <p style={{ fontFamily: "var(--sans)", fontSize: ".8rem", color: "var(--ink-soft)", whiteSpace: "pre-wrap", margin: ".4rem 0 0" }}>
                  {r.task}
                </p>
              </details>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
