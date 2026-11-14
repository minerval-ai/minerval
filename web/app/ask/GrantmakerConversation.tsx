"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { MandateProposal, type MandateView } from "../../components/account/MandateProposal";
import { failedTurnMessage, waitForReply, type GrantTurn } from "../../lib/grant-turn";

// A conversation with a Grantmaker, in the Ask section's shell. It is one
// conversation from the first sentence on: the funder describes what they
// want, the Grantmaker drafts a mandate and quotes its cost, the funder
// funds it, and from then on the same conversation is how they manage it
// (ask how the work is going, redirect what remains, change the pace).
//
// The Assistant works for the user; a Grantmaker works for the graph, and
// says so. That is why this is its own conversation and not a mode of the
// Assistant's: the reader should always know which of the two they are
// talking to.

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

export function GrantmakerConversation({
  conversationId,
  title,
  mandateHref,
  managing = false,
  initialDraft = "",
  suggestions = [],
  panel,
  children,
}: {
  /** The conversation to open; absent for one not yet started. */
  conversationId?: string;
  /** What the bar says this conversation is about. */
  title: string;
  /** The mandate's page, once there is one. */
  mandateHref?: string;
  /** Whether the mandate is funded, so the conversation is charged to it. */
  managing?: boolean;
  initialDraft?: string;
  /** Things to say that the panel's controls put in the composer. */
  suggestions?: Array<{ label: string; text: string }>;
  /** The mandate at a glance, beside the conversation. */
  panel?: ReactNode;
  /** Shown in place of a transcript before the first message. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [convo, setConvo] = useState<ConversationView | null>(null);
  const [loading, setLoading] = useState(!!conversationId);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Open an existing conversation, and wait out a reply that is under way.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/grant-conversations/${conversationId}`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setError("This conversation could not be read.");
          return;
        }
        const data = (await res.json()) as { conversation: ConversationView };
        if (cancelled) return;
        setConvo(data.conversation);
        if (data.conversation?.turn?.state === "replying") {
          setBusy(true);
          const done = await waitForReply<ConversationView>(data.conversation, setConvo, () => cancelled);
          if (!cancelled) {
            setBusy(false);
            setError(failedTurnMessage(done.turn));
            router.refresh();
          }
        }
      } catch {
        if (!cancelled) setError("This conversation could not be read.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [convo?.messages.length, convo?.turn?.partial, busy]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    // The funder's message shows at once, while the Grantmaker thinks.
    const optimistic: Message = { role: "user", content: message, at: new Date().toISOString() };
    setConvo((c) => (c ? { ...c, messages: [...c.messages, optimistic] } : c));
    setDraft("");
    const starting = !convo;
    try {
      const res = await fetch(
        convo ? `/api/grant-conversations/${convo.id}/messages` : `/api/grant-conversations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong; your message was not lost.");
        setDraft(message);
        setConvo((c) => (c ? { ...c, messages: c.messages.filter((m) => m !== optimistic) } : c));
        return;
      }
      // Saved; the reply follows in the background. A send returns the
      // message's place and the turn, not the transcript (#905), so the chat
      // shows its own copy until the first read brings the saved one.
      const sent = data.conversation as Pick<ConversationView, "id" | "status" | "grant_id" | "turn">;
      const pending: ConversationView = {
        id: sent.id,
        status: sent.status,
        grant_id: sent.grant_id,
        turn: sent.turn,
        mandate: convo?.mandate ?? null,
        messages: [...(convo?.messages ?? []), optimistic],
      };
      setConvo(pending);
      // A conversation just begun gets its own address, so a reload or the
      // sidebar comes back to it. The address changes without a navigation:
      // this component keeps the reply it is waiting for.
      if (starting) window.history.replaceState(null, "", `/ask/mandates/c/${sent.id}`);
      const done = await waitForReply<ConversationView>(pending, setConvo, () => !mounted.current);
      setError(failedTurnMessage(done.turn));
      // An exchange may have amended the plan or the pace; the panel and the
      // sidebar are read again.
      router.refresh();
    } catch {
      setError("The Grantmaker could not be reached. Please try again.");
      setDraft(message);
    } finally {
      setBusy(false);
    }
  };

  const proposal = convo?.status === "proposed" ? convo.mandate : null;
  const funded = convo?.status === "funded" && convo.grant_id;
  const messages = convo?.messages ?? [];
  const closed = convo?.status === "declined" || convo?.status === "abandoned";

  return (
    <div className="ask-chat">
      <div className="ask-col">
        <div className="ask-bar">
          <span className="ask-bar-title" title={title}>
            <span className="askm-who">Grantmaker</span> {title}
          </span>
          {mandateHref && (
            <Link href={mandateHref} className="askm-bar-link">
              The mandate&rsquo;s page →
            </Link>
          )}
        </div>
        {panel && (
          <details className="askm-fold">
            <summary>Budget, pace and controls</summary>
            <div className="askm-panel">{panel}</div>
          </details>
        )}

        <div className="ask-scroll">
          <div className="ask-transcript" role="log">
            {!convo && !loading && children}
            {loading && <p className="order-line">Opening the conversation…</p>}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={`${m.at}-${i}`} className="ask-msg ask-msg-user">
                  {m.via === "assistant" && <span className="sc convo-who">your assistant, for you</span>}
                  <div className="ask-bubble">{m.content}</div>
                </div>
              ) : (
                <div key={`${m.at}-${i}`} className="ask-msg ask-msg-assistant">
                  <span className="sc convo-who">grantmaker</span>
                  <div className="convo-body">{m.content}</div>
                </div>
              )
            )}
            {busy && (
              <div className="ask-msg ask-msg-assistant" aria-live="polite">
                <span className="sc convo-who">grantmaker</span>
                {convo?.turn?.partial ? (
                  <div className="convo-body">{convo.turn.partial}</div>
                ) : (
                  <div className="convo-body convo-thinking">
                    {convo?.turn?.progress?.steps
                      ? `${convo.turn.progress.note}…`
                      : managing
                        ? "looking at the mandate…"
                        : "surveying the graph…"}
                  </div>
                )}
              </div>
            )}
            {proposal && convo && (
              <MandateProposal key={JSON.stringify(proposal)} conversationId={convo.id} mandate={proposal} />
            )}
            {funded && !managing && (
              <p className="ask-notice">
                Funded. <Link href={`/mandates/${convo.grant_id}`}>Open the mandate →</Link>
              </p>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="ask-dock">
          {closed ? (
            <p className="ask-notice">
              This conversation is closed. <Link href="/ask/mandates/new">Start another →</Link>
            </p>
          ) : (
            <div className="ask-composer">
              {suggestions.length > 0 && (
                <div className="askm-suggest">
                  {suggestions.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="linklike"
                      onClick={() => {
                        setDraft(s.text);
                        boxRef.current?.focus();
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={boxRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={
                  managing
                    ? "Ask how the work is going, or redirect what remains…"
                    : convo
                      ? "Reply to the Grantmaker…"
                      : "What should this mandate accomplish?"
                }
                aria-label="Your message to the Grantmaker"
                disabled={busy || loading}
              />
              <div className="ask-composer-row">
                <span className="ask-model">Grantmaker</span>
                <button
                  className="order-button"
                  onClick={() => void send()}
                  disabled={busy || loading || !draft.trim()}
                >
                  {busy ? "Thinking…" : "Send"}
                </button>
              </div>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="ask-bill">
            <span>
              {managing
                ? "Charged to the mandate’s budget, at what the Grantmaker’s work costs."
                : "Talking costs nothing. Owls are escrowed only when you fund a proposal."}
            </span>
            <span>
              A Grantmaker works for the graph, not for you: it declines a mandate that would steer a conclusion.
            </span>
          </div>
        </div>
      </div>

      <aside className="ask-panel askm-panel" aria-label="The mandate">
        {panel}
      </aside>
    </div>
  );
}
