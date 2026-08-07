"use client";

import { useState } from "react";
import { OwlMark } from "../OwlMark";

// "Build your part of the graph": fund deeper decomposition of this claim's
// subtree with an owl budget. Open-ended work gets a budget, not a price —
// the form says exactly what happens: escrow now, metered spend, pause at
// the floor, unspent refunded. Links to the job page once funded.
export function FundDecomposition({ claimId }: { claimId: string }) {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const fund = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/decompose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budget_owls: budget }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "SIGN_IN") {
          window.location.href = "/signin";
          return;
        }
        setError(data.error ?? "The job could not be funded.");
      } else {
        setJobId(data.job.id);
      }
    } catch {
      setError("The job could not be funded. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (jobId) {
    return (
      <p className="order-line" role="status">
        Decomposition funded; the job is running.{" "}
        <a href={`/account/jobs/${jobId}`}>watch its progress →</a>
      </p>
    );
  }

  if (!open) {
    return (
      <p className="order-line">
        <button className="linklike" onClick={() => setOpen(true)}>
          fund deeper decomposition of this subtree…
        </button>
      </p>
    );
  }

  return (
    <div className="fund-decomp">
      <p className="order-caption">
        Give this claim&rsquo;s subtree an owl budget and a Steward works
        through it, including the low-importance branches the graph&rsquo;s
        own budget leaves as stubs, until the subtree is done or the budget
        runs out. The budget is held in escrow now; spend is metered against
        real model work; if the budget runs out the job pauses and asks to
        top up; whatever isn&rsquo;t used comes back.
      </p>
      <div className="key-create">
        <input
          type="number"
          min={1}
          max={1000}
          step={1}
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
          aria-label="budget in owls"
        />
        <button onClick={fund} disabled={busy || budget <= 0}>
          {busy ? (
            "funding…"
          ) : (
            <>
              Fund <OwlMark size={14} className="owl-mark" />
              {budget} owl{budget === 1 ? "" : "s"}
            </>
          )}
        </button>
        <button className="linklike" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
