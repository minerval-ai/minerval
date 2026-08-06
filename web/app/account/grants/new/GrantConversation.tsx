"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OwlMark } from "../../../../components/OwlMark";

// The granting conversation: delegating a mandate to the Grantmaker agent,
// with the feel of briefing a capable colleague who plans before spending.
// The transcript is the interface; when the agent drafts a mandate, the
// draft renders as a card beneath the conversation with one funding action.
// Nothing is charged for talking, and nothing runs until funding.

interface Message {
  role: "user" | "assistant";
  content: string;
  at: string;
}

interface MandateView {
  title: string;
  objective: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  plan: {
    strategy: string;
    items: Array<{
      action: "assess" | "reassess" | "deepen" | "ingest";
      claim_id?: string;
      url?: string;
      rationale: string;
    }>;
  };
  expected_cost_owls: number;
  notes: string | null;
}

interface ConversationView {
  id: string;
  status: "active" | "proposed" | "funded" | "declined" | "abandoned";
  messages: Message[];
  mandate: MandateView | null;
  grant_id: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  assess: "assess",
  reassess: "reassess",
  deepen: "deepen",
  ingest: "ingest source",
};

export function GrantConversation({
  initialClaimId,
}: {
  initialClaimId: string;
}) {
  const router = useRouter();
  const [convo, setConvo] = useState<ConversationView | null>(null);
  const [draft, setDraft] = useState(
    initialClaimId
      ? `I want to fund work on the area around claim ${initialClaimId}.`
      : ""
  );
  const [busy, setBusy] = useState(false);
  const [funding, setFunding] = useState(false);
  const [budget, setBudget] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [convo?.messages.length, busy]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    // Optimistic echo so the funder's message shows while the agent thinks.
    const optimistic: Message = {
      role: "user",
      content: message,
      at: new Date().toISOString(),
    };
    setConvo((c) =>
      c ? { ...c, messages: [...c.messages, optimistic] } : c
    );
    setDraft("");
    try {
      const res = convo
        ? await fetch(`/api/grant-conversations/${convo.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          })
        : await fetch(`/api/grant-conversations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong; your message was not lost.");
        setDraft(message);
        setConvo((c) =>
          c ? { ...c, messages: c.messages.filter((m) => m !== optimistic) } : c
        );
      } else {
        setConvo(data.conversation);
        if (data.conversation?.mandate) {
          setBudget(data.conversation.mandate.expected_cost_owls);
        }
      }
    } catch {
      setError("The Grantmaker could not be reached. Please try again.");
      setDraft(message);
    } finally {
      setBusy(false);
    }
  };

  const fund = async () => {
    if (!convo?.mandate || funding) return;
    setFunding(true);
    setError(null);
    try {
      const res = await fetch(`/api/grant-conversations/${convo.id}/fund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          budget_owls: budget ?? convo.mandate.expected_cost_owls,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Funding failed; nothing was escrowed.");
      } else {
        router.push(`/account/grants/${data.grant_id}`);
      }
    } catch {
      setError("Funding failed; nothing was escrowed. Please try again.");
    } finally {
      setFunding(false);
    }
  };

  const mandate = convo?.status === "proposed" ? convo.mandate : null;

  return (
    <div className="grant-convo">
      {!convo && (
        <p className="order-line">
          Describe what you want in your own words: a topic that deserves
          coverage, a claim whose subtree deserves depth, an article or
          series to bring into the graph, a standing interest to keep fresh.
          Detail helps, but it is not required; the Grantmaker will ask about
          anything it needs.
        </p>
      )}

      {convo && (
        <div className="grant-convo-transcript" role="log">
          {convo.messages.map((m, i) => (
            <div
              key={`${m.at}-${i}`}
              className={
                m.role === "user" ? "convo-msg convo-user" : "convo-msg convo-agent"
              }
            >
              <span className="sc convo-who">
                {m.role === "user" ? "you" : "grantmaker"}
              </span>
              <div className="convo-body">{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="convo-msg convo-agent">
              <span className="sc convo-who">grantmaker</span>
              <div className="convo-body convo-thinking">
                surveying the graph…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {mandate && (
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
                  value={budget ?? mandate.expected_cost_owls}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
                owls
              </span>
            </label>
            <button
              className="order-button"
              onClick={fund}
              disabled={funding}
            >
              {funding
                ? "escrowing…"
                : `Fund this mandate (${budget ?? mandate.expected_cost_owls} owls)`}
            </button>
            <span className="order-caption">
              The quote of {mandate.expected_cost_owls} owls is the expected
              cost, taken from live estimates. Funding escrows the full
              budget from your balance; the work is metered against it as it
              runs, and whatever is not spent returns when the mandate
              completes or you cancel it. If the budget runs out, the work
              pauses and waits for a top-up rather than overspending.
            </span>
          </div>
        </aside>
      )}

      <div className="grant-convo-input">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder={
            convo
              ? "Reply to the Grantmaker…"
              : "What should this mandate accomplish?"
          }
          disabled={busy}
        />
        <button
          className="order-button"
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
        >
          {busy ? "thinking…" : convo ? "Send" : "Start the conversation"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
