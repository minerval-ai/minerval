"use client";

import { useActionState, type ReactNode } from "react";
import type { FormAction } from "../admin/ActionForm";

// A form in the members' workspace: its fields are whatever the page puts in
// it, and its action is a server action that answers with what went wrong or
// what was done (the same contract as components/admin/ActionForm.tsx, whose
// actions it takes unchanged). The button is disabled while the action runs,
// so an act that is not safe to make twice cannot be sent twice; what the
// action answers is shown beside the button.
//
// `lock` marks an act that cannot be undone, next to its button, so the page
// needs no paragraph to say so.

export function WorkForm({
  action,
  submit,
  children,
  primary = false,
  danger = false,
  inline = false,
  small = false,
  lock,
  extra,
  id,
}: {
  action: FormAction;
  /** The words on the button: a verb ("Grant", "Release 3"). */
  submit: ReactNode;
  children?: ReactNode;
  primary?: boolean;
  danger?: boolean;
  /** A form that sits in a row of a table or a line of text: its fields and button side by side. */
  inline?: boolean;
  small?: boolean;
  /** A short note beside the button for an act that cannot be undone. */
  lock?: ReactNode;
  /** Anything else for the footer, after the button (a Cancel link). */
  extra?: ReactNode;
  id?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const cls = ["w-btn", primary && "w-pri", danger && "w-dng", (small || inline) && "w-sm"].filter(Boolean).join(" ");
  return (
    <form action={formAction} className={inline ? "w-form w-inline" : "w-form"} id={id}>
      {children}
      <div className="w-form-foot">
        <button className={cls} type="submit" disabled={pending}>
          {pending ? "Working…" : submit}
        </button>
        {extra}
        {lock && !state.notice && (
          <span className="w-lock">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            {lock}
          </span>
        )}
        {state.error && (
          <span className="w-said w-error" role="alert">
            {state.error}
          </span>
        )}
        {state.notice && (
          <span className="w-said" role="status">
            {state.notice}
          </span>
        )}
      </div>
    </form>
  );
}
