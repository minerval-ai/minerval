"use client";

import { useActionState, type ReactNode } from "react";
import { removeLabelReadAction } from "../actions";

// One label another reads, as a chip whose ✕ takes the pair back (the
// existing removeLabelRead form). What the API refuses shows beside it.
export function ReadChip({ label, reads, chip }: { label: string; reads: string; chip: ReactNode }) {
  const [state, action, pending] = useActionState(removeLabelReadAction, {});
  return (
    <form action={action} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input type="hidden" name="label" value={label} />
      <input type="hidden" name="reads" value={reads} />
      <span className="w-chip" style={{ height: 22, paddingRight: 6 }}>
        {chip}
        <button type="submit" disabled={pending} title={`Take back: ${label} no longer reads ${reads}`} aria-label={`Take back ${label} reading ${reads}`}>
          ✕
        </button>
      </span>
      {state.error && (
        <span className="w-said w-error" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
