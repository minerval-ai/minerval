"use client";

import { useActionState } from "react";
import {
  createGrantAction,
  type CreateGrantState,
} from "../../actions";

const POLICIES = [
  {
    value: "cover",
    label: "Cover",
    gloss:
      "Get every claim in the scope at least one assessment, breadth first.",
  },
  {
    value: "deepen",
    label: "Deepen",
    gloss:
      "Work through the scope's waiting and deferred claims — buying the " +
      "depth the background pipeline's economics leave as stubs.",
  },
  {
    value: "maintain",
    label: "Maintain",
    gloss: "Keep the scope fresh: reassess claims whose assessment has aged.",
  },
  {
    value: "agent",
    label: "Grantor agent",
    gloss:
      "An allocator agent surveys the scope and proposes a claim-by-claim " +
      "plan for your approval before anything is spent. Best for larger " +
      "budgets.",
  },
];

export function CreateGrantForm({ initialClaimId }: { initialClaimId: string }) {
  const [state, formAction, pending] = useActionState<CreateGrantState, FormData>(
    createGrantAction,
    {}
  );

  return (
    <form action={formAction} className="grant-form">
      <label>
        <span className="sc">Mandate name</span>
        <input
          name="name"
          type="text"
          required
          maxLength={200}
          placeholder="e.g. Nutrition science cruxes"
        />
        <span className="order-caption">
          Public: appears as &ldquo;funded by …&rdquo; on every assessment
          this grant pays for.
        </span>
      </label>

      <label>
        <span className="sc">Scope — claim (subtree)</span>
        <input
          name="scope_claim_id"
          type="text"
          defaultValue={initialClaimId}
          placeholder="claim id (optional if a topic query is given)"
        />
      </label>
      <label>
        <span className="sc">Scope — topic query</span>
        <input
          name="scope_query"
          type="text"
          maxLength={500}
          placeholder='e.g. "saturated fat cardiovascular" (optional)'
        />
      </label>

      <fieldset className="grant-policies">
        <legend className="sc">Policy</legend>
        {POLICIES.map((p, i) => (
          <label key={p.value} className="grant-policy">
            <input
              type="radio"
              name="policy"
              value={p.value}
              defaultChecked={i === 0}
            />
            <span>
              <strong>{p.label}</strong> — {p.gloss}
            </span>
          </label>
        ))}
      </fieldset>

      <label>
        <span className="sc">Budget (owls)</span>
        <input
          name="budget_owls"
          type="number"
          min={1}
          max={10000}
          step={1}
          defaultValue={10}
          required
        />
        <span className="order-caption">
          ≈ one Steward assessment per owl. Escrows now; unspent budget
          returns when the grant completes.
        </span>
      </label>

      <button type="submit" disabled={pending} className="order-button">
        {pending ? "funding…" : "Fund this grant"}
      </button>
      {state.error && <p className="form-error">{state.error}</p>}
    </form>
  );
}
