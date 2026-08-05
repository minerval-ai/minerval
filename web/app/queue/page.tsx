import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchQueue } from "../../lib/api";
import { OwlMark } from "../../components/OwlMark";

export const metadata: Metadata = {
  title: "Assessment queue — Minerval",
  description:
    "What the background assessment lane is working on next, and exactly why.",
};
export const revalidate = 30;

function num(n: number | null | undefined, digits = 2): string {
  return n == null ? "—" : n.toFixed(digits);
}

// Queue transparency (§15): the background lane's ordering, with every
// priority broken into its inputs so "why is this claim ahead of that one"
// is always answerable. Paid orders don't appear here — they run on the
// express lane, immediately, outside this queue.
export default async function QueuePage() {
  if (!apiConfigured()) {
    return (
      <div className="col">
        <h1>Assessment queue</h1>
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const queue = await fetchQueue(50);
  if (!queue) {
    return (
      <div className="col">
        <h1>Assessment queue</h1>
        <p>The queue is unavailable right now.</p>
      </div>
    );
  }

  const w = queue.weights;

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">the graph at work</p>
      <h1>Assessment queue</h1>
      <p>
        Claims wait here for the background assessment lane, ordered by a{" "}
        <strong>composite priority</strong>: how much the claim is worth
        getting right (importance), how much another pass is expected to
        yield, how contested it is, the owls users have staked on it, how
        stale its current assessment is, and whether a person proposed it.
        The formula and its weights are public — money can buy a claim{" "}
        <em>position</em> in this queue (or skip it entirely with a paid
        assessment, which runs immediately), but never its verdict.
      </p>

      <div className="usage-chips">
        <span className="summary-chip">{queue.depth.pending} waiting</span>
        <span className="summary-chip">{queue.depth.running} running</span>
        <span className="summary-chip">{queue.depth.done} assessed</span>
        <span className="summary-chip">
          {queue.depth.deferred} deferred (peripheral stubs)
        </span>
      </div>

      <p className="meter-caption">
        priority = importance + {w.yield}×yield + {w.contestation}
        ×contestation + {w.stake}×stakes (saturating at{" "}
        {w.stake_saturation_owls} owls) + {w.staleness}×staleness (saturating
        at {w.staleness_saturation_days} days) + {w.user_provenance_boost} if
        user-proposed
      </p>

      {queue.pending.length === 0 ? (
        <p className="account-empty">The queue is empty.</p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>#</th>
              <th>claim</th>
              <th>priority</th>
              <th>importance</th>
              <th>yield</th>
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
                  <strong>{num(p.queue_priority)}</strong>
                </td>
                <td>{num(p.inputs.importance)}</td>
                <td>{num(p.inputs.marginal_yield)}</td>
                <td>{num(p.inputs.contestation)}</td>
                <td>
                  {p.inputs.stake_owls > 0 ? (
                    <>
                      <OwlMark size={14} className="owl-mark" />
                      {p.inputs.stake_owls} owls
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {p.inputs.days_since_assessed != null
                    ? `${p.inputs.days_since_assessed}d`
                    : "—"}
                </td>
                <td>{p.inputs.user_proposed ? "by a person" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
