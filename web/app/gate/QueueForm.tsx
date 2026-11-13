"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import type { FormState } from "@/components/admin/ActionForm";

// The form for what waits on one party at a gate: the items are whatever
// the page puts inside it, each with a tick box, and the foot approves,
// releases, holds, delays or lifts on the ticked ones in one act, or
// removes a passage from a ticked part. Each button is disabled while
// the act runs, since a release is not taken back and must not be sent
// twice.
export function QueueForm({
  action,
  partyId,
  reasons,
  anyHeld,
  children,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  partyId: string;
  reasons: Record<string, string>;
  /** Whether any item here is held by this party, so that lifting a hold is offered. */
  anyHeld: boolean;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  // Said here, before anything is sent: a form that has been sent comes back
  // with its ticks cleared, and a person who forgot the reason should not
  // have to tick everything again.
  const [missing, setMissing] = useState<string | null>(null);
  const check = (event: React.FormEvent<HTMLFormElement>) => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const data = new FormData(event.currentTarget);
    const problem =
      data.getAll("item").length === 0
        ? "Tick at least one item."
        : submitter?.value === "hold" && !data.get("reason")
          ? "A hold gives a reason from the list. It is all the other side is told."
          : submitter?.value === "delay" && !data.get("until")
            ? "A delay gives the date and time it runs until."
            : null;
    setMissing(problem);
    if (problem) event.preventDefault();
  };
  const form = useRef<HTMLFormElement>(null);
  const tickAll = (on: boolean) => {
    form.current?.querySelectorAll<HTMLInputElement>('input[name="item"]').forEach((box) => {
      box.checked = on;
    });
  };
  return (
    <form ref={form} action={formAction} onSubmit={check} className="queue-form">
      <input type="hidden" name="party_id" value={partyId} />
      {children}
      <div className="queue-foot">
        <span className="queue-ticks">
          <button type="button" className="linklike" onClick={() => tickAll(true)}>
            tick every item
          </button>
          {" · "}
          <button type="button" className="linklike" onClick={() => tickAll(false)}>
            untick all
          </button>
        </span>
        <button className="order-button" type="submit" name="decision" value="approve" disabled={pending}>
          {pending ? "Working…" : "Approve the ticked items as the Redactor left them"}
        </button>
        <button className="order-button queue-secondary" type="submit" name="decision" value="release" disabled={pending}>
          Release the ticked items
        </button>
        <label className="queue-reason">
          Reason for a hold
          <select name="reason" defaultValue="">
            <option value="">Choose a reason</option>
            {Object.entries(reasons).map(([key, words]) => (
              <option key={key} value={key}>
                {words}
              </option>
            ))}
          </select>
        </label>
        <button className="order-button queue-secondary" type="submit" name="decision" value="hold" disabled={pending}>
          Hold the ticked items
        </button>
        <label className="queue-reason">
          Delay until
          <input type="datetime-local" name="until" />
        </label>
        <button className="order-button queue-secondary" type="submit" name="decision" value="delay" disabled={pending}>
          Delay the ticked items
        </button>
        {anyHeld && (
          <button className="order-button queue-secondary" type="submit" name="decision" value="lift" disabled={pending}>
            Lift the hold or delay on the ticked items
          </button>
        )}
        <details className="admin-args">
          <summary>remove a passage from the ticked part</summary>
          <label className="queue-reason">
            The passage, exactly as it appears
            <input type="text" name="passage" />
          </label>
          <label className="queue-reason">
            The policy&rsquo;s category that covers it
            <input type="text" name="category" />
          </label>
          <button className="order-button queue-secondary" type="submit" name="decision" value="remove" disabled={pending}>
            Remove it and leave the category&rsquo;s mark
          </button>
        </details>
        {missing && (
          <span className="admin-form-said admin-form-error" role="alert">
            {missing}
          </span>
        )}
        {!missing && state.error && (
          <span className="admin-form-said admin-form-error" role="alert">
            {state.error}
          </span>
        )}
        {!missing && state.notice && (
          <span className="admin-form-said" role="status">
            {state.notice}
          </span>
        )}
      </div>
    </form>
  );
}
