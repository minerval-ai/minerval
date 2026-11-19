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
  organizations = [],
}: {
  extension?: boolean;
  labels?: MyLabels | null;
  /**
   * Organizations the person may act for: a key can be made to act as one
   * (docs/organizations.md, "Other credentials"). Empty, it acts as them.
   */
  organizations?: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState<CreateKeyState, FormData>(
    createKeyAction,
    {}
  );

  // With a label to choose, the form stacks: the choice and its account of
  // who reads each label above, the name and the button on one row below.
  // On one row the three crushed the name field to nothing.
  const choosing = labels?.must_choose === true;
  const actsAs =
    organizations.length > 0 ? (
      <select name="acting_for" aria-label="Who the key acts as" defaultValue="">
        <option value="">acts as you</option>
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            acts as {o.name}
          </option>
        ))}
      </select>
    ) : null;
  const nameAndSubmit = (
    <>
      {actsAs}
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
    </>
  );

  return (
    <div>
      {choosing && labels ? (
        <form action={formAction} className="key-create-stack">
          <LabelChoice
            mine={labels}
            what="The label the key works at, for its whole life: whatever holds it reads what that label reads and files what it adds there. Make one key for each label you want an agent to work at."
          />
          <div className="key-create">{nameAndSubmit}</div>
        </form>
      ) : (
        <form action={formAction} className="key-create">
          {nameAndSubmit}
        </form>
      )}
      {state.error && <p className="form-error">{state.error}</p>}
      {state.plaintext && (
        <div className="key-reveal" role="status">
          <p className="sc">
            new key “{state.name}”{state.label ? ` at ${state.label}` : ""}
            {state.actingFor ? `, acting as ${organizations.find((o) => o.id === state.actingFor)?.name ?? "an organization"}` : ""}: copy it now;
            it will not be shown again
          </p>
          <code className="key-plaintext">{state.plaintext}</code>
        </div>
      )}
    </div>
  );
}
