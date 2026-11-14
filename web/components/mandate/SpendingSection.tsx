import Link from "next/link";
import type { ReactNode } from "react";
import type { MandateDetailView } from "@/lib/account-api";
import type { MandateAllocationView } from "@/lib/api";
import { owls, words } from "@/lib/account-format";
import { paceWords, windowWords } from "@/lib/mandate-page";

// Where the owls went and what bounds them: one bar a kind of run (used of
// what the runs were given), and beside it the pace, the reserve, what
// running work holds, the officers' limit, the petitions, and who backs it.

const KIND_LABEL: Record<string, string> = {
  assess: "Assessments",
  reassess: "Reassessments",
  ingest: "Sources read",
  grant_planning: "Planning the mandate",
  mandate_review: "Its Grantmaker's sittings",
  lookout_run: "Lookout runs",
  correspondent_run: "Correspondent runs",
  consistency_sweep: "Consistency sweeps",
  curate: "Curation",
  audit: "Audits",
  formalize: "Formal statements",
  attempt_proof: "Proof attempts",
  prize_review: "Prize reviews",
  request: "Work on requests",
  officer_run: "Officers' sittings",
  grantmaker_decision: "Its Grantmaker's decisions",
  research: "Research",
};

const STATE_LABEL: Record<string, string> = {
  waiting: "commissioned",
  running: "running",
  settled: "finished",
};

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="acct-line">
      <span>{label}</span>
      <span className="acct-num">{value}</span>
      {note && <div className="acct-line-under acct-note">{note}</div>}
    </div>
  );
}

export function SpendingSection({
  mandate,
  allocation,
  backing,
}: {
  mandate: MandateDetailView;
  allocation: MandateAllocationView | null;
  /** The form that backs the mandate, where it is open to backing. */
  backing: ReactNode;
}) {
  const b = allocation?.budget ?? null;
  const p = allocation?.petitions ?? null;
  const kinds = allocation?.kinds ?? [];
  const most = Math.max(1, ...kinds.map((k) => k.budget_owls));
  const pace = b?.pace ?? null;

  return (
    <section className="acct-section" id="spending">
      <div className="acct-head">
        <h2>Spending</h2>
        {allocation && (
          <span className="acct-note">
            last {allocation.window_days} days · used of what each run was given
          </span>
        )}
      </div>

      <div className="acct-cols">
        <div className="acct-main">
          {kinds.length === 0 ? (
            <p className="acct-note">
              {allocation ? "It has paid for no runs in this window." : "Its runs are shown while it is live."}
            </p>
          ) : (
            <div className="mnd-kindbars">
              {kinds.map((k) => (
                <div className="mnd-kindbar" key={`${k.kind}-${k.funding}`}>
                  <div className="mnd-kindbar-name">
                    {KIND_LABEL[k.kind] ?? words(k.kind)}
                    {k.funding === "self_funded" && <span className="acct-detail">own upkeep</span>}
                  </div>
                  <div
                    className="mnd-bar mnd-bar-given"
                    style={{ width: `${Math.max(2, (k.budget_owls / most) * 100)}%` }}
                    role="img"
                    aria-label={`${owls(k.spent_owls)} of ${owls(k.budget_owls)} owls used`}
                  >
                    <span style={{ width: `${k.budget_owls > 0 ? Math.min(100, (k.spent_owls / k.budget_owls) * 100) : 0}%` }} />
                  </div>
                  <div className="acct-num">
                    <strong>{owls(k.spent_owls)}</strong> <span className="acct-detail">of {owls(k.budget_owls)}</span>
                  </div>
                  <div className="acct-detail acct-num">
                    {k.runs.toLocaleString("en-US")} run{k.runs === 1 ? "" : "s"}
                    {k.running > 0 ? ` · ${k.running} under way` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}

          {allocation && allocation.commissions.length > 0 && (
            <details className="mnd-more mnd-more-list">
              <summary>The {allocation.commissions.length} most recent commissions</summary>
              <div className="mnd-scroll">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>work</th>
                      <th>by</th>
                      <th>budget</th>
                      <th>used</th>
                      <th>state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocation.commissions.map((c) => (
                      <tr key={`${c.action_id}-${c.created_at}`}>
                        <td className="alloc-label">
                          <span className="tag">{words(c.kind)}</span>{" "}
                          {c.claim_id ? <Link href={`/claims/${c.claim_id}`}>{c.label}</Link> : c.label}
                          {c.reason && <span className="alloc-marginal"> {c.reason}</span>}
                        </td>
                        <td>{words(c.commissioned_by)}</td>
                        <td className="acct-num">{owls(c.budget_owls)}</td>
                        <td className="acct-num">{owls(c.spent_owls)}</td>
                        <td>{STATE_LABEL[c.state] ?? c.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {allocation.more > 0 && (
                <p className="acct-note">and {allocation.more.toLocaleString("en-US")} earlier in the window.</p>
              )}
            </details>
          )}

          {allocation && allocation.decisions.length > 0 && (
            <details className="mnd-more mnd-more-list">
              <summary>Decisions by its officers and Grantmaker, with their reasons</summary>
              <div className="mnd-scroll">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>who</th>
                      <th>on</th>
                      <th>decision</th>
                      <th>owls</th>
                      <th>why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocation.decisions.map((d, i) => (
                      <tr key={i}>
                        <td>{words(d.decided_by)}</td>
                        <td>{words(d.item_kind)}</td>
                        <td>{words(d.decision)}</td>
                        <td className="acct-num">{d.owls != null ? owls(d.owls) : "·"}</td>
                        <td className="alloc-label">{d.reason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {allocation && (
            <p className="acct-note">
              The operating policy its officers spend under is with the <a href="#agents">program officers</a>.
            </p>
          )}
        </div>

        <aside className="acct-side acct-side-wide">
          {b && pace && (
            <>
              <Fact
                label="Pace"
                value={pace.kind === "steady" ? `steady · ${paceWords(pace.owls, pace.period_hours)}` : "as needed"}
                note={
                  pace.kind === "steady"
                    ? `At most that much committed in any ${pace.period_hours === 24 ? "24 hours" : pace.period_hours === 168 ? "week" : `${pace.period_hours} hours`}. Agreed with the funder, who alone can change it.`
                    : "The budget is the only bound on how fast it is committed. Agreed with the funder, who alone can change it."
                }
              />
              {pace.kind === "steady" && (
                <Fact
                  label={`Committed in ${windowWords(pace.period_hours)}`}
                  value={
                    <>
                      <strong>{owls(b.pace_window_used_owls ?? 0)}</strong>{" "}
                      <span className="acct-detail">of {owls(pace.owls)}</span>
                    </>
                  }
                />
              )}
              {b.reserve_owls > 0 && (
                <Fact
                  label="Reserve"
                  value={`${owls(b.reserve_owls)} owls`}
                  note={`Kept back by its Grantmaker, which alone can commit it${b.reserve_reason ? `: ${b.reserve_reason}` : "."}`}
                />
              )}
              <Fact label="Held by running work" value={owls(b.held_owls)} />
              {b.regranted_owls > 0 && <Fact label="Put behind other mandates" value={owls(b.regranted_owls)} />}
              {b.outside_ledger_owls > 0 && (
                <Fact
                  label="Spent outside the ledger"
                  value={owls(b.outside_ledger_owls)}
                  note="Metered to the mandate without a commission: in no kind's bar, and not held to the pace."
                />
              )}
            </>
          )}
          {allocation && (
            <Fact
              label="Officers decide up to"
              value={`${owls(allocation.officer_limit.owls)} owls`}
              note={allocation.officer_limit.reason}
            />
          )}
          {p && p.received > 0 && (
            <Fact
              label="Petitions for more"
              value={
                <>
                  {p.received}{" "}
                  <span className="acct-detail">
                    {p.granted} granted · {p.refused} refused · {p.escalated + p.pending} open
                  </span>
                </>
              }
              note="Running work may ask for more when the work turns out to need it."
            />
          )}

          <h3 className="mnd-h3 mnd-h3-gap">Backers</h3>
          {mandate.contributors.map((c, i) => (
            <div className="acct-line" key={i}>
              <span>
                {c.name}
                {c.is_manager && <span className="acct-detail">manager</span>}
              </span>
              <span className="acct-num">{owls(c.owls)}</span>
            </div>
          ))}
          {mandate.funded_by_mandates.map((m) => (
            <div className="acct-line" key={m.grant_id}>
              <span>
                <Link href={`/mandates/${m.grant_id}`}>{m.title}</Link>
                <span className="acct-detail">mandate</span>
              </span>
              <span className="acct-num">{owls(m.owls)}</span>
            </div>
          ))}
          {mandate.contributors.length + mandate.funded_by_mandates.length === 0 && (
            <p className="acct-note">No one backs it yet.</p>
          )}
          {backing}
        </aside>
      </div>
    </section>
  );
}
