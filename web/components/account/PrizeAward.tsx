"use client";

import { useState } from "react";
import Link from "next/link";
import type { OpenPrizeClaim } from "@/lib/types";
import { formatUsd, fmtDate, fmtDateLong, daysUntil } from "@/lib/format";
import { PRIZE_PAYEE_STEPS_DAYS, prizeClaimNextStep, prizeClaimStateLabel } from "@/lib/prizes";

// "Your prize" (docs/mathematics.md §8.7): what the winner sees on the account
// page once a prize claim is payable. The amount; what owls are; that they are
// non-transferable, non-refundable, and never redeemable for cash; that the
// prize is reported for tax at its dollar value; and the three steps to
// complete within ninety days: identity and residency, a tax form, and the
// sanctions screening the operator records. The sign-off checklist requires
// all three before any owl is granted. Live claims in earlier states are
// listed beneath with their next step.

const WINNER_STATES = new Set<OpenPrizeClaim["status"]>([
  "payable", "defect_award_pending", "paid", "forfeited",
]);
const LIVE_STATES = new Set<OpenPrizeClaim["status"]>([
  "queued", "checking", "check_error", "checked", "in_review", "in_challenge_window",
]);

function PayeeForm({ claim }: { claim: OpenPrizeClaim }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    claim.payee_status === "submitted" || claim.payee_status === "verified" ? "done" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/prize-claims/${encodeURIComponent(claim.id)}/payee`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legal_name: data.get("legal_name"),
          address: data.get("address"),
          country: data.get("country"),
          us_person: data.get("us_person") === "yes",
          code: data.get("code"),
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) setState("done");
      else {
        setState("error");
        setError(body?.error ?? "The details could not be recorded.");
      }
    } catch {
      setState("error");
      setError("The details could not be recorded. Please try again.");
    }
  }

  if (state === "done") {
    return (
      <p className="prize-step-done" role="status">
        Identity and residency recorded{claim.payee_status === "verified" ? " and verified" : "; verification follows"}.
      </p>
    );
  }
  return (
    <form className="prize-step-form" onSubmit={onSubmit}>
      <label className="contribute-label" htmlFor={`legal-${claim.id}`}>Legal name</label>
      <input className="contribute-field" id={`legal-${claim.id}`} name="legal_name" maxLength={120} required />
      <label className="contribute-label" htmlFor={`addr-${claim.id}`}>Postal address</label>
      <textarea className="contribute-field" id={`addr-${claim.id}`} name="address" rows={3} maxLength={400} required />
      <label className="contribute-label" htmlFor={`country-${claim.id}`}>Country of residence</label>
      <input className="contribute-field" id={`country-${claim.id}`} name="country" maxLength={80} required />
      <label className="contribute-label">U.S. person for tax purposes?</label>
      <div className="prize-form-radios">
        <label><input type="radio" name="us_person" value="yes" required /> yes</label>
        <label><input type="radio" name="us_person" value="no" /> no</label>
      </div>
      <label className="contribute-label" htmlFor={`code-${claim.id}`}>One-time code</label>
      <input className="contribute-field mono" id={`code-${claim.id}`} name="code" maxLength={16} autoComplete="one-time-code" required />
      <p className="contribute-hint">
        The code was emailed to this account&rsquo;s address when the prize became payable. It is
        asked for so that a leaked API key can never redirect a prize.
      </p>
      <div className="contribute-actions">
        <button className="signin-button" type="submit" disabled={state === "busy"}>
          {state === "busy" ? "Recording…" : "Record identity and residency"}
        </button>
      </div>
      {error && <p className="contribute-error">{error}</p>}
    </form>
  );
}

function TaxFormUpload({ claim }: { claim: OpenPrizeClaim }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    claim.tax_form_status === "received" ? "done" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Attach the completed form.");
      return;
    }
    data.set("kind", "tax_form");
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/prize-claims/${encodeURIComponent(claim.id)}/tax-form`, {
        method: "POST",
        body: data,
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) setState("done");
      else {
        setState("error");
        setError(body?.error ?? "The form could not be uploaded.");
      }
    } catch {
      setState("error");
      setError("The form could not be uploaded. Please try again.");
    }
  }

  if (state === "done") {
    return <p className="prize-step-done" role="status">Tax form received. It is stored as a restricted attachment and never published.</p>;
  }
  return (
    <form className="prize-step-form" onSubmit={onSubmit}>
      <label className="contribute-label">Form</label>
      <div className="prize-form-radios">
        <label><input type="radio" name="form_kind" value="w9" defaultChecked /> W-9 (U.S. person)</label>
        <label><input type="radio" name="form_kind" value="w8ben" /> W-8BEN (everyone else)</label>
      </div>
      <input className="contribute-field" type="file" name="file" accept=".pdf,application/pdf" required />
      <p className="contribute-hint">
        A PDF, at most 10 MiB. Without a valid taxpayer identification number on a W-9, backup
        withholding of 24 percent applies; on a W-8BEN, 30 percent withholding applies unless a
        treaty or a foreign-source position reduces it.
      </p>
      <div className="contribute-actions">
        <button className="signin-button" type="submit" disabled={state === "busy"}>
          {state === "busy" ? "Uploading…" : "Upload the tax form"}
        </button>
      </div>
      {error && <p className="contribute-error">{error}</p>}
    </form>
  );
}

function Award({ claim }: { claim: OpenPrizeClaim }) {
  const amount = formatUsd(claim.amount_micro_usd);
  const owls = Math.floor(claim.amount_micro_usd / 1_000_000);
  const daysLeft = daysUntil(claim.payee_deadline_at);
  return (
    <div className="prize-award">
      <p className="sc">Your prize</p>
      <p className="prize-award-lead">
        <strong>{amount}</strong> for the{" "}
        {claim.status === "defect_award_pending" ? "statement defect your submission exposed on" : `${claim.direction} you submitted of`}{" "}
        <Link href={`/claims/${claim.claim_id}`}>{claim.claim_text}</Link>
        {claim.status === "paid" ? (
          <>, paid{claim.paid_at ? ` on ${fmtDateLong(claim.paid_at)}` : ""}.</>
        ) : claim.status === "forfeited" ? (
          <>. {prizeClaimNextStep(claim)}</>
        ) : (
          <>, payable since {fmtDateLong(claim.window_ends_at)}.</>
        )}
      </p>
      <p>
        The prize is paid in owls, one owl per dollar: {owls.toLocaleString("en-US")} owls, less any
        withholding the law requires. Owls are Minerval&rsquo;s unit of account for metered work on
        the graph: assessments, deeper passes, and mandates you direct. They do not expire, cannot be
        transferred, are not refundable, and are never redeemable for cash. The prize is reported for
        tax at its dollar value.
      </p>
      {(claim.status === "payable" || claim.status === "defect_award_pending") && (
        <>
          <p>
            Three steps, to be completed within {PRIZE_PAYEE_STEPS_DAYS} days
            {claim.payee_deadline_at && (
              <>
                , by {fmtDateLong(claim.payee_deadline_at)}
                {daysLeft != null && <> ({daysLeft} day{daysLeft === 1 ? "" : "s"} left)</>}
              </>
            )}
            . A prize whose steps are not completed in time lapses, and the reservation returns to the fund.
          </p>
          <ol className="prize-steps">
            <li>
              <span className="prize-step-title">Identity and residency</span>
              <PayeeForm claim={claim} />
            </li>
            <li>
              <span className="prize-step-title">Tax form</span>
              <TaxFormUpload claim={claim} />
            </li>
            <li>
              <span className="prize-step-title">Screening</span>
              <p className="prize-step-note">
                Recorded by the operator: every payee is screened against the OFAC sanctions
                lists before payment, and the result is recorded on the payout.
                {claim.screening_status === "cleared" && " Cleared."}
                {claim.screening_status === "blocked" && " Not cleared; the operator will be in touch."}
                {(!claim.screening_status || claim.screening_status === "pending") && " Pending."}
              </p>
            </li>
          </ol>
          <p className="prize-fine">
            Prizes are income to the winner. Minerval reports and withholds as United States law
            requires: a 1099-MISC at the statutory threshold for a U.S. person, and a 1042-S with
            withholding for everyone else. The grant is made in daily tranches of at most $2,000.
          </p>
        </>
      )}
    </div>
  );
}

export function PrizeAward({ claims }: { claims: OpenPrizeClaim[] }) {
  if (claims.length === 0) return null;
  const won = claims.filter((c) => WINNER_STATES.has(c.status));
  const live = claims.filter((c) => LIVE_STATES.has(c.status));
  const settled = claims.filter((c) => !WINNER_STATES.has(c.status) && !LIVE_STATES.has(c.status));
  return (
    <>
      {won.map((c) => <Award key={c.id} claim={c} />)}
      {live.length > 0 && (
        <>
          <h3>Prize claims in progress</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>submitted</th>
                <th>state</th>
                <th>next</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/claims/${c.claim_id}`}>{c.claim_text}</Link>{" "}
                    <span style={{ color: "var(--faint)" }}>· {formatUsd(c.amount_micro_usd)} · {c.direction}</span>
                  </td>
                  <td>{fmtDate(c.submitted_at)}</td>
                  <td>{prizeClaimStateLabel(c)}</td>
                  <td style={{ maxWidth: "20rem" }}>
                    {prizeClaimNextStep(c)}{" "}
                    <Link href={`/contributions/${c.contribution_id}`}>record</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {settled.length > 0 && (
        <>
          <h3>Past prize claims</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>submitted</th>
                <th>outcome</th>
                <th aria-label="record" />
              </tr>
            </thead>
            <tbody>
              {settled.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/claims/${c.claim_id}`}>{c.claim_text}</Link></td>
                  <td>{fmtDate(c.submitted_at)}</td>
                  <td>{prizeClaimStateLabel(c)}</td>
                  <td><Link href={`/contributions/${c.contribution_id}`}>view record</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
