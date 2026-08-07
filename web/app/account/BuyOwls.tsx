"use client";

import { useActionState } from "react";
import type { OwlPack } from "../../lib/account-api";
import { buyOwlsAction, type BuyOwlsState } from "./actions";
import { OwlMark } from "../../components/OwlMark";

function packPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// Client island mirroring KeyCreator: pick a pack, hand off to Stripe-hosted
// Checkout (the action redirects on success, so this only ever renders again
// on error). Discounts come from the API — never re-derived here.
export function BuyOwls({ packs }: { packs: OwlPack[] }) {
  const [state, formAction, pending] = useActionState<BuyOwlsState, FormData>(
    buyOwlsAction,
    {}
  );

  return (
    <div>
      <form action={formAction} className="owl-packs">
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="submit"
            name="pack_id"
            value={pack.id}
            disabled={pending}
            className="owl-pack"
          >
            {pack.name && <span className="owl-pack-name">{pack.name}</span>}
            <span className="owl-pack-count">
              <OwlMark size={14} className="owl-mark" />
              {pack.owls} owls
            </span>
            <span className="owl-pack-price">{packPrice(pack.price_cents)}</span>
            {pack.discount_percent > 0 && (
              <span className="owl-pack-discount">
                save {pack.discount_percent}%
              </span>
            )}
          </button>
        ))}
      </form>
      <p className="meter-caption">
        {pending
          ? "redirecting to checkout…"
          : "card payments via Stripe Checkout · owls never expire"}
      </p>
      {state.error && <p className="form-error">{state.error}</p>}
    </div>
  );
}
