"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface OrderView {
  id: string;
  status: string;
  charged: boolean;
  error: string | null;
}

// The claim page's order surface: one button that becomes a live status line.
// Everything is transparent about money: the price is stated up front, a
// pending order says "not yet charged — cancel free", and the charge happens
// only when the run starts. Polls while an order is open; when the
// assessment lands the page refreshes and the real verdict replaces this.
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
        <a href="/signin">Sign in</a> to have this claim assessed (1 owl —
        new accounts start with 5 free).
      </p>
    );
  }

  if (order?.status === "pending") {
    return (
      <p className="order-line" role="status">
        Assessment ordered — starting shortly. Not yet charged;{" "}
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
        Assessment in progress — the Steward is examining evidence now (1 owl
        charged). This page will update when the verdict lands.
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
          {busy ? "placing order…" : "Assess this claim — 1 owl"}
        </button>
      ) : (
        <button className="linklike" onClick={place} disabled={busy}>
          {busy ? "placing order…" : "order a fresh assessment (1 owl)"}
        </button>
      )}
      {variant === "unassessed" && (
        <span className="order-caption">
          A Steward agent examines the evidence and records a verdict, usually
          within minutes. Charged only when the run starts.
        </span>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
