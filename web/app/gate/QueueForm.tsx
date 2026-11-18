"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { FormState } from "@/components/admin/ActionForm";
import { Icon } from "@/components/work/icons";

// The form for the item chosen at a gate: the parts are whatever the page
// puts inside it, each with a tick box, and the bar at its foot approves,
// releases, holds, delays or lifts on the ticked ones in one act, or
// removes a passage from a ticked part. Each button is disabled while the
// act runs, since a release is not taken back and must not be sent twice.
export function QueueForm({
  action,
  partyId,
  itemKey,
  reasons,
  anyHeld,
  categories,
  acts,
  children,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  partyId: string;
  /** The item shown: when it changes, the count of ticks is taken again. */
  itemKey: string;
  reasons: Record<string, string>;
  /** Whether anything of the item is held or delayed, so that lifting is offered. */
  anyHeld: boolean;
  /** The categories a passage can be removed under: those of the policy the item was redacted under (GET /gate/queue). */
  categories: string[];
  /** The acts at a gate, in the API's words. */
  acts: Record<string, string>;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  // Said here, before anything is sent: a form that has been sent comes back
  // with its ticks cleared, and a person who forgot the reason should not
  // have to tick everything again.
  const [missing, setMissing] = useState<string | null>(null);
  const [ticked, setTicked] = useState(0);
  const [total, setTotal] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const boxes = () => [...(form.current?.querySelectorAll<HTMLInputElement>('input[name="item"]') ?? [])];
  const count = () => {
    const all = boxes();
    setTotal(all.length);
    setTicked(all.filter((b) => b.checked).length);
  };
  useEffect(() => {
    count();
    setMissing(null);
  }, [itemKey, state]);

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
            : submitter?.value === "remove" && (!data.get("passage") || !data.get("category"))
              ? "Give the passage exactly as it appears in the part, and the policy's category that covers it."
              : null;
    setMissing(problem);
    if (problem) event.preventDefault();
  };
  const tickAll = (on: boolean) => {
    boxes().forEach((box) => {
      box.checked = on;
    });
    count();
  };
  const said = missing ?? state.error ?? null;

  return (
    <form ref={form} action={formAction} onSubmit={check} onChange={count} className="w-review-doc" aria-label="The item chosen">
      <input type="hidden" name="party_id" value={partyId} />
      <div className="w-review-doc-s">{children}</div>
      <div className="w-review-bar" role="toolbar" aria-label="Decide on the ticked parts">
        <div className="w-review-bar-r">
          <label className="w-review-bar-n" title={ticked < total ? "Tick every part" : "Untick every part"}>
            <input
              type="checkbox"
              checked={total > 0 && ticked === total}
              ref={(box) => {
                if (box) box.indeterminate = ticked > 0 && ticked < total;
              }}
              onChange={(e) => tickAll(e.target.checked)}
              aria-label="Tick every part"
            />
            <b>{ticked}</b> of {total}
          </label>
          <button className="w-btn w-sm w-pri" type="submit" name="decision" value="approve" disabled={pending}>
            {pending ? "Working…" : "Approve as redacted"}
          </button>
          <span
            className="w-tip"
            role="img"
            title="Releases what nobody holds, as the Redactor left it. The Redactor's holds and delays stay."
            aria-label="Releases what nobody holds, as the Redactor left it. The Redactor's holds and delays stay."
          >
            i
          </span>
          <button className="w-btn w-sm" type="submit" name="decision" value="release" disabled={pending} title={`${acts.release ?? "Release"} Can't be undone.`}>
            <Icon name="lock" size={13} />
            Release
          </button>
          <details className="w-menu">
            <summary className="w-btn w-sm">Hold…</summary>
            <div className="w-pop">
              <div className="w-field">
                <label htmlFor="gate-reason">Reason</label>
                <select id="gate-reason" className="w-select" name="reason" defaultValue="">
                  <option value="">Choose a reason</option>
                  {Object.entries(reasons).map(([key, words]) => (
                    <option key={key} value={key}>
                      {words}
                    </option>
                  ))}
                </select>
                <span className="w-help">All the other side is told, with who holds it and since when.</span>
              </div>
              <button className="w-btn w-sm w-pri" type="submit" name="decision" value="hold" disabled={pending}>
                Hold the ticked parts
              </button>
            </div>
          </details>
          <details className="w-menu">
            <summary className="w-btn w-sm">Delay…</summary>
            <div className="w-pop">
              <div className="w-field">
                <label htmlFor="gate-until">Until</label>
                <input id="gate-until" className="w-input" type="datetime-local" name="until" />
                <span className="w-help">Parts delayed to the same time go together.</span>
              </div>
              <button className="w-btn w-sm w-pri" type="submit" name="decision" value="delay" disabled={pending}>
                Delay the ticked parts
              </button>
            </div>
          </details>
          {anyHeld && (
            <button className="w-btn w-sm w-ghost" type="submit" name="decision" value="lift" disabled={pending} title={acts.lift}>
              Lift
            </button>
          )}
          <details className="w-menu w-review-end">
            <summary className="w-btn w-sm w-ghost" title={acts.remove}>Remove…</summary>
            <div className="w-pop">
              <div className="w-field">
                <label htmlFor="gate-passage">Passage, exactly as it appears</label>
                <input id="gate-passage" className="w-input" type="text" name="passage" autoComplete="off" />
              </div>
              <div className="w-field">
                <label htmlFor="gate-category">Category</label>
                <select id="gate-category" className="w-select" name="category" defaultValue="" disabled={categories.length === 0}>
                  <option value="">{categories.length === 0 ? "The policy has no categories" : "Choose a category"}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="w-help">
                  {categories.length === 0
                    ? "A passage is removed under a category of the policy this item was redacted under, and it has none. A part can be held."
                    : "From the policy this item was redacted under. The category\u2019s mark takes the passage\u2019s place; no word is changed."}
                </span>
              </div>
              <button className="w-btn w-sm w-pri" type="submit" name="decision" value="remove" disabled={pending || categories.length === 0}>
                Remove from the ticked part
              </button>
            </div>
          </details>
        </div>
        {said && (
          <div className="w-said w-error" role="alert">
            {said}
          </div>
        )}
        {!said && state.notice && (
          <div className="w-said" role="status">
            {state.notice}
          </div>
        )}
      </div>
    </form>
  );
}
