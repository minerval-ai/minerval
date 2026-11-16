"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OwlMark } from "../OwlMark";

// A mandate the Grantmaker drafted, with the one action that funds it. The
// granting conversation shows it under the transcript, and the Assistant's
// page shows it under a granting conversation the Assistant held: either
// way funding is the person's own press.

export interface MandateView {
  title: string;
  objective: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  plan: {
    strategy: string;
    items: Array<{
      action: "propose" | "assess" | "reassess" | "deepen" | "ingest";
      claim_id?: string;
      // A node the graph does not hold yet (#656): a propose item's kind
      // and wording, and the items that wait on it by its ref.
      claim_ref?: string;
      ref?: string;
      kind?: string;
      text?: string;
      url?: string;
      rationale: string;
    }>;
  };
  expected_cost_owls: number;
  notes: string | null;
  /**
   * What the funder must read before funding (a stake line that could
   * identify an anonymous funder, a quote likely to run over). The API
   * refuses to fund until they are acknowledged.
   */
  warnings?: Array<{ id: string; about: string; text: string }>;
}

/** What an item that waits on a proposal is for: the proposal's kind and wording. */
function proposedLabel(
  items: Array<{ action: string; ref?: string; kind?: string; text?: string }>,
  ref: string | undefined
): string {
  const p = items.find((it) => it.action === "propose" && it.ref === ref);
  return p ? `${p.kind}: “${p.text}”` : "node";
}

const ACTION_LABEL: Record<string, string> = {
  assess: "assess",
  reassess: "reassess",
  deepen: "deepen",
  ingest: "ingest source",
  propose: "propose",
};

export function MandateProposal({
  conversationId,
  mandate,
}: {
  conversationId: string;
  mandate: MandateView;
}) {
  const router = useRouter();
  const [budget, setBudget] = useState(mandate.expected_cost_owls);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warnings = mandate.warnings ?? [];
  const [acknowledged, setAcknowledged] = useState(false);

  const fund = async () => {
    if (funding) return;
    setFunding(true);
    setError(null);
    try {
      const res = await fetch(`/api/grant-conversations/${conversationId}/fund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          budget_owls: budget,
          ...(warnings.length > 0 && acknowledged
            ? { acknowledge_warnings: warnings.map((w) => w.id) }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Funding failed; nothing was escrowed.");
      } else {
        router.push(`/mandates/${data.grant_id}`);
      }
    } catch {
      setError("Funding failed; nothing was escrowed. Please try again.");
    } finally {
      setFunding(false);
    }
  };

  return (
    <aside className="mandate-card">
      <p className="sc">Proposed mandate</p>
      <h3>{mandate.title}</h3>
      <p>{mandate.objective}</p>
      <p className="mandate-strategy">{mandate.plan.strategy}</p>
      <ul className="mandate-items">
        {mandate.plan.items.map((item, i) => (
          <li key={i}>
            <span className="tag">{ACTION_LABEL[item.action] ?? item.action}</span>{" "}
            {item.action === "ingest" ? (
              <span className="mandate-target">{item.url}</span>
            ) : item.action === "propose" ? (
              <span className="mandate-target">
                a new {item.kind}, reviewed before it enters the graph: “{item.text}”
              </span>
            ) : !item.claim_id ? (
              <span className="mandate-target">
                the proposed {proposedLabel(mandate.plan.items, item.claim_ref)}
              </span>
            ) : (
              <a
                className="mandate-target"
                href={`/claims/${item.claim_id}`}
                target="_blank"
                rel="noreferrer"
              >
                view claim
              </a>
            )}
            <span className="mandate-rationale"> {item.rationale}</span>
          </li>
        ))}
      </ul>
      {mandate.notes && <p className="order-caption">{mandate.notes}</p>}
      {warnings.length > 0 && (
        <div className="mandate-warnings" role="note">
          <p className="sc">Before you fund</p>
          <ul>
            {warnings.map((w) => (
              <li key={w.id}>{w.text}</li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />{" "}
            I have read {warnings.length === 1 ? "this" : "these"} and want to fund it as drafted
          </label>
        </div>
      )}
      <div className="mandate-fund">
        <label>
          <span className="sc">Budget</span>
          <span className="mandate-budget">
            <OwlMark size={16} className="owl-mark" />
            <input
              type="number"
              min={mandate.expected_cost_owls}
              max={10000}
              step={1}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
            owls
          </span>
        </label>
        <button
          className="order-button"
          onClick={fund}
          disabled={funding || (warnings.length > 0 && !acknowledged)}
        >
          {funding ? "escrowing…" : `Fund this mandate (${budget} owls)`}
        </button>
        <span className="order-caption">
          The quote of {mandate.expected_cost_owls} owls is the expected
          cost, taken from live estimates. Funding escrows the full
          budget from your balance; the work is metered against it as it
          runs, and whatever is not spent returns when the mandate
          completes or you cancel it. If the budget runs out, the work
          pauses and waits for a top-up rather than overspending.
        </span>
        {error && <p className="form-error">{error}</p>}
      </div>
    </aside>
  );
}
