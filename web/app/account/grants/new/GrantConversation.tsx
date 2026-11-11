"use client";

import { useEffect, useRef, useState } from "react";
import {
  MandateProposal,
  type MandateView,
} from "../../../../components/account/MandateProposal";
import {
  failedTurnMessage,
  waitForReply,
  type GrantTurn,
} from "../../../../lib/grant-turn";

// The granting conversation: delegating a mandate to the Grantmaker agent,
// with the feel of briefing a capable colleague who plans before spending.
// The transcript is the interface; when the agent drafts a mandate, the
// draft renders as a card beneath the conversation with one funding action.
// Nothing is charged for talking, and nothing runs until funding.

interface Message {
  role: "user" | "assistant";
  content: string;
  at: string;
  /** Set on a message the funder's Assistant wrote for them. */
  via?: "assistant";
}

interface ConversationView {
  id: string;
  status: "active" | "proposed" | "funded" | "declined" | "abandoned";
  messages: Message[];
  mandate: MandateView | null;
  turn?: GrantTurn;
  grant_id: string | null;
}

export function GrantConversation({
  initialClaimId,
}: {
  initialClaimId: string;
}) {
  const [convo, setConvo] = useState<ConversationView | null>(null);
  const [draft, setDraft] = useState(
    initialClaimId
      ? `I want to fund work on the area around claim ${initialClaimId}.`
      : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [convo?.messages.length, convo?.turn?.partial, busy]);

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
        // Saved; the reply follows in the background.
        setConvo(data.conversation);
        const done = await waitForReply<ConversationView>(
          data.conversation,
          setConvo,
          () => !mounted.current
        );
        setError(failedTurnMessage(done.turn));
      }
    } catch {
      setError("The Grantmaker could not be reached. Please try again.");
      setDraft(message);
    } finally {
      setBusy(false);
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
                {m.role !== "user"
                  ? "grantmaker"
                  : m.via === "assistant"
                    ? "your assistant"
                    : "you"}
              </span>
              <div className="convo-body">{m.content}</div>
            </div>
          ))}
          {busy && (
            <div className="convo-msg convo-agent">
              <span className="sc convo-who">grantmaker</span>
              {convo?.turn?.partial ? (
                // The reply as the Grantmaker writes it.
                <div className="convo-body">{convo.turn.partial}</div>
              ) : (
                <div className="convo-body convo-thinking">
                  surveying the graph…
                </div>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {mandate && convo && (
        <MandateProposal
          key={JSON.stringify(mandate)}
          conversationId={convo.id}
          mandate={mandate}
        />
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
