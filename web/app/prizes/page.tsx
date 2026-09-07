import type { Metadata } from "next";
import Link from "next/link";
import { loadOpenPrizes } from "@/lib/data";
import { formatOwls, fmtDate } from "@/lib/format";
import {
  BOUNTY_STATUS_LABEL, PRIZE_PAYMENT_SENTENCE, houseAttemptSentence, resolutionPhrase,
  submissionsPhrase,
} from "@/lib/prizes";
import { claimTypeMeta, DEFINED_IN } from "@/lib/ontology";
import { StatusBadge, Unassessed } from "@/components/Assessment";
import { MachineChecked } from "@/components/claim/MachineChecked";
import { Term } from "@/components/Term";

// The prize listing (docs/mathematics.md §8.3, §11.1): every open bounty
// across the graph, largest first, from GET /prizes. A browse surface, not a
// leaderboard: each entry says what is offered, for what, since when, and
// what has been tried, and opens on the claim page where the prize section
// carries the rest.

export const metadata: Metadata = {
  title: "Prizes · Minerval",
  description:
    "Open prizes for machine-checked proofs and disproofs of formal statements on the claim graph, largest first.",
};
export const dynamic = "force-dynamic";

export default async function PrizesPage() {
  const { prizes, mandates, source } = await loadOpenPrizes(100);

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Prizes</p>
      <h1>Open prizes</h1>
      <p className="lede" style={{ fontSize: "1.05rem" }}>
        Each prize is offered for a Lean 4 proof or disproof of one claim&rsquo;s
        published formal statement, checked by a machine against Mathlib at a
        pinned revision and reviewed by the claim&rsquo;s steward for whether the
        statement proved is the statement posted. Offering a prize does not
        change how a claim is assessed or how important the graph judges it to
        be; it says only that someone would like the question settled.
      </p>
      <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)", marginTop: "-1rem" }}>
        {PRIZE_PAYMENT_SENTENCE}{" "}
        <Link href="/prizes/rules">The rules →</Link>
      </p>

      {source === "fixture" && (
        <p style={{ marginBottom: "1.2rem" }}>
          <span className="tag" title="The API is not connected; showing a design fixture.">
            fixture data
          </span>
        </p>
      )}

      {prizes.length === 0 ? (
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)" }}>
          No prizes are open right now. A prize appears here when a
          mandate&rsquo;s Grantmaker posts one, from that mandate&rsquo;s own
          escrow, on a claim whose formal statement has passed its public
          review period.
        </p>
      ) : (
        <div className="cards">
          {prizes.map((p) => {
            const kind = claimTypeMeta(p.claim_type);
            const href = `/claims/${p.claim_id}`;
            const attempt = houseAttemptSentence(p.bounty.attempts ?? []);
            return (
              <div className="card prize-card" key={p.claim_id}>
                <Link href={href} className="card-link">
                  <div className="card-claim">{p.text}</div>
                </Link>
                <p className="prize-card-offer">
                  <span className="prize-card-amount">{formatOwls(p.bounty.amount_micro_usd)}</span>
                  {" "}for a {resolutionPhrase(p.bounty.resolution)}
                  {p.bounty.opened_at && <> · open since {fmtDate(p.bounty.opened_at)}</>}
                  {" · "}{submissionsPhrase(p.bounty.submissions).replace(/\.$/, "").toLowerCase()}
                  {" · "}<span className="mono">{p.bounty.pin_id}</span>
                </p>
                {attempt && <p className="prize-card-attempt">{attempt}</p>}
                <div className="card-foot">
                  {p.assessment_status ? <StatusBadge status={p.assessment_status} linkTo={href} /> : <Unassessed linkTo={href} />}
                  {kind ? (
                    <Term gloss={kind.gloss} href={DEFINED_IN.claimType} linkTo={href} className="tag kind">
                      {kind.label}
                    </Term>
                  ) : (
                    <span className="tag kind">{p.claim_type?.replace(/_/g, " ")}</span>
                  )}
                  {p.checked && <MachineChecked kind={p.checked} size="sm" linkTo={href} />}
                  <span style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--muted)" }}>
                    {BOUNTY_STATUS_LABEL[p.bounty.status] ?? p.bounty.status}
                    {p.bounty.status === "open" && (
                      <>
                        {" · "}
                        <Link href={`/claims/${p.claim_id}/prize/claim`} style={{ position: "relative", zIndex: 1 }}>
                          claim this prize →
                        </Link>
                      </>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mandates.length > 0 && (
        <>
          <hr className="thin" />
          <h2 style={{ fontSize: "1.05rem" }}>Where the prizes come from</h2>
          <p style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)", maxWidth: "44rem" }}>
            A prize is owls held against the escrow of the mandate whose
            Grantmaker posted it, from the day it opens until it resolves; the
            payout consumes the hold. Each mandate&rsquo;s numbers are derived,
            never stored, and a bounty opens only when the headroom covers it.
          </p>
          <table className="account-table">
            <thead>
              <tr>
                <th>mandate</th>
                <th>escrow</th>
                <th>held in open prizes</th>
                <th>paid in prizes</th>
                <th>review reserve</th>
                <th>headroom</th>
                <th>open</th>
              </tr>
            </thead>
            <tbody>
              {mandates.map((m) => (
                <tr key={m.grant_id}>
                  <td className="alloc-label"><Link href={`/mandates/${m.grant_id}`}>{m.title}</Link></td>
                  <td>{formatOwls(m.escrow_micro_usd)}</td>
                  <td>{formatOwls(m.held_micro_usd)}</td>
                  <td>{formatOwls(m.paid_micro_usd)}</td>
                  <td>{formatOwls(m.review_reserve_micro_usd)}</td>
                  <td>{formatOwls(m.headroom_micro_usd)}</td>
                  <td>{m.open_bounties}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".74rem", color: "var(--faint)" }}>
        Prizes are offered by Minerval, the sole obligor, in owls held against
        the escrow of the mandate that posted each one; no mandate promises
        the same owl to a prize and to an attempt. Every attempt by
        Minerval&rsquo;s own solver on a prized statement is public with its
        cost and its report before the prize opens, so an outside claimant
        knows what has been tried.
      </p>
    </div>
  );
}
