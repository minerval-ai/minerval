import Link from "next/link";
import type { MandatePrizesView } from "@/lib/account-api";
import type { AttemptSummary } from "@/lib/types";
import { formatOwls } from "@/lib/format";
import { ATTEMPT_VARIANT_LABEL, BOUNTY_STATUS_LABEL, attemptOutcomeLabel } from "@/lib/prizes";
import { OwlMark } from "../OwlMark";

function owls(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function dateish(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "·";
}

// The house solver's attempts under a mandate, newest first, each with its
// cost and its report once published. Its own component because attempts
// belong to mathematics and the section around them to prizes: a deployment
// with prizes off and mathematics on still lists them, under their own
// heading.
export function AttemptsTable({ attempts }: { attempts: AttemptSummary[] }) {
  const sorted = [...attempts].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  return (
    <>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
        The house solver&rsquo;s runs against published statements, each
        public with its cost and its report.
      </p>
      <table className="account-table">
        <thead>
          <tr>
            <th>claim</th>
            <th>finished</th>
            <th>variant</th>
            <th>cost</th>
            <th>outcome</th>
            <th aria-label="report" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id}>
              <td>
                <Link href={`/claims/${a.claim_id}`}>view claim</Link>
                {a.is_calibration && <> <span className="tag">calibration</span></>}
              </td>
              <td>{dateish(a.finished_at ?? a.started_at)}</td>
              <td>{ATTEMPT_VARIANT_LABEL[a.variant] ?? a.variant}</td>
              <td>{formatOwls(a.spent_micro_usd)}</td>
              <td>{attemptOutcomeLabel(a)}</td>
              <td>
                {a.published_at ? (
                  <Link href={`/claims/${a.claim_id}/attempts/${a.id}`}>report</Link>
                ) : (
                  <span style={{ color: "var(--faint)" }}>not yet published</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// The prizes section (docs/mathematics.md §8.1, §8.3): the mandate's prize
// numbers (a bounty is owls held against this mandate's own escrow from the
// day it opens until it resolves, and the payout consumes the hold), the
// house solver's attempts, and the claims with a bounty. Every amount is in
// owls; the sentence under the heading says where the money comes from.
export function PrizesSection({
  prizes, attempts,
}: {
  prizes: MandatePrizesView;
  attempts: AttemptSummary[];
}) {
  return (
    <section className="acct-section" id="prizes">
      <div className="acct-head">
        <h2>Prizes</h2>
      </div>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
        A prize is owls held against this mandate&rsquo;s own escrow from the
        day it opens until it resolves, in the same committed money as its
        attempts and formalizations; the payout consumes the hold. Prizes
        reward proofs and disproofs of formal statements the steward has
        published, and they buy no influence over any assessment.
      </p>
      <div className="alloc-tiles">
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">escrow</span>
          <span className="alloc-tile-big">{formatOwls(prizes.escrow_micro_usd)}</span>
          <span className="alloc-tile-sub">the mandate&rsquo;s budget, every prize&rsquo;s only source</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">held</span>
          <span className="alloc-tile-big">{formatOwls(prizes.held_micro_usd)}</span>
          <span className="alloc-tile-sub">in open prizes</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">paid</span>
          <span className="alloc-tile-big">{formatOwls(prizes.paid_micro_usd)}</span>
          <span className="alloc-tile-sub">in prizes, gross of withholding</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">review reserve</span>
          <span className="alloc-tile-big">{formatOwls(prizes.review_reserve_micro_usd)}</span>
          <span className="alloc-tile-sub">set aside for the review of submissions</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">headroom</span>
          <span className="alloc-tile-big">{formatOwls(prizes.headroom_micro_usd)}</span>
          <span className="alloc-tile-sub">what remains after every hold</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">prizes posted</span>
          <span className="alloc-tile-big">{prizes.bounties_posted.toLocaleString("en-US")}</span>
          <span className="alloc-tile-sub">{formatOwls(prizes.bounties_total_micro_usd)} in all</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">prizes paid</span>
          <span className="alloc-tile-big">{prizes.prizes_paid.toLocaleString("en-US")}</span>
          <span className="alloc-tile-sub">
            <OwlMark size={12} className="owl-mark" />
            {owls(prizes.owls_paid)} owls granted, net of withholding
          </span>
        </div>
      </div>

      {attempts.length > 0 && (
        <>
          <h3>Attempts</h3>
          <AttemptsTable attempts={attempts} />
        </>
      )}

      {prizes.bounties.length > 0 && (
        <>
          <h3>Claims with a prize</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>amount</th>
                <th>status</th>
                <th>open since</th>
                <th>submissions</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {prizes.bounties.map((b) => (
                <tr key={`${b.claim_id}-${b.opened_at ?? ""}`}>
                  <td className="alloc-label">
                    <Link href={`/claims/${b.claim_id}`}>{b.text}</Link>
                  </td>
                  <td>{formatOwls(b.amount_micro_usd)}</td>
                  <td>{BOUNTY_STATUS_LABEL[b.status] ?? String(b.status).replace(/_/g, " ")}</td>
                  <td>{dateish(b.opened_at)}</td>
                  <td>{b.submissions}</td>
                  <td>{b.outcome ? b.outcome.replace(/_/g, " ") : "·"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

