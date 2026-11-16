"use client";

import { useActionState } from "react";
import { LabelChoice } from "../../components/admin/LabelChoice";
import type { MyLabels } from "../../lib/admin-api";
import { createKeyAction, type CreateKeyState } from "./actions";

// Client island so the one-time plaintext key can be shown inline after
// creation (it is never persisted anywhere — copy it or lose it).
// `extension` says whether this deployment has the browser extension, which
// is the example key name; without it the field gives no example. Where the
// deployment holds material at more than one label, `labels` asks which one
// the key works at: an agent holding the key reads and writes there alone.
export function KeyCreator({
  extension = true,
  labels,
}: {
  extension?: boolean;
  labels?: MyLabels | null;
}) {
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
        {labels && (
          <LabelChoice
            mine={labels}
            what="The label the key works at, for its whole life: whatever holds it reads what that label reads and files what it adds there. Make one key for each label you want an agent to work at."
          />
        )}
        <button type="submit" disabled={pending}>
          {pending ? "creating…" : "Create key"}
        </button>
      </form>
      {state.error && <p className="form-error">{state.error}</p>}
      {state.plaintext && (
        <div className="key-reveal" role="status">
          <p className="sc">
            new key “{state.name}”{state.label ? ` at ${state.label}` : ""}: copy it now; it will not be shown again
          </p>
          <code className="key-plaintext">{state.plaintext}</code>
        </div>
      )}
    </div>
  );
}
