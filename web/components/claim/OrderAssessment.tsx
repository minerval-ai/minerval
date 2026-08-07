"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OwlMark } from "../OwlMark";

interface OrderView {
  id: string;
  status: string;
  charged: boolean;
  error: string | null;
}

// The claim page's order surface: one button that becomes a live status line.
// Everything is transparent about money: the button carries the ceiling ("up
// to 1 owl"), a pending order is cancellable and uncharged, the ceiling is
// charged only when the run starts, and whatever the run doesn't use settles
// back afterward. Polls while an order is open; when the assessment lands
// the page refreshes and the real verdict replaces this.
export function OrderAssessment({
  claimId,
  variant,
}: {
  claimId: string;
  /** "unassessed" = the primary CTA; "reassess" = quiet link under a verdict. */
  variant: "unassessed" | "reassess";
}) {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/claims/${claimId}/order`, {
        cache: "no-store",
      });
      const data = (await res.json()) as {
        order: OrderView | null;
        signed_in: boolean;
      };
      setSignedIn(data.signed_in);
      setOrder(data.order);
      return data.order;
    } catch {
      return null;
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while an order is open; on completion, refresh the page so the new
  // assessment renders.
  useEffect(() => {
    if (!order || (order.status !== "pending" && order.status !== "running")) {
      if (order && order.status === "done" && !doneRef.current) {
        doneRef.current = true;
        router.refresh();
      }
      return;
    }
    const timer = setInterval(() => {
      void load().then((o) => {
        if (o?.status === "done" && !doneRef.current) {
          doneRef.current = true;
          router.refresh();
        }
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [order, load, router]);

  const place = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/order`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The order could not be placed.");
      } else {
        setOrder(data.order);
      }
    } catch {
      setError("The order could not be placed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!order) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, { method: "DELETE" });
      if (res.ok) setOrder(null);
    } finally {
      setBusy(false);
    }
  };

  if (signedIn === null) return null;

  if (signedIn === false) {
    return (
      <p className="order-line">
        <a href="/signin">Sign in</a> to have this claim assessed. It costs
        at most 1 owl, and new accounts start with 5 free.
      </p>
    );
  }

  if (order?.status === "pending") {
    return (
      <p className="order-line" role="status">
        Assessment ordered and starting shortly. Not yet charged;{" "}
        <button className="linklike" onClick={cancel} disabled={busy}>
          cancel free
        </button>
        .
      </p>
    );
  }
  if (order?.status === "running") {
    return (
      <p className="order-line" role="status">
        Assessment in progress: the Steward is examining evidence now. One
        owl is held while it works; whatever the run doesn&rsquo;t use comes
        back when it finishes. This page will update when the verdict lands.
      </p>
    );
  }
  if (order?.status === "failed") {
    return (
      <p className="order-line">
        The assessment failed{order.charged ? " and your owl was refunded" : ""}
        {order.error ? ` (${order.error})` : ""}.{" "}
        <button className="linklike" onClick={place} disabled={busy}>
          try again
        </button>
      </p>
    );
  }

  return (
    <div className="order-line">
      {variant === "unassessed" ? (
        <button className="order-button" onClick={place} disabled={busy}>
          {busy ? (
            "placing order…"
          ) : (
            <>
              Assess this claim · up to{" "}
              <OwlMark size={14} className="owl-mark" />1 owl
            </>
          )}
        </button>
      ) : (
        <button className="linklike" onClick={place} disabled={busy}>
          {busy ? "placing order…" : "order a fresh assessment (up to 1 owl)"}
        </button>
      )}
      {variant === "unassessed" && (
        <span className="order-caption">
          A Steward agent examines the evidence and records a verdict,
          usually within minutes. The owl is held only when the run starts,
          and the unused part is returned when it finishes.{" "}
          <ChipIn claimId={claimId} />
        </span>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// The partial path: put less than the full cost toward the assessment.
// Allocations accumulate across funders (people and mandates alike), and
// the assessment runs the moment they cover its expected cost.
function ChipIn({ claimId }: { claimId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "covered">(
    "idle"
  );
  const [note, setNote] = useState<string | null>(null);

  if (state === "done" || state === "covered") {
    return (
      <span role="status">
        {note ?? "Your owls are in; they count toward this assessment."}
      </span>
    );
  }
  return (
    <>
      Or{" "}
      <button
        className="linklike"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const res = await fetch(`/api/claims/${claimId}/contribute`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ owls: 0.25 }),
            });
            const data = await res.json();
            if (!res.ok) {
              setNote(data.error ?? "That did not go through; try again.");
              setState("idle");
            } else if (data.covered) {
              setNote(
                "That completed the funding; the assessment will run shortly."
              );
              setState("covered");
            } else {
              setNote(
                `Thank you: ${data.unspent_owls} owls are now backing this ` +
                  `assessment. It runs the moment the pot covers the cost.`
              );
              setState("done");
            }
          } catch {
            setNote("That did not go through; try again.");
            setState("idle");
          }
        }}
      >
        {state === "busy" ? "chipping in…" : "chip in a quarter owl"}
      </button>{" "}
      toward it; the assessment runs once contributions cover its cost.
      {note && state === "idle" && <span> {note}</span>}
    </>
  );
}
