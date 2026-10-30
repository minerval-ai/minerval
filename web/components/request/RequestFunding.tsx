"use client";

import { useState } from "react";
import type { RequestItem } from "@/lib/types";
import { OwlMark } from "@/components/OwlMark";
import styles from "./request.module.css";

// The work on a request is a row on the action ledger (docs/allocation.md,
// "Requests on the ledger"): a scoping pass while it has no budget, then the
// full work at its budget. Anyone may put owls toward it; it runs once the
// pot covers the cost, and unspent owls come back.
export function RequestFunding({ r }: { r: RequestItem }) {
  const ledger = r.ledger;
  const [owls, setOwls] = useState(1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [backing, setBacking] = useState(ledger?.backing_usd ?? 0);
  if (!ledger) return null;

  const scope = ledger.variant === "scope";
  const lacking = Math.max(0, ledger.cost_usd - backing);
  const running = ledger.status === "running";

  const fund = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/requests/${r.id}/contribute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owls }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "SIGN_IN") {
          window.location.href = "/signin";
          return;
        }
        setNote(data.error ?? "That did not go through; try again.");
      } else {
        setBacking(data.backing_owls);
        setNote(
          data.covered
            ? "That completed the funding; the work will start shortly."
            : `Thank you: ${data.allocated_owls} owls are in. It runs the moment the pot covers the cost.`
        );
      }
    } catch {
      setNote("That did not go through; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Funding the work</h2>
      <p className={styles.intro}>
        {scope
          ? "This request has no budget yet, so the next step is a short scoping pass: the Researcher finds out what the work would involve and quotes it, and the quote becomes the request's budget."
          : `Doing it should cost about $${ledger.cost_usd.toFixed(2)}, its budget.`}{" "}
        Anyone may put owls toward it, and it runs once they cover the cost. You pay your share
        of what the work actually costs; the rest comes back, as does everything if the request
        closes first. Funding buys the work, never its result.
      </p>
      <p className={styles.fundingLine}>
        {running ? (
          "Under way now."
        ) : (
          <>
            <OwlMark size={13} className="owl-mark" />
            {backing.toFixed(2)} of {ledger.cost_usd.toFixed(2)} owls behind the{" "}
            {scope ? "scoping pass" : "work"}
          </>
        )}
      </p>
      {!running && lacking > 0 && (
        <div className="key-create">
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={owls}
            onChange={(e) => setOwls(Number(e.target.value))}
            aria-label="owls to put toward this request"
          />
          <button onClick={fund} disabled={busy || !(owls > 0)}>
            {busy ? "funding…" : <>Put <OwlMark size={14} className="owl-mark" />{owls} toward it</>}
          </button>
        </div>
      )}
      {note && <p role="status" className={styles.fundingNote}>{note}</p>}
    </section>
  );
}
