import Link from "next/link";
import type { BountySummary, PrizeClaimSummary } from "@/lib/types";
import { formatOwls, fmtDate, fmtDateLong } from "@/lib/format";
import {
  BOUNTY_STATUS_LABEL, OWLS_GLOSS, PRIZE_PAYMENT_SENTENCE, PRIZE_TAX_SANCTIONS_NOTICE,
  challengeWindowDays, houseAttemptSentence, isBountyLive, isBountyShown,
  prizeClaimStateLabel, resolutionPhrase, submissionsPhrase,
} from "@/lib/prizes";

// The prize section (docs/mathematics.md §8.3), directly beneath the formal
// statement because the bounty is pinned to the statement, and below the
// verdict, never in the assessment band. It carries, in the graph's voice: the
// offer and what it is for; the house-attempt sentence; the submission count;
// the sentence that separates the prize from the assessment; the one-line
// gloss on what an owl is, with the rules; the button while the prize is
// open; the explanatory paragraph with the owls-only payment terms; the
// server-rendered state sentence; the submissions list with every
// outcome on the record; the house-attempt disclosure; the tax and sanctions
// notice; and the rules version in force. Funder names never appear; Minerval
// is named because the rules require a named sponsor. Rendered only once a
// bounty is live or resolved, never for the pre-confirmation states.
export function Prize({
  claimId, bounty, prizeClaims,
}: {
  claimId: string;
  bounty: BountySummary | null | undefined;
  prizeClaims: PrizeClaimSummary[] | null | undefined;
}) {
  if (!bounty || !isBountyShown(bounty.status)) return null;
  const live = isBountyLive(bounty.status);
  const amount = formatOwls(bounty.amount_micro_usd);
  const attemptSentence = houseAttemptSentence(bounty.attempts ?? []);
  const claims = [...(prizeClaims ?? [])].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const windowDays = challengeWindowDays(bounty.amount_micro_usd);
  const houseAttempts = [...(bounty.attempts ?? [])].sort((a, b) => b.finished_at.localeCompare(a.finished_at));

  return (
    <section className="prize" id="prize">
      <h2>Prize</h2>
      <p className="prize-lead">
        {amount} {live ? "is" : "was"} offered by Minerval for a Lean 4{" "}
        {resolutionPhrase(bounty.resolution)} of the formal statement above,
        checked against Mathlib at the pinned revision.
        {bounty.opened_at && <> {live ? "Open since" : "Opened"} {fmtDateLong(bounty.opened_at)}.</>}
        {attemptSentence && <> {attemptSentence}</>}
        {" "}{submissionsPhrase(bounty.submissions)}
        {" "}Offering a prize does not change how this claim is assessed or how
        important the graph judges it to be; it says only that someone would
        like the question settled.
      </p>
      <p className="prize-gloss" style={{ fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--muted)" }}>
        {OWLS_GLOSS} <Link href="/prizes/rules">The rules →</Link>
      </p>

      {bounty.status === "open" && (
        <p className="prize-cta">
          <Link className="order-button prize-button" href={`/claims/${claimId}/prize/claim`}>
            Claim this prize
          </Link>
        </p>
      )}

      <p className="prize-terms">
        Submit a Lean proof or disproof of the formal statement, a written
        account of the approach, and a note of the tools used. Submissions are
        checked mechanically against the pinned Lean and Mathlib versions, then
        reviewed by the claim&rsquo;s steward for whether the statement proved is
        the statement posted. An accepted submission is announced here and
        becomes payable after a public challenge window of {windowDays} days.
        Entry is free; purchasing owls confers no advantage. The first complete
        submission that passes, by time of receipt, is the one paid; later
        independent proofs are credited on this page. {PRIZE_PAYMENT_SENTENCE}{" "}
        <Link href="/prizes/rules">Rules →</Link>
      </p>

      {bounty.state_sentence && (
        <p className="prize-state" role="status">
          <span className="sc">{BOUNTY_STATUS_LABEL[bounty.status] ?? bounty.status.replace(/_/g, " ")}</span>
          {bounty.state_sentence}
        </p>
      )}

      {bounty.awarded && (
        <p className="prize-state">
          <span className="sc">awarded</span>
          Paid to {bounty.awarded.credit_name} on {fmtDateLong(bounty.awarded.paid_at)}:{" "}
          {formatOwls(bounty.awarded.amount_micro_usd)}.
        </p>
      )}

      {claims.length > 0 && (
        <div className="prize-subs">
          <span className="sc">Submissions</span>
          <ul>
            {claims.map((c) => (
              <li key={c.id}>
                <span className="prize-sub-who">{c.credit_name}</span>
                <span className="prize-sub-meta">
                  {fmtDate(c.submitted_at)} · {c.direction} · {prizeClaimStateLabel(c)}
                  {" · "}
                  <Link href={`/contributions/${c.contribution_id}`}>record</Link>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {houseAttempts.length > 0 && (
        <div className="prize-subs">
          <span className="sc">House attempts</span>
          <ul>
            {houseAttempts.map((a) => (
              <li key={a.id}>
                <span className="prize-sub-who">Minerval&rsquo;s solver</span>
                <span className="prize-sub-meta">
                  {fmtDate(a.finished_at)} · {a.variant === "max" ? "maximum" : "standard"} effort ·{" "}
                  {formatOwls(a.cost_micro_usd)} of compute ·{" "}
                  {a.outcome === "proof" || a.outcome === "disproof"
                    ? `produced a checked ${a.outcome}`
                    : "did not settle it"}
                  {" · "}
                  <Link href={`/claims/${claimId}/attempts/${a.id}`}>report</Link>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="prize-fine">{PRIZE_TAX_SANCTIONS_NOTICE}</p>
      <p className="prize-fine">
        <Link href="/prizes/rules">Rules version {bounty.rules_version}</Link>, in
        force when this prize was posted
        {bounty.expires_at && live && <>; the offer stands until {fmtDateLong(bounty.expires_at)}</>}
        {bounty.withdraw_effective_at && <>; withdrawal takes effect {fmtDateLong(bounty.withdraw_effective_at)}</>}
        . Pinned to{" "}
        <span className="mono" title={`source hash ${bounty.source_hash}`}>
          {bounty.pin_id} · sha256 {bounty.source_hash.slice(0, 12)}…
        </span>
        {bounty.terms_url && /^https?:/.test(bounty.terms_url) && (
          <>
            {" · "}
            <a href={bounty.terms_url} rel="noopener">machine-readable terms ↗&#xFE0E;</a>
          </>
        )}
      </p>
    </section>
  );
}
