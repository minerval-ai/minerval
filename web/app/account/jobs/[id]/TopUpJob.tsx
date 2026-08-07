"use client";

import { useActionState } from "react";
import { topUpJobAction, type JobActionState } from "../../actions";

// Top-up form for a budget job — the "add owls to continue" affordance the
// pause state points at.
export function TopUpJob({
  jobId,
  paused,
}: {
  jobId: string;
  paused: boolean;
}) {
  const [state, formAction, pending] = useActionState<JobActionState, FormData>(
    topUpJobAction,
    {}
  );

  return (
    <div>
      <form action={formAction} className="key-create">
        <input type="hidden" name="job_id" value={jobId} />
        <input
          name="owls"
          type="number"
          min={1}
          max={1000}
          step={1}
          defaultValue={5}
          required
          aria-label="owls to add"
        />
        <button type="submit" disabled={pending}>
          {pending ? "adding…" : paused ? "Top up & resume" : "Top up"}
        </button>
      </form>
      {state.ok && (
        <p className="meter-caption" role="status">
          Budget added{paused ? "; the job picks up where it left off" : ""}.
        </p>
      )}
      {state.error && <p className="form-error">{state.error}</p>}
    </div>
  );
}
