import Link from "next/link";
import {
  fetchMandateAllocation,
  type MandateAllocationView,
} from "../../../lib/api";
import { OwlMark } from "../../../components/OwlMark";

/**
 * The mandate's allocation section: how THIS mandate is judging and
 * funding the open actions. Aggregation first — kind tiles and a
 * value-per-owl histogram with the day's bar — then drill-down on demand;
 * the tail is summarized, never enumerated. Transparency through
 * navigability: at graph scale a flat table of every potential action
 * would hide more than it shows.
 */

function owls(n: number): string {
  return Number(n.toFixed(2)).toString();
}

const KIND_LABEL: Record<string, string> = {
  assess: "first assessments",
  reassess: "reassessments",
  ingest: "ingestions",
  grant_planning: "mandate planning",
  mandate_review: "mandate reviews",
  // mathematics (docs/mathematics.md §8.3): compute, not prize money
  formalize: "formal statements",
  attempt_proof: "proof attempts",
  prize_review: "prize reviews",
};

function KindTiles({ view }: { view: MandateAllocationView }) {
  return (
    <div className="alloc-tiles">
      {view.kinds.map((k) => (
        <div className="alloc-tile" key={k.kind}>
          <span className="alloc-tile-kind sc">{KIND_LABEL[k.kind] ?? k.kind}</span>
          <span className="alloc-tile-big">{k.candidates.toLocaleString()}</span>
          <span className="alloc-tile-sub">
            {k.valued.toLocaleString()} valued · {k.covered.toLocaleString()}{" "}
            covered
          </span>
          <span className="alloc-tile-sub">
            {owls(k.allocated_owls)}{" "}
            {k.allocated_owls === 1 ? "owl" : "owls"} allocated ·{" "}
            {owls(k.est_total_cost_owls)} to do it all
          </span>
        </div>
      ))}
    </div>
  );
}

// The value-per-owl distribution as CSS bars, the day's bar marked where
// it falls: everything to the marker's right cleared today's threshold.
function ValueHistogram({ view }: { view: MandateAllocationView }) {
  const buckets = view.histogram;
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bar = view.budget.today_bar;
  const upper = buckets[buckets.length - 1]?.max ?? 0;
  const barPct =
    bar != null && upper > 0
      ? Math.min(100, Math.max(0, (bar / upper) * 100))
      : null;
  return (
    <div className="alloc-hist-wrap">
      <div className="alloc-hist" aria-hidden>
        {barPct != null && (
          <span
            className="alloc-hist-bar-marker"
            style={{ left: `${barPct}%` }}
            title={`today's bar: ${bar} value per owl`}
          />
        )}
        {buckets.map((b, i) => (
          <span
            key={i}
            className="alloc-hist-col"
            style={{ height: `${6 + Math.round((b.count / max) * 40)}px` }}
            data-empty={b.count === 0 ? "" : undefined}
            title={`${b.min}–${b.max} value/owl: ${b.count} action${b.count === 1 ? "" : "s"}`}
          />
        ))}
      </div>
      <p className="alloc-hist-caption">
        Expected value per owl across the{" "}
        {total.toLocaleString()} action{total === 1 ? "" : "s"} this mandate
        has valued
        {bar != null
          ? `; the marker is today's bar (${bar} value/owl) — the marginal return of the last increment funded. Below it, an action waits for co-funding or a cheaper day.`
          : "; no allocations placed yet today, so the day's bar has not formed."}
      </p>
    </div>
  );
}

export async function AllocationSection({ mandateId }: { mandateId: string }) {
  const view = await fetchMandateAllocation(mandateId);
  if (!view || view.kinds.length === 0) return null;
  const b = view.budget;
  return (
    <section>
      <h2>Where the owls go</h2>
      <p className="alloc-lede">
        The judgment is this mandate&rsquo;s own: it values the actions it
        knows and cares about, ranks them by expected value per owl of
        remaining cost, and allocates its daily rate best-first. An action
        runs the moment allocations — from any mix of mandates and readers
        — cover its cost, and the metered cost splits pro rata. Where
        alternatives conflict (a standard or a strong-model pass), the
        upgrade is bought only when its marginal return clears the bar.
      </p>
      <div className="usage-chips">
        <span className="summary-chip">
          <OwlMark size={14} className="owl-mark" />
          {owls(b.daily_rate_owls)} owls/day rate
        </span>
        <span className="summary-chip">
          {owls(b.allocated_today_owls)} allocated today
        </span>
        {b.today_bar != null && (
          <span className="summary-chip">bar: {b.today_bar} value/owl</span>
        )}
      </div>

      <KindTiles view={view} />
      <ValueHistogram view={view} />

      {view.top.length > 0 && (
        <details className="alloc-top">
          <summary>
            The {view.top.length} actions this mandate ranks highest
          </summary>
          <table className="account-table">
            <thead>
              <tr>
                <th>action</th>
                <th>variant</th>
                <th>value</th>
                <th>cost</th>
                <th>value/owl</th>
                <th>backing</th>
              </tr>
            </thead>
            <tbody>
              {view.top.map((a) => (
                <tr key={a.action_id}>
                  <td className="alloc-label">
                    <span className="tag">{a.kind}</span>{" "}
                    {a.claim_id ? (
                      <Link href={`/claims/${a.claim_id}`}>{a.label}</Link>
                    ) : (
                      a.label
                    )}
                  </td>
                  <td>
                    {a.variant}
                    {a.marginal_ratio != null && (
                      <span
                        className="alloc-marginal"
                        title="the marginal return of upgrading from the cheaper variant"
                      >
                        {" "}
                        Δ{a.marginal_ratio}/owl
                      </span>
                    )}
                  </td>
                  <td>{a.value_est}</td>
                  <td>{owls(a.cost_owls)}</td>
                  <td>{a.value_per_owl}</td>
                  <td>
                    {a.covered
                      ? "covered — will run"
                      : a.backing_owls > 0
                        ? `${owls(a.backing_owls)} owls so far`
                        : "·"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.more > 0 && (
            <p className="alloc-tail">
              …and {view.more.toLocaleString()} more valued actions below,
              most of them under today&rsquo;s bar. They are not lost:
              anyone&rsquo;s allocation can cover one at any time.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
