"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Swatch } from "./Assessment";
import { useViewerSession } from "./useViewerSession";
import { modelDisplayName } from "@/lib/model-names";

// "Ask the graph" (#312): the one ask surface on the site, in two modes. On
// a claim page it is anchored to that claim; on /ask it puts a question to
// the graph as a whole. The answer is a model with read-only graph tools,
// and the panel says so: every reply names the model that wrote it and
// links the claims it cited. Visible to every reader, so the page stays
// cacheable; only the send step needs the session, which is probed after
// mount (#174). Nothing typed here is kept beyond the reply.

export type AskContext =
  | { kind: "graph" }
  | { kind: "claim"; claim_id: string };

interface Citation {
  id: string;
  canonical_form: string;
  status: string | null;
  url: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  model?: string | null;
}

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string; code?: string };

const CLAIM_MARK = /(\[claim:[0-9a-f-]{36}\])/gi;

/** A reply, its [claim:<uuid>] markers rendered as numbered links. */
function ReplyText({ text, citations }: { text: string; citations: Citation[] }) {
  const byId = new Map(citations.map((c) => [c.id.toLowerCase(), c]));
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, pi) => (
        <p key={pi}>
          {para.split(CLAIM_MARK).map((part, i) => {
            const m = /^\[claim:([0-9a-f-]{36})\]$/i.exec(part);
            if (!m) return <span key={i}>{part}</span>;
            const cite = byId.get(m[1]!.toLowerCase());
            // An id the graph could not resolve is dropped, never dead-linked.
            if (!cite) return null;
            const n = citations.indexOf(cite) + 1;
            return (
              <Link key={i} className="ask-cite" href={`/claims/${cite.id}`} title={cite.canonical_form}>
                [{n}]
              </Link>
            );
          })}
        </p>
      ))}
    </>
  );
}

export function AskGraph({
  context,
  starters = [],
  initialQuestion,
  heading = "Ask the graph",
  lede,
}: {
  context: AskContext;
  /** Suggested first questions, shown until the conversation starts. */
  starters?: string[];
  /** A question to send as soon as the reader is known to be signed in. */
  initialQuestion?: string;
  heading?: string;
  lede?: string;
}) {
  const session = useViewerSession();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState(initialQuestion ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  async function send(question: string) {
    const q = question.trim();
    if (!q || status.kind === "busy") return;
    const history: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(history);
    setDraft("");
    setStatus({ kind: "busy" });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          context,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { reply: string; citations: Citation[]; model: string | null }
        | { error?: string; code?: string }
        | null;
      if (!res.ok || !data || !("reply" in data)) {
        const err = (data ?? {}) as { error?: string; code?: string };
        // Leave the question in the box so it is not lost.
        setTurns(turns);
        setDraft(q);
        setStatus({
          kind: "error",
          message: err.error ?? "The graph could not answer just now.",
          code: err.code,
        });
        return;
      }
      setTurns([
        ...history,
        { role: "assistant", content: data.reply, citations: data.citations, model: data.model },
      ]);
      setStatus({ kind: "idle" });
    } catch {
      setTurns(turns);
      setDraft(q);
      setStatus({ kind: "error", message: "The graph could not answer just now. Please try again." });
    }
  }

  // A question carried in from the search box (#312) goes as soon as the
  // reader is known to be signed in; a signed-out reader keeps it in the box.
  useEffect(() => {
    if (!initialQuestion || sentInitial.current) return;
    if (session.kind !== "signed-in") return;
    sentInitial.current = true;
    void send(initialQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.kind, initialQuestion]);

  useEffect(() => {
    if (turns.length > 0) bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length, status.kind]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  const signedOut = session.kind === "signed-out";
  const callback =
    typeof window === "undefined"
      ? "/ask"
      : `${window.location.pathname}${draft.trim() ? `?q=${encodeURIComponent(draft.trim())}` : ""}`;
  const lastModel = [...turns].reverse().find((t) => t.role === "assistant")?.model ?? null;

  return (
    <section className="ask" aria-label={heading}>
      <h2>{heading}</h2>
      {lede && <p className="ask-lede">{lede}</p>}

      {turns.length > 0 && (
        <div className="ask-thread">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ask-turn ask-turn-user">
                <p>{t.content}</p>
              </div>
            ) : (
              <div key={i} className="ask-turn ask-turn-graph">
                <ReplyText text={t.content} citations={t.citations ?? []} />
                {(t.citations?.length ?? 0) > 0 && (
                  <ol className="ask-citations">
                    {t.citations!.map((c) => (
                      <li key={c.id}>
                        <Swatch status={c.status} />{" "}
                        <Link href={`/claims/${c.id}`}>{c.canonical_form}</Link>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )
          )}
          {status.kind === "busy" && (
            <p className="ask-status" role="status">
              consulting the graph…
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {turns.length === 0 && starters.length > 0 && (
        <ul className="ask-starters" aria-label="Suggested questions">
          {starters.map((s) => (
            <li key={s}>
              <button
                type="button"
                className="linklike"
                onClick={() => (signedOut ? setDraft(s) : void send(s))}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="ask-form" onSubmit={onSubmit}>
        <textarea
          className="ask-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={
            context.kind === "claim"
              ? "Ask about this claim: what it rests on, the case against it, what would change the verdict…"
              : "Ask the graph a question…"
          }
          aria-label={heading}
          disabled={status.kind === "busy"}
        />
        {signedOut ? (
          <p className="ask-signin">
            <a className="signin-button" style={{ display: "inline-block", textDecoration: "none" }}
               href={`/signin?callbackUrl=${encodeURIComponent(callback)}`}>
              Sign in to ask
            </a>{" "}
            <span className="ask-caption">
              Each answer runs a model, metered to your account. Reading never is,
              and every account gets a free owl each month, enough for many questions.
            </span>
          </p>
        ) : (
          <p className="ask-actions">
            <button
              type="submit"
              className="order-button"
              disabled={status.kind === "busy" || session.kind === "loading" || !draft.trim()}
            >
              {status.kind === "busy" ? "asking…" : "Ask"}
            </button>
            <span className="ask-caption">
              Up to a tenth of an owl per answer; the unused part comes back.
            </span>
          </p>
        )}
        {status.kind === "error" && (
          <p className="form-error">
            {status.message}
            {status.code === "INSUFFICIENT_OWLS" && (
              <>
                {" "}
                <Link href="/account">Your account →</Link>
              </>
            )}
          </p>
        )}
      </form>

      <p className="ask-about">
        This is {lastModel ? modelDisplayName(lastModel) : "Claude"} with read-only
        access to the Minerval claim graph, and nothing else. It answers from the
        graph&rsquo;s assessments and cites the claims it used; where the graph is
        silent it says so. Your questions are not kept.
      </p>
    </section>
  );
}
