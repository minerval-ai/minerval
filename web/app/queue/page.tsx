import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchQueue } from "../../lib/api";
import { OwlMark } from "../../components/OwlMark";

export const metadata: Metadata = {
  title: "The allocation engine · Minerval",
  description:
    "What the background assessment lane will work on next, and exactly why.",
};
export const revalidate = 30;

function num(n: number | null | undefined, digits = 2): string {
  return n == null ? "·" : n.toFixed(digits);
}

// Allocation transparency (§15): the background lane's decision rule, with
// every candidate's expected value broken into its inputs and divided by the
// expected cost of the pass it would get, so "why is this claim ahead of
// that one" is always answerable. Paid orders don't appear here; they run
// immediately, funded by their buyers.
export default async function QueuePage() {
  if (!apiConfigured()) {
    return (
      <div className="col">
        <h1>The allocation engine</h1>
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const queue = await fetchQueue(50);
  if (!queue) {
    return (
      <div className="col">
        <h1>The allocation engine</h1>
        <p>The engine&rsquo;s state is unavailable right now.</p>
      </div>
    );
  }

  const f = queue.formula;
  const costs = queue.cost_estimates;
  const general = queue.general_mandate;

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">the graph at work</p>
      <h1>The allocation engine</h1>
      <p>
        One rule decides what runs, for every funder alike: an assessment
        happens exactly when the owls allocated to it cover its expected
        cost, and the funders split the metered cost in proportion to what
        each put in. Minerval&rsquo;s own General assessment mandate is
        simply the largest funder: each day it backs the candidates with
        the best <strong>expected value per dollar of remaining cost</strong>,
        until its daily rate is committed, so most claims whose value merely
        exceeds their cost still wait their turn behind better ones. Anyone
        can complete a partially backed claim from its page. Money decides
        only when a claim is assessed, never what the assessment concludes.
      </p>

      <div className="usage-chips">
        <span className="summary-chip">{queue.depth.pending} candidates</span>
        <span className="summary-chip">{queue.depth.running} running</span>
        <span className="summary-chip">{queue.depth.done} assessed</span>
        <span className="summary-chip">
          {queue.depth.deferred} deferred (peripheral stubs)
        </span>
        {general && general.daily_rate_owls > 0 && (
          <span className="summary-chip">
            Minerval today: {num(general.allocated_today_owls, 1)} of{" "}
            {num(general.daily_rate_owls, 0)} owls allocated
          </span>
        )}
      </div>

      <p className="meter-caption">
        value = importance × ({f.contestation_floor} + {1 - f.contestation_floor}
        ×contestation) × expected gain, plus {f.user_provenance_boost} if a
        person proposed it; staleness revives expected gain over{" "}
        {f.staleness_saturation_days} days. Estimated cost per pass:{" "}
        {num(costs.standard_owls, 2)} owls
        {costs.strong_min_value != null && (
          <>
            {" "}
            ({num(costs.strong_owls, 2)} on the strong model, used at value ≥{" "}
            {costs.strong_min_value})
          </>
        )}
        . These knobs are the General mandate&rsquo;s allocation policy, set
        and revised by its Grantmaker.
      </p>

      {queue.pending.length === 0 ? (
        <p className="account-empty">No candidates are waiting.</p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>#</th>
              <th>claim</th>
              <th>value / owl</th>
              <th>value</th>
              <th>est. cost</th>
              <th>allocated</th>
              <th>to go</th>
              <th>importance</th>
              <th>gain</th>
              <th>contested</th>
              <th>stale</th>
              <th>proposed</th>
            </tr>
          </thead>
          <tbody>
            {queue.pending.map((p, i) => (
              <tr key={p.claim_id}>
                <td>{i + 1}</td>
                <td>
                  <Link href={`/claims/${p.claim_id}`}>{p.text}</Link>
                </td>
                <td>
                  <strong>{num(p.value_per_owl)}</strong>
                </td>
                <td>{num(p.expected_value)}</td>
                <td>
                  <OwlMark size={13} className="owl-mark" />
                  {num(p.expected_cost_owls)}
                </td>
                <td>
                  {p.allocated_owls > 0 ? (
                    <>
                      <OwlMark size={13} className="owl-mark" />
                      {num(p.allocated_owls)}
                    </>
                  ) : (
                    "·"
                  )}
                </td>
                <td>{p.covered ? "funded" : num(p.remaining_owls)}</td>
                <td>{num(p.inputs.importance)}</td>
                <td>{num(p.inputs.marginal_yield)}</td>
                <td>{num(p.inputs.contestation)}</td>
                <td>
                  {p.inputs.days_since_assessed != null
                    ? `${p.inputs.days_since_assessed}d`
                    : "·"}
                </td>
                <td>{p.inputs.user_proposed ? "by a person" : "·"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
