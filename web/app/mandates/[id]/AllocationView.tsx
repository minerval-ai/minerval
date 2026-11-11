import Link from "next/link";
import {
  fetchMandateAllocation,
  type MandateAllocationView,
} from "../../../lib/api";
import { OwlMark } from "../../../components/OwlMark";
import { Markdown } from "../../../components/Markdown";

/**
 * The mandate's operations: how THIS mandate spends. Its Grantmaker writes
 * an operating policy in prose; its program officers decide what to
 * commission under it, within a limit the policy states; each run is paid
 * for whole and gives back what it does not spend. This section shows the
 * policy, the money, the runs and the decisions, all from the ledger and
 * the decision log.
 */

function owls(n: number): string {
  return Number(n.toFixed(2)).toString();
}

const KIND_LABEL: Record<string, string> = {
  assess: "assessments",
  reassess: "reassessments",
  ingest: "ingestions",
  grant_planning: "mandate planning",
  mandate_review: "mandate reviews",
  lookout_run: "lookout runs",
  correspondent_run: "correspondent runs",
  consistency_sweep: "consistency sweeps",
  curate: "curation",
  audit: "audits",
  formalize: "formal statements",
  attempt_proof: "proof attempts",
  prize_review: "prize reviews",
  request: "work on requests",
  officer_run: "officer sittings",
  grantmaker_decision: "Grantmaker decisions",
};

const STATE_LABEL: Record<string, string> = {
  waiting: "commissioned",
  running: "running",
  settled: "finished",
};

function KindTiles({ view }: { view: MandateAllocationView }) {
  if (view.kinds.length === 0) return null;
  return (
    <div className="alloc-tiles">
      {view.kinds.map((k) => (
        <div className="alloc-tile" key={`${k.kind}-${k.funding}`}>
          <span className="alloc-tile-kind sc">
            {KIND_LABEL[k.kind] ?? k.kind}
            {k.funding === "self_funded" ? " · own upkeep" : ""}
          </span>
          <span className="alloc-tile-big">{k.runs.toLocaleString()}</span>
          <span className="alloc-tile-sub">
            {k.running > 0 ? `${k.running.toLocaleString()} under way · ` : ""}
            {owls(k.spent_owls)} of {owls(k.budget_owls)} owls used
          </span>
        </div>
      ))}
    </div>
  );
}

export async function AllocationSection({ mandateId }: { mandateId: string }) {
  const view = await fetchMandateAllocation(mandateId);
  if (!view) return null;
  const b = view.budget;
  const p = view.petitions;
  return (
    <section>
      <h2>Where the owls go</h2>
      <p className="alloc-lede">
        This mandate pays for work whole. Its Grantmaker writes the operating
        policy below; its program officers decide under it what to commission
        and with what budget, and send what they can&rsquo;t settle to the
        Grantmaker. Each run starts at once with the budget it was given and
        gives back what it does not spend. Agents doing the work may petition
        for more when the work turns out to need it.
      </p>
      <div className="usage-chips">
        <span className="summary-chip">
          <OwlMark size={14} className="owl-mark" />
          {owls(b.used_today_owls)} of {owls(b.daily_rate_owls)} owls of today&rsquo;s rate used
        </span>
        <span className="summary-chip">{owls(b.held_owls)} held by running work</span>
        {b.outside_ledger_owls > 0 && (
          <span className="summary-chip">{owls(b.outside_ledger_owls)} spent outside the ledger</span>
        )}
        <span className="summary-chip">
          officers decide up to {owls(view.officer_limit.owls)} owls
        </span>
        {view.inbox_waiting > 0 && (
          <span className="summary-chip">{view.inbox_waiting} waiting for the officers</span>
        )}
      </div>

      <details className="alloc-top">
        <summary>The operating policy</summary>
        <Markdown>{view.operating_policy}</Markdown>
        <p className="alloc-tail">Officers&rsquo; limit: {view.officer_limit.reason}</p>
        {view.review_pass && (
          <p className="alloc-tail">
            Each review pass works to {owls(view.review_pass.owls)} owls: {view.review_pass.reason}
          </p>
        )}
      </details>

      <KindTiles view={view} />
      <p className="alloc-hist-caption">
        Runs the mandate paid for in the last {view.window_days} days, by kind: the work it
        commissioned, and its own upkeep (its Grantmaker&rsquo;s passes, its lookouts, the sources
        and sweeps its plan names), covered at each run&rsquo;s estimate.
        {p.received > 0 &&
          ` Petitions heard: ${p.received} (${p.granted} granted, ${p.refused} refused, ` +
            `${p.follow_up} follow-ups, ${p.escalated + p.pending} still open).`}
      </p>

      {view.commissions.length > 0 && (
        <details className="alloc-top">
          <summary>The {view.commissions.length} most recent commissions</summary>
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
              {view.commissions.map((c) => (
                <tr key={`${c.action_id}-${c.created_at}`}>
                  <td className="alloc-label">
                    <span className="tag">{c.kind}</span>{" "}
                    {c.claim_id ? <Link href={`/claims/${c.claim_id}`}>{c.label}</Link> : c.label}
                    {c.reason && <span className="alloc-marginal"> — {c.reason}</span>}
                  </td>
                  <td>{c.commissioned_by.replace(/_/g, " ")}</td>
                  <td>{owls(c.budget_owls)}</td>
                  <td>{owls(c.spent_owls)}</td>
                  <td>{STATE_LABEL[c.state] ?? c.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.more > 0 && (
            <p className="alloc-tail">…and {view.more.toLocaleString()} earlier in the window.</p>
          )}
        </details>
      )}

      {view.decisions.length > 0 && (
        <details className="alloc-top">
          <summary>Recent decisions by its officers and Grantmaker</summary>
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
              {view.decisions.map((d, i) => (
                <tr key={i}>
                  <td>{d.decided_by.replace(/_/g, " ")}</td>
                  <td>{d.item_kind.replace(/_/g, " ")}</td>
                  <td>{d.decision.replace(/_/g, " ")}</td>
                  <td>{d.owls != null ? owls(d.owls) : "·"}</td>
                  <td className="alloc-label">{d.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
