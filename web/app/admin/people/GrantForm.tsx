"use client";

import { useActionState, useState } from "react";
import { grantAction } from "../actions";

// The form in the Grant access drawer. A client component only so that the
// label or party it asks for follows the permission chosen: reading and
// opening raw sources are granted at one label, consent for one party, and
// the rest take neither. The act is the shared grantAction, unchanged.

export interface GrantChoices {
  permissions: Array<{ name: string; title: string; blurb: string; scope: "none" | "label" | "party" }>;
  people: Array<{ id: string; name: string; email: string | null; holds: string }>;
  labels: string[];
  parties: Array<{ id: string; name: string }>;
}

export function GrantForm({ choices, account }: { choices: GrantChoices; account?: string }) {
  const [state, action, pending] = useActionState(grantAction, {});
  const [to, setTo] = useState<"person" | "group">("person");
  const [permission, setPermission] = useState("");
  const [person, setPerson] = useState(account && choices.people.some((p) => p.id === account) ? account : "");
  const scope = choices.permissions.find((p) => p.name === permission)?.scope ?? "none";
  const chosen = choices.people.find((p) => p.id === person);

  return (
    <form action={action} className="w-form">
      <div className="w-field">
        <span className="w-label">Who</span>
        <div className="w-seg" role="radiogroup" aria-label="Grant to">
          <label>
            <input type="radio" name="to" value="person" checked={to === "person"} onChange={() => setTo("person")} />
            Person
          </label>
          <label title="A group, as your identity provider names it">
            <input type="radio" name="to" value="group" checked={to === "group"} onChange={() => setTo("group")} />
            Group
          </label>
        </div>
        {to === "person" ? (
          <>
            <select className="w-select" name="account_id" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person" required>
              <option value="" disabled>
                Choose a person
              </option>
              {choices.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.email ? ` (${p.email})` : ""}
                </option>
              ))}
            </select>
            <span className="w-help">{chosen ? (chosen.holds ? `Holds ${chosen.holds}` : "Holds nothing yet") : "Everyone who has signed in is listed."}</span>
          </>
        ) : (
          <>
            <input className="w-input" name="group" maxLength={256} autoComplete="off" aria-label="Group" placeholder="finance-leads" required />
            <span className="w-help">The group&rsquo;s name exactly as your identity provider sends it.</span>
          </>
        )}
      </div>

      <fieldset className="w-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="w-label" style={{ marginBottom: 5 }}>
          Permission
        </legend>
        <div className="w-options">
          {choices.permissions.map((p) => (
            <label key={p.name} className="w-option">
              <input type="radio" name="permission" value={p.name} checked={permission === p.name} onChange={() => setPermission(p.name)} required />
              <div>
                <b>{p.title}</b>
                <span>{p.blurb}</span>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {scope === "label" && (
        <div className="w-field">
          <label htmlFor="grant-label">Label</label>
          <select className="w-select" id="grant-label" name="label" defaultValue="" required>
            <option value="" disabled>
              Choose a label
            </option>
            {choices.labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <span className="w-help">
            {choices.labels.length === 0 ? "No label besides public is defined yet." : "Granted at that label alone."}
          </span>
        </div>
      )}
      {scope === "party" && (
        <div className="w-field">
          <label htmlFor="grant-party">Party</label>
          <select className="w-select" id="grant-party" name="party_id" defaultValue="" required>
            <option value="" disabled>
              Choose a party
            </option>
            {choices.parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="w-help">{choices.parties.length === 0 ? "No party is recorded yet." : "Granted for that party alone."}</span>
        </div>
      )}

      <div className="w-form-foot">
        <button className="w-btn w-pri" type="submit" disabled={pending}>
          {pending ? "Working…" : "Grant"}
        </button>
        {!state.notice && !state.error && <span className="w-faint w-small">Logged. Removing it later marks it removed; it&rsquo;s never deleted.</span>}
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
