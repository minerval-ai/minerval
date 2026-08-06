"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OwlMark } from "../../../components/OwlMark";

// Putting owls behind someone's mandate: one number, one action. The owls
// escrow into the mandate's budget; whatever the work never spends comes
// back to each contributor in proportion when the mandate ends.
export function ContributeBox({
  mandateId,
  signedIn,
}: {
  mandateId: string;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [owls, setOwls] = useState(5);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <p className="order-line">
        <a href="/signin">Sign in</a> to put your owls behind this mandate.
      </p>
    );
  }

  const contribute = async () => {
    if (busy || !(owls > 0)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mandates/${mandateId}/contribute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owls }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The contribution could not be made.");
      } else {
        setDone(true);
        router.refresh();
      }
    } catch {
      setError("The contribution could not be made. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mandate-contribute">
      {done ? (
        <p className="order-line" role="status">
          Your owls are in. Thank you for extending this mandate&rsquo;s
          reach.
        </p>
      ) : (
        <>
          <span className="mandate-budget">
            <OwlMark size={16} className="owl-mark" />
            <input
              type="number"
              min={1}
              max={10000}
              step={1}
              value={owls}
              onChange={(e) => setOwls(Number(e.target.value))}
              aria-label="Owls to contribute"
            />
            owls
          </span>
          <button className="order-button" onClick={contribute} disabled={busy}>
            {busy ? "escrowing…" : "Contribute to this mandate"}
          </button>
          <span className="order-caption">
            Escrowed into the mandate&rsquo;s budget now; whatever the work
            never spends returns to contributors in proportion.
          </span>
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
