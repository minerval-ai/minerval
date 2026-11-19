"use client";

import { useState } from "react";
import type { RequestItem } from "@/lib/types";
import { OwlMark } from "@/components/OwlMark";
import styles from "./request.module.css";
import { ActingLine, useActingBlocked } from "@/components/account/ActingAs";

// The work on a request is a row on the action ledger (docs/allocation.md,
// "Requests on the ledger"): a scoping pass while it has no budget, then the
// full work. Anyone may commission it whole, at the budget they choose; it
// runs at once, and unspent owls come back.
export function RequestFunding({ r }: { r: RequestItem }) {
  const ledger = r.ledger;
  const scope = ledger?.variant === "scope";
  // Start the box at the price, so the plain choice is to fund the work whole.
  const [owls, setOwls] = useState(() => (ledger && !scope ? Math.max(0.25, Math.ceil(ledger.cost_usd * 4) / 4) : 1));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [commissioned, setCommissioned] = useState((ledger?.backing_usd ?? 0) > 0);
  const blocked = useActingBlocked("spend");
  if (!ledger) return null;

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
          window.location.href = `/signin?callbackUrl=${encodeURIComponent(`/requests/${r.id}`)}`;
          return;
        }
        setNote(data.error ?? "That did not go through; try again.");
      } else {
        setCommissioned(true);
        setNote(
          `Thank you: commissioned with ${data.allocated_owls} owls. The work starts shortly.` +
            (data.below_quote && data.note ? ` ${data.note}` : "")
        );
      }
    } catch {
      setNote("That did not go through; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.box}>
      <div className="sc">Fund the work</div>
      <p className={styles.fundingLine}>
        {running ? (
          "Funded and under way."
        ) : commissioned ? (
          "Commissioned; it starts shortly."
        ) : scope ? (
          <>Not yet priced. A short scoping pass comes first: the Researcher finds out what the work would involve and quotes it.</>
        ) : (
          <>
            About <strong>${ledger.cost_usd.toFixed(2)}</strong> to do, and nobody has commissioned it yet.
          </>
        )}
      </p>
      {!running && !commissioned && (
        <>
          <p>
            Anyone may commission it, with the budget they think it needs; it starts at once. You pay what the work
            actually costs and the rest comes back, as does everything if the request closes first. Funding buys the
            work, never its result.
          </p>
          <ActingLine permission="spend" />
          <div className="key-create">
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={owls}
              onChange={(e) => setOwls(Number(e.target.value))}
              aria-label="budget in owls for this work"
            />
            <button onClick={fund} disabled={busy || blocked || !(owls > 0)}>
              {busy ? "commissioning…" : <>Commission it with <OwlMark size={14} className="owl-mark" />{owls}</>}
            </button>
          </div>
        </>
      )}
      {note && <p role="status" className={styles.fundingNote}>{note}</p>}
    </div>
  );
}
