"use client";

import { useActionState, type ReactNode } from "react";

// A form on an administration page: its fields are whatever the page puts
// inside it, and its action is a server action that answers with what went
// wrong or what was done (app/admin/actions.ts). The button is disabled while
// the action runs, so an act that is not safe to make twice (creating owls)
// cannot be sent twice by a second click. What the action answers is shown
// beside the button; nothing is read back from the address bar.

export interface FormState {
  error?: string;
  notice?: string;
}

export type FormAction = (previous: FormState, formData: FormData) => Promise<FormState>;

export function ActionForm({
  action,
  submit,
  children,
  inline = false,
  danger = false,
}: {
  action: FormAction;
  /** The words on the button. */
  submit: string;
  children?: ReactNode;
  /** A one-button form that sits in a line of text or a table cell. */
  inline?: boolean;
  danger?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={inline ? "admin-form admin-form-inline" : "admin-form"}>
      {children}
      <div className="admin-form-foot">
        <button
          className={inline ? `linklike${danger ? " danger" : ""}` : "order-button"}
          type="submit"
          disabled={pending}
        >
          {pending ? "Working…" : submit}
        </button>
        {state.error && (
          <span className="admin-form-said admin-form-error" role="alert">
            {state.error}
          </span>
        )}
        {state.notice && (
          <span className="admin-form-said" role="status">
            {state.notice}
          </span>
        )}
      </div>
    </form>
  );
}
