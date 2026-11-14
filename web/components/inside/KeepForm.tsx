"use client";

import { useActionState, useTransition, type FormEvent, type ReactNode } from "react";
import type { FormAction } from "../admin/ActionForm";

// A form whose fields keep what was typed when the act is refused. A form
// sent as a form action comes back with its fields as they first were, which
// is right for a one-line form and wrong for a long one: a person whose
// policy version is refused for one category should not have to type the
// others again. So this sends the act itself and leaves the fields alone.
// Otherwise it is the administration pages' form (admin/ActionForm.tsx).
export function KeepForm({ action, submit, children }: { action: FormAction; submit: string; children?: ReactNode }) {
  const [state, formAction] = useActionState(action, {});
  const [pending, start] = useTransition();
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    start(() => formAction(data));
  };
  return (
    <form onSubmit={send} className="admin-form">
      {children}
      <div className="admin-form-foot">
        <button className="order-button" type="submit" disabled={pending}>
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
