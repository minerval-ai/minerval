import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchQueue } from "../../lib/api";
import { OwlMark } from "../../components/OwlMark";

export const metadata: Metadata = {
  title: "The background lane — Minerval",
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
        <h1>The background lane</h1>
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const queue = await fetchQueue(50);
  if (!queue) {
    return (
      <div className="col">
        <h1>The background lane</h1>
        <p>The lane&rsquo;s state is unavailable right now.</p>
      </div>
    );
  }

  const f = queue.formula;
  const costs = queue.cost_estimates;
  const budget = queue.daily_budget;

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">the graph at work</p>
      <h1>The background lane</h1>
      <p>
        Minerval&rsquo;s own spending follows one standard: the{" "}
        <strong>expected value of an action divided by its expected
        cost</strong>, taken best first until the day&rsquo;s budget is gone.
        There is no queue to wait through. For assessing a claim, expected
        value is estimated as importance times how contested the claim is
        times how much a fresh pass is expected to improve the assessment,
        raised a little by owls users have staked and by human proposal.
        Expected cost is the metered price of the pass at the model tier the
        claim would get. Money can fund an assessment directly (it runs
        immediately, outside this lane) or raise a claim&rsquo;s standing
        here through stakes, but it never touches what the assessment
        concludes.
      </p>

      <div className="usage-chips">
        <span className="summary-chip">{queue.depth.pending} candidates</span>
        <span className="summary-chip">{queue.depth.running} running</span>
        <span className="summary-chip">{queue.depth.done} assessed</span>
        <span className="summary-chip">
          {queue.depth.deferred} deferred (peripheral stubs)
        </span>
        {budget.budget_owls > 0 && (
          <span className="summary-chip">
            today: {num(budget.spent_today_owls, 1)} of {budget.budget_owls}{" "}
            owls spent
          </span>
        )}
      </div>

      <p className="meter-caption">
        value = importance × ({f.contestation_floor} + {1 - f.contestation_floor}
        ×contestation) × expected gain, plus {f.stake_weight}×stakes
        (saturating at {f.stake_saturation_owls} owls) and{" "}
        {f.user_provenance_boost} if a person proposed it; staleness revives
        expected gain over {f.staleness_saturation_days} days. Estimated cost
        per pass: {num(costs.standard_owls, 2)} owls
        {costs.strong_min_value != null && (
          <>
            {" "}
            ({num(costs.strong_owls, 2)} on the strong model, used at value ≥{" "}
            {costs.strong_min_value})
          </>
        )}
        . The lane runs the best value-per-owl first.
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
              <th>importance</th>
              <th>gain</th>
              <th>contested</th>
              <th>stakes</th>
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
                <td>{num(p.inputs.importance)}</td>
                <td>{num(p.inputs.marginal_yield)}</td>
                <td>{num(p.inputs.contestation)}</td>
                <td>
                  {p.inputs.stake_owls > 0 ? (
                    <>
                      <OwlMark size={13} className="owl-mark" />
                      {p.inputs.stake_owls}
                    </>
                  ) : (
                    "·"
                  )}
                </td>
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
