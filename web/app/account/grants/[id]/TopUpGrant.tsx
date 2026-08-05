"use client";

import { useActionState } from "react";
import { topUpGrantAction, type JobActionState } from "../../actions";

export function TopUpGrant({
  grantId,
  paused,
}: {
  grantId: string;
  paused: boolean;
}) {
  const [state, formAction, pending] = useActionState<JobActionState, FormData>(
    topUpGrantAction,
    {}
  );

  return (
    <div>
      <form action={formAction} className="key-create">
        <input type="hidden" name="grant_id" value={grantId} />
        <input
          name="owls"
          type="number"
          min={1}
          max={10000}
          step={1}
          defaultValue={10}
          required
          aria-label="owls to add"
        />
        <button type="submit" disabled={pending}>
          {pending ? "adding…" : paused ? "Top up & resume" : "Top up"}
        </button>
      </form>
      {state.ok && (
        <p className="meter-caption" role="status">
          Budget added{paused ? " — the grant resumes on the next pass" : ""}.
        </p>
      )}
      {state.error && <p className="form-error">{state.error}</p>}
    </div>
  );
}
