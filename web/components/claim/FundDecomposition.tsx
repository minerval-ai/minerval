"use client";

import { useState } from "react";
import { OwlMark } from "../OwlMark";
import { GettingOwls } from "../GettingOwls";
import type { OwlSource } from "../../lib/owl-source";

// The fewest owls a decomposition takes, and the budgets offered by default.
const MIN_OWLS = 5;
const PRESETS = [5, 20, 100];

// "Build your part of the graph": fund a decomposition of this claim. It is
// a mandate on the claim (docs/allocation.md, "Deep decomposition"): a fresh
// pass on the claim first, then the claims that bear on it, within the
// budget. The form says exactly what happens: escrow now, metered spend, a
// tenth for the Grantmaker's own planning, the rest refunded when done. A
// balance that cannot cover it goes to the owl packs and comes back here,
// where owls are sold; where they are created by an administrator, the form
// says so instead (#1095).
// `compact` is the left rail's form, for a claim with no subclaims yet.
export function FundDecomposition({ claimId, compact = false }: { claimId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(PRESETS[0]!);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The balance could not cover it, and owls are not bought here.
  const [short, setShort] = useState<OwlSource | null>(null);
  const [mandateId, setMandateId] = useState<string | null>(null);

  const valid = Number.isFinite(budget) && budget >= MIN_OWLS;

  const fund = async () => {
    setBusy(true);
    setError(null);
    setShort(null);
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
          const source: OwlSource = data.owl_source ?? { kind: "none" };
          if (source.kind === "sold") {
            // Buy owls, then come back to this claim.
            const back = `${window.location.pathname}#fund-decomposition`;
            window.location.href = `/account?return=${encodeURIComponent(back)}#buy-owls`;
            return;
          }
          setShort(source);
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
          {compact ? "fund a deeper decomposition…" : "fund a deeper decomposition of this claim…"}
        </button>
      </p>
    );
  }

  return (
    <div className={`fund-decomp${compact ? " compact" : ""}`} id="fund-decomposition">
      <p className="order-caption">
        A mandate reassesses this claim, then works through what it turns on,
        most consequential first, including branches the graph leaves as
        stubs. A tenth pays for its Grantmaker. Unused owls come back. The
        mandate is public and shows you as &ldquo;a reader&rdquo;.
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
      {short && (
        <p className="form-error">
          Your balance cannot cover {budget} owls. <GettingOwls source={short} />
        </p>
      )}
    </div>
  );
}
