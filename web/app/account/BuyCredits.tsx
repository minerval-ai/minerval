"use client";

import { useActionState } from "react";
import { buyCreditsAction, type BuyCreditsState } from "./actions";

// Client island mirroring KeyCreator: a small form that hands off to
// Stripe-hosted Checkout (the action redirects on success, so this only ever
// renders again on error).
export function BuyCredits({
  minUsd = 5,
  maxUsd = 500,
}: {
  minUsd?: number;
  maxUsd?: number;
}) {
  const [state, formAction, pending] = useActionState<BuyCreditsState, FormData>(
    buyCreditsAction,
    {}
  );

  return (
    <div>
      <form action={formAction} className="key-create">
        <input
          name="amount_usd"
          type="number"
          min={minUsd}
          max={maxUsd}
          step={1}
          defaultValue={20}
          required
          aria-label="credit amount in US dollars"
        />
        <button type="submit" disabled={pending}>
          {pending ? "redirecting…" : "Buy credits"}
        </button>
      </form>
      <p className="meter-caption">
        ${minUsd}–${maxUsd} per purchase · card payments via Stripe Checkout ·
        credits never expire
      </p>
      {state.error && <p className="form-error">{state.error}</p>}
    </div>
  );
}
