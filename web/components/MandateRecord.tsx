import Link from "next/link";
import { fetchAttemptStats } from "@/lib/api";
import type { AttemptStats, RecordOutcome } from "@/lib/types";
import { fmtDate } from "@/lib/format";
import { ATTEMPT_VARIANT_LABEL } from "@/lib/prizes";
import { OwlMark } from "./OwlMark";

// The Record block on a Mathematics mandate's page (docs/mathematics.md
// §7.10): the platform keeps score on itself. The numbers are the mandate's
// attempts read straight off the ledger: by outcome and by variant the count,
// the owls spent, and the median cost; the calibration series on settled
// problems with its pass rate and cost per pass; the Grantmaker's stated
// probability against the realized rate when one is stored; and the novel
// proofs listed apart from rediscoveries. A server component: it fetches its
// own numbers, and renders a short sentence rather than nothing when no
// attempt has closed yet.

const OUTCOME_LABEL: Record<RecordOutcome, string> = {
  proved: "checked proof",
  disproved: "checked disproof",
  lead: "lead, not settled",
  no_result: "no result",
  refused: "refused",
  cancelled: "cancelled",
  error: "error",
  withheld: "outcome withheld",
};

const OUTCOME_TITLE: Partial<Record<RecordOutcome, string>> = {
  lead: "A partial result or a reduction: something the Steward may act on, never a status change on its own.",
  withheld: "An unpublished result on a claim with a live prize: nothing is shown, not even the outcome, until the Steward has decided.",
};

function owls(n: number): string {
  return Number(n.toFixed(3)).toLocaleString("en-US");
}

function owlsOrDot(n: number | null): string {
  return n === null ? "·" : owls(n);
}

function pct(r: number | null): string {
  return r === null ? "·" : `${Math.round(r * 100)}%`;
}

function SolveTable({ items }: { items: AttemptStats["novel_proofs"]["items"] }) {
  return (
    <table className="account-table">
      <thead>
        <tr>
          <th>claim</th>
          <th>finished</th>
          <th>variant</th>
          <th>outcome</th>
          <th>cost</th>
          <th aria-label="report" />
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <tr key={s.attempt_id}>
            <td className="alloc-label">
              <Link href={`/claims/${s.claim_id}`}>{s.claim_text}</Link>
            </td>
            <td>{fmtDate(s.finished_at)}</td>
            <td>{ATTEMPT_VARIANT_LABEL[s.variant as "standard" | "max"] ?? s.variant}</td>
            <td>{s.outcome === "proof" ? "checked proof" : "checked disproof"}</td>
            <td>{owls(s.owls_spent)} owls</td>
            <td>
              <Link href={`/claims/${s.claim_id}/attempts/${s.attempt_id}`}>report</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function MandateRecord({ grantId }: { grantId: string }) {
  const stats = await fetchAttemptStats(grantId);
  if (!stats) return null;
  const { totals } = stats;
  const series = stats.calibration_series;

  return (
    <section>
      <h2>Record</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
        The platform is never a claimant, and it keeps score on itself. These
        are this mandate&rsquo;s attempts as the ledger recorded them: what
        each closed with, what it cost, and which results were new.
      </p>

      {totals.attempts === 0 ? (
        <p className="order-line">
          No attempt has closed yet
          {totals.live > 0 && <> ({totals.live} running)</>}.
        </p>
      ) : (
        <>
          <div className="alloc-tiles">
            <div className="alloc-tile">
              <span className="alloc-tile-kind sc">attempts closed</span>
              <span className="alloc-tile-big">{totals.attempts.toLocaleString("en-US")}</span>
              <span className="alloc-tile-sub">
                {totals.live > 0 ? `${totals.live} running now` : "none running"}
              </span>
            </div>
            <div className="alloc-tile">
              <span className="alloc-tile-kind sc">owls spent</span>
              <span className="alloc-tile-big">
                <OwlMark size={14} className="owl-mark" />
                {owls(totals.owls_spent)}
              </span>
              <span className="alloc-tile-sub">
                median {owlsOrDot(totals.median_cost_owls)} owls an attempt
              </span>
            </div>
            <div className="alloc-tile">
              <span className="alloc-tile-kind sc">novel proofs</span>
              <span className="alloc-tile-big">{stats.novel_proofs.count.toLocaleString("en-US")}</span>
              <span className="alloc-tile-sub">
                {stats.rediscoveries.count} rediscover{stats.rediscoveries.count === 1 ? "y" : "ies"}
              </span>
            </div>
            <div className="alloc-tile">
              <span className="alloc-tile-kind sc">calibration</span>
              <span className="alloc-tile-big">{pct(series.pass_rate)}</span>
              <span className="alloc-tile-sub">
                {series.attempts === 0
                  ? "no calibration runs"
                  : `${series.passes} of ${series.attempts} settled problems passed`}
              </span>
            </div>
          </div>

          <h3>By outcome</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>outcome</th>
                <th>attempts</th>
                <th>owls spent</th>
                <th>median cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.by_outcome.map((o) => (
                <tr key={o.outcome}>
                  <td title={OUTCOME_TITLE[o.outcome]}>{OUTCOME_LABEL[o.outcome] ?? o.outcome}</td>
                  <td>{o.count}</td>
                  <td>{owls(o.owls_spent)}</td>
                  <td>{owlsOrDot(o.median_cost_owls)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>By variant</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>variant</th>
                <th>attempts</th>
                <th>settled</th>
                <th>owls spent</th>
                <th>median cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.by_variant.map((v) => (
                <tr key={v.variant}>
                  <td>{ATTEMPT_VARIANT_LABEL[v.variant as "standard" | "max"] ?? v.variant}</td>
                  <td>{v.count}</td>
                  <td>{v.settled}</td>
                  <td>{owls(v.owls_spent)}</td>
                  <td>{owlsOrDot(v.median_cost_owls)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {series.problems.length > 0 && (
            <>
              <h3>Calibration series</h3>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
                Settled problems the solver was run against before any open
                one, so its record has a baseline: {series.passes} of{" "}
                {series.attempts} runs passed
                {series.cost_per_pass_owls !== null && (
                  <>, at {owls(series.cost_per_pass_owls)} owls a pass</>
                )}
                .
              </p>
              <table className="account-table">
                <thead>
                  <tr>
                    <th>problem</th>
                    <th>runs</th>
                    <th>passed</th>
                    <th>pass rate</th>
                    <th>owls spent</th>
                    <th>cost per pass</th>
                    <th>last run</th>
                  </tr>
                </thead>
                <tbody>
                  {series.problems.map((p) => (
                    <tr key={p.claim_id}>
                      <td className="alloc-label">
                        <Link href={`/claims/${p.claim_id}`}>{p.claim_text}</Link>
                        {" "}
                        <span className="tag">calibration</span>
                      </td>
                      <td>{p.attempts}</td>
                      <td>{p.passes}</td>
                      <td>{pct(p.pass_rate)}</td>
                      <td>{owls(p.owls_spent)}</td>
                      <td>{owlsOrDot(p.cost_per_pass_owls)}</td>
                      <td>{fmtDate(p.last_finished_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {stats.calibration && stats.calibration.deciles.length > 0 && (
            <>
              <h3>Stated probability against the realized rate</h3>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
                What the Grantmaker said an attempt&rsquo;s chance was when it
                scheduled it, against how often attempts in that band settled
                the claim.
              </p>
              <table className="account-table">
                <thead>
                  <tr>
                    <th>stated</th>
                    <th>attempts</th>
                    <th>settled</th>
                    <th>realized</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.calibration.deciles.map((d) => (
                    <tr key={d.decile}>
                      <td>
                        {Math.round(d.stated_low * 100)}% to {Math.round(d.stated_high * 100)}%
                      </td>
                      <td>{d.attempts}</td>
                      <td>{d.successes}</td>
                      <td>{pct(d.realized_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {stats.novel_proofs.items.length > 0 && (
            <>
              <h3>Novel proofs</h3>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
                House solves of claims that were open with no published proof
                when the attempt closed.
              </p>
              <SolveTable items={stats.novel_proofs.items} />
            </>
          )}

          {stats.rediscoveries.items.length > 0 && (
            <>
              <h3>Rediscoveries</h3>
              <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
                House solves of claims already settled, the calibration runs
                among them. A rediscovery says what the instrument can do; it
                is not a result.
              </p>
              <SolveTable items={stats.rediscoveries.items} />
            </>
          )}
        </>
      )}
    </section>
  );
}
