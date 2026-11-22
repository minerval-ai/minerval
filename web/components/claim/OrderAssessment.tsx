"use client";

import { ActingLine, useActingBlocked } from "@/components/account/ActingAs";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OwlMark } from "../OwlMark";
import type { AssessmentUnderWay } from "../../lib/types";

interface OrderView {
  id: string;
  status: string;
  charged: boolean;
  error: string | null;
}

// The claim page's order surface: one button that becomes a live status line.
// Everything is transparent about money: the button carries the ceiling ("up
// to 2 owls"), a pending order is cancellable and uncharged, the ceiling is
// charged only when the run starts, and whatever the run doesn't use settles
// back afterward. Polls while an order is open; when the assessment lands
// the page refreshes and the real verdict replaces this.
//
// While a pass on the node is under way, anyone's (an accepted proposal's
// first assessment, another reader's order, the graph's own pass), every
// reader is told so in place of the button, which would only buy a second
// pass: "being assessed now", or "queued" while an order waits. It is read
// fresh, not from the page's cached copy, and the page refreshes when the
// judgment lands.
export function OrderAssessment({
  claimId,
  variant,
  underWay: initialUnderWay = null,
}: {
  claimId: string;
  /** "unassessed" = the primary CTA; "reassess" = quiet link under a verdict. */
  variant: "unassessed" | "reassess";
  /** What the page's own read said was under way, for the first paint. */
  underWay?: AssessmentUnderWay | null;
}) {
  const router = useRouter();
  const blocked = useActingBlocked("spend");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [underWay, setUnderWay] = useState<AssessmentUnderWay | null>(initialUnderWay);
  const doneRef = useRef(false);
  // Whether this node was unassessed when the line was drawn: a judgment
  // appearing then means the pass it showed has landed.
  const awaitingFirst = useRef(variant === "unassessed");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/claims/${claimId}/order`, {
        cache: "no-store",
      });
      const data = (await res.json()) as {
        order: OrderView | null;
        signed_in: boolean;
        under_way?: AssessmentUnderWay | null;
        assessed?: boolean;
      };
      setSignedIn(data.signed_in);
      setOrder(data.order);
      setUnderWay(data.under_way ?? null);
      if (awaitingFirst.current && data.assessed && !doneRef.current) {
        doneRef.current = true;
        router.refresh();
      }
      return data.order;
    } catch {
      return null;
    }
  }, [claimId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  // While someone else's pass is under way, read again until it ends.
  useEffect(() => {
    if (!underWay || order) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [underWay, order, load]);

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

  if (signedIn === null) {
    // Before the first read, what the page itself knew.
    return underWay ? <UnderWayLine underWay={underWay} variant={variant} /> : null;
  }

  // The viewer's own order says more (it can be cancelled), so it comes
  // first; anyone else's pass is shown to everyone.
  if (!order && underWay) return <UnderWayLine underWay={underWay} variant={variant} />;

  if (signedIn === false) {
    return (
      <p className="order-line">
        <a href="/signin">Sign in</a> to have this claim assessed. It costs
        at most 2 owls, and new accounts start with 5 free.
      </p>
    );
  }

  if (order?.status === "pending") {
    // A proposal's order was paid for when the proposal was made.
    return order.charged ? (
      <p className="order-line" role="status">
        Assessment queued.
      </p>
    ) : (
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
        Assessment in progress. This page updates when the verdict lands.
      </p>
    );
  }
  if (order?.status === "failed") {
    return (
      <p className="order-line">
        The assessment failed{order.charged ? " and your owls were refunded" : ""}
        {order.error ? ` (${order.error})` : ""}.{" "}
        <button className="linklike" onClick={place} disabled={busy}>
          try again
        </button>
      </p>
    );
  }

  return (
    <div className="order-line">
      <ActingLine permission="spend" />
      {variant === "unassessed" ? (
        <button
          className="order-button"
          onClick={place}
          disabled={busy || blocked}
          // What the order does and costs, on the button rather than
          // under it: the button already says "up to 2 owls".
          title={
            "Nothing has funded an assessment of this claim yet, and anyone can. " +
            "A Steward examines the evidence and records a verdict, usually within minutes. " +
            "The owls are held only when the run starts, and the unused part comes back."
          }
        >
          {busy ? (
            "placing order…"
          ) : (
            <>
              Assess this claim · up to{" "}
              <OwlMark size={14} className="owl-mark" />2 owls
            </>
          )}
        </button>
      ) : (
        <button className="linklike" onClick={place} disabled={busy || blocked}>
          {busy ? "placing order…" : "order a fresh assessment (up to 2 owls)"}
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

/** A pass on the node under way, as every reader is told it. */
function UnderWayLine({
  underWay,
  variant,
}: {
  underWay: AssessmentUnderWay;
  variant: "unassessed" | "reassess";
}) {
  const what = variant === "unassessed" ? "Being assessed" : "Being reassessed";
  return (
    <p className="order-line" role="status">
      <span className="under-way-dot" aria-hidden="true" />
      {underWay.state === "running" ? `${what}…` : `${what === "Being assessed" ? "Assessment" : "Reassessment"} queued.`}
    </p>
  );
}
