"use client";

import { useActionState } from "react";
import { removeGrantAction } from "../actions";

// The ✕ on a grant's chip: the shared removeGrantAction, as a form small
// enough to sit inside the chip. What the API refuses is said beside it.

export function RemoveGrant({ grantId, what }: { grantId: string; what: string }) {
  const [state, action, pending] = useActionState(removeGrantAction, {});
  return (
    <form action={action} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input type="hidden" name="grant_id" value={grantId} />
      <button type="submit" disabled={pending} title={`Remove ${what}`} aria-label={`Remove ${what}`}>
        {pending ? "…" : "✕"}
      </button>
      {state.error && (
        <span className="w-said w-error" role="alert" title={state.error}>
          not removed
        </span>
      )}
    </form>
  );
}
