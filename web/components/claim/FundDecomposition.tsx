"use client";

import { useState } from "react";
import { OwlMark } from "../OwlMark";

// The fewest owls a decomposition takes, and the budgets offered by default.
const MIN_OWLS = 5;
const PRESETS = [5, 20, 100];

// "Build your part of the graph": fund a decomposition of this claim. It is
// a mandate on the claim (docs/allocation.md, "Deep decomposition"): a fresh
// pass on the claim first, then the claims that bear on it, within the
// budget. The form says exactly what happens: escrow now, metered spend, a
// tenth for the Grantmaker's own planning, the rest refunded when done. A
// balance that cannot cover it goes to the owl packs and comes back here.
export function FundDecomposition({ claimId }: { claimId: string }) {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(PRESETS[0]!);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mandateId, setMandateId] = useState<string | null>(null);

  const valid = Number.isFinite(budget) && budget >= MIN_OWLS;

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
        if (data.code === "INSUFFICIENT_OWLS") {
          // Buy owls, then come back to this claim.
          const back = `${window.location.pathname}#fund-decomposition`;
          window.location.href = `/account?return=${encodeURIComponent(back)}#buy-owls`;
          return;
        }
        setError(data.error ?? "The decomposition could not be funded.");
      } else {
        setMandateId(data.mandate_id);
      }
    } catch {
      setError("The decomposition could not be funded. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (mandateId) {
    return (
      <p className="order-line" role="status">
        Decomposition funded; its Grantmaker is planning the work.{" "}
        <a href={`/mandates/${mandateId}`}>follow it on its mandate page →</a>
      </p>
    );
  }

  if (!open) {
    return (
      <p className="order-line" id="fund-decomposition">
        <button className="linklike" onClick={() => setOpen(true)}>
          fund a deeper decomposition of this claim…
        </button>
      </p>
    );
  }

  return (
    <div className="fund-decomp" id="fund-decomposition">
      <p className="order-caption">
        Give this claim an owl budget and a mandate works on it: first a fresh
        assessment of the claim itself, then the claims it turns on, including
        the low-importance branches the graph&rsquo;s own budget leaves as
        stubs, and the claims around it that bear on it, most consequential
        first. A tenth of the budget pays for the Grantmaker that plans the
        work. The budget is held in escrow now, spend is metered against real
        model work, and whatever isn&rsquo;t used comes back. The mandate is
        public; it shows you as &ldquo;a reader&rdquo;.
      </p>
      <div className="key-create" role="group" aria-label="budget in owls">
        {PRESETS.map((p) => (
          <button
            key={p}
            className={!custom && budget === p ? "" : "linklike"}
            aria-pressed={!custom && budget === p}
            onClick={() => {
              setCustom(false);
              setBudget(p);
            }}
          >
            {p} owls
          </button>
        ))}
        <button
          className={custom ? "" : "linklike"}
          aria-pressed={custom}
          onClick={() => setCustom(true)}
        >
          custom
        </button>
        {custom && (
          <input
            type="number"
            min={MIN_OWLS}
            step={1}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            aria-label="custom budget in owls"
          />
        )}
      </div>
      <div className="key-create">
        <button onClick={fund} disabled={busy || !valid}>
          {busy ? (
            "funding…"
          ) : (
            <>
              Fund <OwlMark size={14} className="owl-mark" />
              {budget} owls
            </>
          )}
        </button>
        <button className="linklike" onClick={() => setOpen(false)}>
          cancel
        </button>
      </div>
      {!valid && <p className="form-error">A decomposition takes at least {MIN_OWLS} owls.</p>}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
