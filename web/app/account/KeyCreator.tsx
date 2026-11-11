"use client";

import { useActionState } from "react";
import { createKeyAction, type CreateKeyState } from "./actions";

// Client island so the one-time plaintext key can be shown inline after
// creation (it is never persisted anywhere — copy it or lose it).
// `extension` says whether this deployment has the browser extension, which
// is the example key name; without it the field gives no example.
export function KeyCreator({ extension = true }: { extension?: boolean }) {
  const [state, formAction, pending] = useActionState<CreateKeyState, FormData>(
    createKeyAction,
    {}
  );

  return (
    <div>
      <form action={formAction} className="key-create">
        <input
          name="name"
          placeholder={extension ? 'key name, e.g. "browser extension"' : "key name"}
          maxLength={120}
          required
          autoComplete="off"
        />
        <button type="submit" disabled={pending}>
          {pending ? "creating…" : "Create key"}
        </button>
      </form>
      {state.error && <p className="form-error">{state.error}</p>}
      {state.plaintext && (
        <div className="key-reveal" role="status">
          <p className="sc">
            new key “{state.name}”: copy it now; it will not be shown again
          </p>
          <code className="key-plaintext">{state.plaintext}</code>
        </div>
      )}
    </div>
  );
}
