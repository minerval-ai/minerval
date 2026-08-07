"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// The manager's line to the Grantmaker after funding: the same conversation
// that designed the mandate, now in management mode. The agent can query
// the live grant (spend, pipeline, importance statistics) and amend the
// unexecuted remainder of the plan; the page refreshes after each exchange
// so any adjustment is immediately visible above.

interface Message {
  role: "user" | "assistant";
  content: string;
  at: string;
}

interface ConversationView {
  id: string;
  messages: Message[];
}

export function MandateChat({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [convo, setConvo] = useState<ConversationView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/grant-conversations/${conversationId}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setConvo(data.conversation);
        }
      } catch {
        // The transcript is a nicety; the composer still works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [convo?.messages.length, busy]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    const optimistic: Message = {
      role: "user",
      content: message,
      at: new Date().toISOString(),
    };
    setConvo((c) =>
      c
        ? { ...c, messages: [...c.messages, optimistic] }
        : { id: conversationId, messages: [optimistic] }
    );
    setDraft("");
    try {
      const res = await fetch(
        `/api/grant-conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The Grantmaker could not be reached.");
        setDraft(message);
      } else {
        setConvo(data.conversation);
        // An exchange may have amended the plan; refresh the page above.
        router.refresh();
      }
    } catch {
      setError("The Grantmaker could not be reached. Please try again.");
      setDraft(message);
    } finally {
      setBusy(false);
    }
  };

  // Show the recent tail; the mandate's design discussion stays scrollable.
  const messages = convo?.messages ?? [];

  return (
    <div className="grant-convo">
      {messages.length > 0 && (
        <div className="grant-convo-transcript" role="log">
          {messages.map((m, i) => (
            <div
              key={`${m.at}-${i}`}
              className={
                m.role === "user"
                  ? "convo-msg convo-user"
                  : "convo-msg convo-agent"
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
                looking at the numbers…
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
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
          rows={2}
          placeholder="Ask about progress, the pipeline, the numbers, or redirect the remaining budget…"
          disabled={busy}
        />
        <button
          className="order-button"
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
        >
          {busy ? "thinking…" : "Send"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
