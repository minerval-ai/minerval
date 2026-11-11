"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { OwlMark } from "../../components/OwlMark";
import { StandingBadge, StatusBadge } from "../../components/Assessment";
import { statusMeta } from "../../lib/ontology";
import {
  MandateProposal,
  type MandateView,
} from "../../components/account/MandateProposal";
import type {
  AssistantCitationView,
  AssistantConversationView,
  AssistantHeldActionView,
  AssistantMessageView,
  AssistantModelView,
} from "../../lib/account-api";

// A conversation with the Assistant: the agent that works for the signed-in
// user with their account's tools. The transcript is the page. Under a reply
// sit what it cites from the graph, what the run did and cost, and cards:
// an action waiting on the user (one that spends owls on the graph or
// publishes under their name), a receipt for one that ran, and a granting
// conversation the Assistant held for them.
//
// The Assistant has no cap: its work is charged as it runs, so the page
// always shows what the conversation has cost, what the running reply has
// cost so far, the balance, and a stop button.

type Convo = AssistantConversationView;

const POLL_MS = 1_500;
const CITE_RE = /(\s*)\[claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** Micro-USD of metered cost as owls (one owl covers $1.00). */
function owls(microUsd: number): string {
  const n = Math.max(0, microUsd) / 1_000_000;
  if (n > 0 && n < 0.01) return "under 0.01";
  return Number(n.toFixed(2)).toString();
}

function Owls({ microUsd }: { microUsd: number }) {
  return (
    <span className="ask-owls">
      <OwlMark size={13} className="owl-mark" />
      {owls(microUsd)}
    </span>
  );
}

/**
 * The reply's markdown with each [claim:<uuid>] turned into a numbered link.
 * A marker whose node the graph does not hold is dropped.
 */
function withCitations(content: string, citations: AssistantCitationView[]): string {
  const number = new Map(citations.map((c, i) => [c.id, i + 1]));
  return content.replace(CITE_RE, (_m, space: string, id: string) => {
    const n = number.get(id.toLowerCase());
    return n ? `${space}[${n}](/claims/${id.toLowerCase()} "cite")` : "";
  });
}

function Prose({
  content,
  citations = [],
}: {
  content: string;
  citations?: AssistantCitationView[];
}) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const components: Components = {
    a: ({ href, title, children }) => {
      const cited = title === "cite" && href ? byId.get(href.replace("/claims/", "")) : undefined;
      if (cited) {
        const meta = cited.kind === "claim" ? statusMeta(cited.status) : null;
        return (
          <Link
            href={href!}
            className={`ask-cite${meta ? ` ${meta.cls}` : ""}`}
            title={`${cited.text}${meta ? ` (${meta.label})` : ""}`}
          >
            {children}
            {meta && <span aria-hidden>{meta.glyph}</span>}
          </Link>
        );
      }
      const external = !!href && /^https?:\/\//.test(href);
      return (
        <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
          {children}
        </a>
      );
    },
  };
  return (
    <div className="ask-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {withCitations(content, citations)}
      </ReactMarkdown>
    </div>
  );
}

function Cited({ citations }: { citations: AssistantCitationView[] }) {
  if (citations.length === 0) return null;
  return (
    <ol className="ask-cited">
      {citations.map((c) => (
        <li key={c.id}>
          <Link href={`/claims/${c.id}`}>{c.text}</Link>{" "}
          {c.kind === "claim" ? (
            <StatusBadge status={c.status} />
          ) : c.kind === "question" ? (
            <StandingBadge standing={c.standing} />
          ) : (
            <span className="tag kind">{c.kind}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A tool's input as the person would check it: one line per field. */
function InputFields({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <dl className="ask-fields">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key.replace(/_/g, " ")}</dt>
          <dd>{typeof value === "string" ? value : JSON.stringify(value, null, 1)}</dd>
        </div>
      ))}
    </dl>
  );
}

function resultText(action: AssistantHeldActionView): string {
  const text = action.result?.text ?? "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function HeldCard({
  conversationId,
  action,
  onChange,
}: {
  conversationId: string;
  action: AssistantHeldActionView;
  onChange: (convo: Convo) => void;
}) {
  const [busy, setBusy] = useState<"run" | "decline" | null>(null);
  const [allow, setAllow] = useState<"" | "conversation" | "always">("");
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "run" | "decline") => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(
        `/api/assistant/conversations/${conversationId}/held/${action.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(decision === "run" && allow ? { allow: { scope: allow } } : {}),
          }),
        }
      );
      const data = await res.json();
      if (data.conversation) onChange(data.conversation);
      if (!res.ok) setError(data.error ?? "That did not go through. Nothing was done.");
    } catch {
      setError("That did not go through. Nothing was done.");
    } finally {
      setBusy(null);
    }
  };

  const waiting = action.status === "held";
  const state = waiting
    ? "Waiting for you"
    : action.status === "running"
      ? "Running"
      : action.status === "declined"
        ? "You declined this"
        : action.ran_without_asking
          ? action.status === "done"
            ? "Ran without asking"
            : "Tried without asking; it failed"
          : action.status === "done"
            ? "You ran this"
            : "You ran this; it failed";

  return (
    <aside className={`ask-card ask-card-${action.status}`}>
      <p className="sc">{state}</p>
      <p className="ask-card-title">
        {action.label} <code>{action.tool}</code>
      </p>
      <InputFields input={action.input} />
      {waiting && (
        <div className="ask-card-actions">
          <button className="order-button" onClick={() => void decide("run")} disabled={!!busy}>
            {busy === "run" ? "running…" : "Run it"}
          </button>
          <button className="linklike" onClick={() => void decide("decline")} disabled={!!busy}>
            {busy === "decline" ? "declining…" : "Decline"}
          </button>
          <label className="ask-allow">
            <select
              value={allow}
              onChange={(e) => setAllow(e.target.value as typeof allow)}
              disabled={!!busy}
              aria-label={`Whether to ask again before: ${action.kind_label}`}
            >
              <option value="">Ask me each time</option>
              <option value="conversation">Don&rsquo;t ask again in this conversation</option>
              <option value="always">Don&rsquo;t ask again, in any conversation</option>
            </select>
            {allow && <span>Applies to: {action.kind_label.toLowerCase()}.</span>}
          </label>
        </div>
      )}
      {waiting && (
        <span className="order-caption">
          Nothing has happened yet. The Assistant prepared this and cannot run it: it waits
          for you because it spends owls or publishes under your name. The Assistant learns
          what you chose with your next message.
        </span>
      )}
      {action.ran_without_asking && (
        <span className="order-caption">
          You allow this kind of action to run without asking ({action.kind_label.toLowerCase()}).
        </span>
      )}
      {action.result?.text && (
        <details className="ask-result">
          <summary>{action.status === "failed" ? "What came back" : "The result"}</summary>
          <pre>{resultText(action)}</pre>
        </details>
      )}
      {error && <p className="form-error">{error}</p>}
    </aside>
  );
}

interface GrantThreadView {
  id: string;
  status: "active" | "proposed" | "funded" | "declined" | "abandoned";
  messages: Array<{ role: "user" | "assistant"; content: string; at: string; via?: "assistant" }>;
  mandate: MandateView | null;
  grant_id: string | null;
  turn?: { state: "replying" | "idle" | "failed"; partial?: string | null; error?: string | null };
}

/** A granting conversation the Assistant held for the user, read in place. */
function GrantThread({ id }: { id: string }) {
  const [thread, setThread] = useState<GrantThreadView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const res = await fetch(`/api/grant-conversations/${id}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setMissing(true);
          return;
        }
        const data = (await res.json()) as { conversation: GrantThreadView };
        setThread(data.conversation);
        if (data.conversation.turn?.state === "replying") timer = setTimeout(read, POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(read, POLL_MS * 2);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (missing) return null;
  return (
    <aside className="ask-card">
      <p className="sc">With the Grantmaker</p>
      {!thread && <p className="convo-thinking">loading the conversation…</p>}
      {thread && (
        <div className="ask-thread" role="log">
          {thread.messages.map((m, i) => (
            <div
              key={`${m.at}-${i}`}
              className={m.role === "user" ? "convo-msg convo-user" : "convo-msg convo-agent"}
            >
              <span className="sc convo-who">
                {m.role !== "user" ? "grantmaker" : m.via === "assistant" ? "your assistant" : "you"}
              </span>
              <div className="convo-body">{m.content}</div>
            </div>
          ))}
          {thread.turn?.state === "replying" && (
            <div className="convo-msg convo-agent">
              <span className="sc convo-who">grantmaker</span>
              <div className={thread.turn.partial ? "convo-body" : "convo-body convo-thinking"}>
                {thread.turn.partial || "surveying the graph…"}
              </div>
            </div>
          )}
        </div>
      )}
      {thread?.turn?.state === "failed" && (
        <p className="form-error">
          The Grantmaker could not reply{thread.turn.error ? ` (${thread.turn.error})` : ""}.
        </p>
      )}
      {thread?.status === "proposed" && thread.mandate && (
        <MandateProposal
          key={JSON.stringify(thread.mandate)}
          conversationId={thread.id}
          mandate={thread.mandate}
        />
      )}
      {thread?.status === "funded" && thread.grant_id && (
        <p className="order-line">
          Funded. <Link href={`/account/grants/${thread.grant_id}`}>See the grant</Link>.
        </p>
      )}
    </aside>
  );
}

function ReplyFoot({ message }: { message: AssistantMessageView }) {
  const parts: ReactNode[] = [];
  if (message.stopped) {
    parts.push(
      <span key="stopped" className="ask-stopped">
        {message.stopped === "user" ? "You stopped this reply" : "Stopped: your balance ran out"}
      </span>
    );
  }
  if (message.worked && message.worked.length > 0) {
    parts.push(
      <span key="worked">
        {message.worked.map((w) => (w.count > 1 ? `${w.tool} ×${w.count}` : w.tool)).join(", ")}
      </span>
    );
  }
  if (typeof message.cost_micro_usd === "number") {
    parts.push(
      <span key="cost">
        <Owls microUsd={message.cost_micro_usd} /> owls
      </span>
    );
  }
  if (parts.length === 0) return null;
  return <p className="ask-foot">{parts}</p>;
}

export function AssistantConversation({
  initial,
  models,
  balanceMicroUsd,
  allowedAlways,
  kindLabels,
  nodeId,
}: {
  initial: Convo | null;
  models: AssistantModelView[];
  balanceMicroUsd: number;
  allowedAlways: string[];
  kindLabels: Record<string, string>;
  /** The node whose page the conversation is being opened from, if any. */
  nodeId?: string;
}) {
  const router = useRouter();
  const [convo, setConvo] = useState<Convo | null>(initial);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(
    initial?.model ?? models.find((m) => m.default)?.id ?? models[0]?.id ?? ""
  );
  const [always, setAlways] = useState(initial?.allowed_kinds.always ?? allowedAlways);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const replying = convo?.turn.state === "replying";
  const balance = convo?.balance_micro_usd ?? balanceMicroUsd;
  const heldById = new Map((convo?.held_actions ?? []).map((h) => [h.id, h]));

  // Read the conversation while its turn runs: the reply as it forms, the
  // progress line, and the cost so far.
  const id = convo?.id;
  useEffect(() => {
    if (!id || !replying) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/assistant/conversations/${id}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { conversation?: Convo };
        if (data.conversation && !cancelled) setConvo(data.conversation);
      } catch {
        // a dropped read; the next tick tries again
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, replying]);

  useEffect(() => {
    if (replying) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [convo?.messages.length, convo?.turn.partial, replying]);

  const send = async () => {
    const message = draft.trim();
    if (!message || sending || replying) return;
    setSending(true);
    setError(null);
    try {
      const res = convo
        ? await fetch(`/api/assistant/conversations/${convo.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          })
        : await fetch(`/api/assistant/conversations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message, model, ...(nodeId ? { node_id: nodeId } : {}) }),
          });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Your message was not sent.");
      } else if (!convo) {
        // The conversation has an address of its own from its first message.
        router.push(`/ask/c/${data.conversation.id}`);
        return;
      } else {
        setDraft("");
        setConvo(data.conversation);
      }
    } catch {
      setError("The Assistant could not be reached. Your message was not sent.");
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!convo) return;
    setConvo({ ...convo, turn: { ...convo.turn, stopping: true } });
    await fetch(`/api/assistant/conversations/${convo.id}/stop`, { method: "POST" }).catch(
      () => undefined
    );
  };

  const chooseModel = async (next: string) => {
    setModel(next);
    if (!convo) return;
    try {
      const res = await fetch(`/api/assistant/conversations/${convo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: next }),
      });
      const data = await res.json();
      if (res.ok && data.conversation) setConvo(data.conversation);
      else setError(data.error ?? "The model was not changed.");
    } catch {
      setError("The model was not changed.");
    }
  };

  const toggleAlways = async (kind: string, on: boolean) => {
    const next = on ? [...new Set([...always, kind])] : always.filter((k) => k !== kind);
    const before = always;
    setAlways(next);
    try {
      const res = await fetch(`/api/assistant/allowance`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kinds: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAlways(data.kinds);
    } catch {
      setAlways(before);
      setError("That setting was not saved.");
    }
  };

  const remove = async () => {
    if (!convo) return;
    if (!window.confirm("Delete this conversation? What it cost stays in your owl history.")) return;
    const res = await fetch(`/api/assistant/conversations/${convo.id}`, { method: "DELETE" });
    if (res.ok) router.push("/ask");
    else setError("The conversation was not deleted.");
  };

  const labels = convo?.allowed_kinds.labels ?? kindLabels;
  const inConversation = convo?.allowed_kinds.conversation ?? [];
  const allowedNames = [...new Set([...always, ...inConversation])].map(
    (k) => (labels[k] ?? k).toLowerCase()
  );
  const modelName = (convo?.models ?? models).find((m) => m.id === model)?.name ?? model;

  return (
    <div className="ask">
      {convo && (
        <div className="ask-transcript" role="log">
          {convo.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={`${m.at}-${i}`} className="convo-msg convo-user">
                <span className="sc convo-who">you</span>
                <div className="convo-body">{m.content}</div>
              </div>
            ) : (
              <div key={`${m.at}-${i}`} className="convo-msg convo-agent">
                <span className="sc convo-who">assistant</span>
                {m.content ? (
                  <Prose content={m.content} citations={m.citations} />
                ) : (
                  <div className="convo-body convo-thinking">(no text)</div>
                )}
                <Cited citations={m.citations ?? []} />
                {(m.cards ?? []).map((card) =>
                  card.type === "held" ? (
                    heldById.has(card.id) && (
                      <HeldCard
                        key={card.id}
                        conversationId={convo.id}
                        action={heldById.get(card.id)!}
                        onChange={setConvo}
                      />
                    )
                  ) : (
                    <GrantThread key={card.id} id={card.id} />
                  )
                )}
                <ReplyFoot message={m} />
              </div>
            )
          )}
          {replying && (
            <div className="convo-msg convo-agent">
              <span className="sc convo-who">assistant</span>
              {convo.turn.partial ? (
                <Prose content={convo.turn.partial} />
              ) : (
                <div className="convo-body convo-thinking">{convo.turn.note || "working…"}</div>
              )}
              <p className="ask-foot ask-running">
                {convo.turn.partial && convo.turn.note && <span>{convo.turn.note}</span>}
                <span>
                  <Owls microUsd={convo.turn.cost_micro_usd} /> owls so far
                </span>
                <button className="linklike" onClick={() => void stop()} disabled={convo.turn.stopping}>
                  {convo.turn.stopping ? "stopping…" : "Stop"}
                </button>
              </p>
            </div>
          )}
          {convo.turn.state === "failed" && (
            <p className="form-error">
              The Assistant could not reply{convo.turn.error ? ` (${convo.turn.error})` : ""}. Your
              message is saved; send a short follow-up to ask again.
            </p>
          )}
          <div ref={endRef} />
        </div>
      )}

      {balance <= 0 ? (
        <p className="ask-notice">
          Your balance is 0 owls. The Assistant&rsquo;s work is charged in owls at what it
          costs, so it needs some to reply. Searching and reading the graph stay free.{" "}
          <Link href="/account#buy-owls">Buy owls</Link>
        </p>
      ) : (
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
            placeholder={convo ? "Reply to the Assistant…" : "What do you want to know or do?"}
            disabled={sending || replying}
            aria-label="Your message"
          />
          <button
            className="order-button"
            onClick={() => void send()}
            disabled={sending || replying || !draft.trim()}
          >
            {sending ? "sending…" : replying ? "working…" : "Send"}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="ask-bill">
        <span>
          {convo ? (
            <>
              This conversation has cost <Owls microUsd={convo.spent_micro_usd} /> owls.{" "}
            </>
          ) : (
            <>Charged at what the work costs, as it runs. </>
          )}
          Balance <Owls microUsd={balance} /> owls.
        </span>
        <label>
          Model{" "}
          {(convo?.models ?? models).length > 1 ? (
            <select value={model} onChange={(e) => void chooseModel(e.target.value)} disabled={replying}>
              {(convo?.models ?? models).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            modelName
          )}
        </label>
      </div>

      <details className="ask-allowed">
        <summary>
          Runs without asking: {allowedNames.length > 0 ? allowedNames.join("; ") : "nothing"}
        </summary>
        <p className="order-caption">
          When the Assistant wants to spend owls on the graph or publish under your name, it
          prepares the action and waits for you to run it. You can let kinds of action run
          without asking, in every conversation; each still leaves a receipt.
        </p>
        {Object.entries(labels).map(([kind, label]) => (
          <label key={kind} className="ask-allow-kind">
            <input
              type="checkbox"
              checked={always.includes(kind)}
              onChange={(e) => void toggleAlways(kind, e.target.checked)}
            />{" "}
            {label}
            {!always.includes(kind) && inConversation.includes(kind) && (
              <span className="order-caption"> allowed in this conversation</span>
            )}
          </label>
        ))}
      </details>

      {convo && (
        <p className="ask-manage">
          <Link href="/ask">New conversation</Link>
          <button className="linklike danger" onClick={() => void remove()} disabled={replying}>
            Delete this conversation
          </button>
        </p>
      )}
    </div>
  );
}
