import Link from "next/link";
import type { AttemptSummary } from "@/lib/types";
import { formatUsd, fmtDate } from "@/lib/format";
import { ATTEMPT_VARIANT_LABEL, attemptOutcomeLabel } from "@/lib/prizes";

// The attempt log (docs/mathematics.md §7.7): what Minerval's own solver has
// tried against the formal statement. Every attempt is public, with its date,
// its variant, its metered cost, and its outcome, and each links to the page
// that carries its report and notebook once the Steward has acted on it. The
// disclosure removes the information asymmetry between the platform and an
// outside claimant, and the prize rules require it. Renders nothing when no
// attempt has run.
export function AttemptLog({
  claimId, attempts,
}: {
  claimId: string;
  attempts: AttemptSummary[] | null | undefined;
}) {
  if (!attempts || attempts.length === 0) return null;
  const sorted = [...attempts].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  return (
    <section>
      <h2>Attempts</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem" }}>
        What Minerval&rsquo;s own solver has tried against the formal statement.
        Every attempt is public with its cost and its report, so that anyone
        working on the question knows what has been tried.
      </p>
      <ul className="attempt-log">
        {sorted.map((a) => (
          <li key={a.id} className="attempt-row">
            <span className="sc">{fmtDate(a.finished_at ?? a.started_at)}</span>
            <span className="attempt-body">
              {ATTEMPT_VARIANT_LABEL[a.variant] ?? a.variant}
              {" · "}
              <span className="mono">{formatUsd(a.spent_micro_usd)}</span> of compute
              {" · "}
              {attemptOutcomeLabel(a)}
              {a.is_calibration && (
                <>
                  {" "}
                  <span
                    className="tag"
                    title="A calibration run: the solver against a theorem with a known proof, so its record on open problems has a baseline."
                  >
                    calibration
                  </span>
                </>
              )}
              {" "}
              {a.published_at ? (
                <Link href={`/claims/${claimId}/attempts/${a.id}`}>report →</Link>
              ) : (
                <em style={{ color: "var(--faint)" }}>report not yet published</em>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
