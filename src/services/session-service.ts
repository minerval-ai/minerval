/**
 * Agent sessions that pause and resume (agent_sessions).
 *
 * An agent that asks for something it needs (research it commissions, an
 * answer from another node's Steward) does not block on it. It carries on,
 * and when it has done what it can without the answer it ends its turn, as
 * any agent does when it is waiting. Its session then pauses: the
 * conversation so far is kept. When the answer arrives it is appended to that
 * conversation as a new turn and the session resumes, with everything it had
 * read and reasoned, instead of a fresh pass meeting the answer cold. An
 * answer that arrives while the run is still working is shown in its next
 * tool result.
 *
 * The pieces: every request that expects an answer carries the asking
 * session's id (research_runs.reply_to_session,
 * node_messages.reply_to_session); deliverReply routes an answer by that id;
 * a paused session with an answer is resumed by a pass on its node,
 * commissioned from whoever paid for the paused run at what it had left, so
 * the node's lock, the ledger and settlement work as for any pass. An answer
 * whose session cannot take it (it expired, or it closed) goes to the node's
 * inbox, where the next pass reads it: nothing is lost.
 *
 * The limits are stated to the agent in the tools that pause it: a session
 * waits at most SESSION_WAIT_HOURS, and a transcript longer than
 * SESSION_MAX_TRANSCRIPT_CHARS is not resumed (its answers go to the inbox).
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getUsageContext } from "../llm/usage-context.js";
import type Anthropic from "@anthropic-ai/sdk";
type MessageParam = Anthropic.MessageParam;
import { postMessage, type MessageSender } from "./inbox-service.js";
import type { CommissionPayer } from "./commission-service.js";
import { microUsdToOwls } from "./owl.js";

export type AwaitKind = "research" | "reply";

export interface SessionReply {
  kind: AwaitKind;
  ref: string;
  text: string;
  at: string;
  delivered: boolean;
}

export interface SessionRow {
  id: string;
  role: string;
  node_id: string;
  status: "running" | "waiting" | "ready" | "expired" | "closed";
  transcript: MessageParam[] | null;
  model: string | null;
  awaiting: Array<{ kind: AwaitKind; ref: string }>;
  replies: SessionReply[];
  payer: { grantId?: string; userId?: string } | null;
  budget_left_micro_usd: number;
  suspended_at: string | null;
  deadline: string | null;
  resumes: number;
}

const COLUMNS = `id, role, node_id, status, transcript, model, awaiting, replies, payer,
  budget_left_micro_usd::bigint AS budget_left_micro_usd, suspended_at::text AS suspended_at,
  deadline::text AS deadline, resumes`;

/** What a session still waits on: requests no answer has come back for. */
export function outstanding(s: Pick<SessionRow, "awaiting" | "replies">): Array<{ kind: AwaitKind; ref: string }> {
  const answered = new Set(s.replies.map((r) => `${r.kind}:${r.ref}`));
  return s.awaiting.filter((a) => !answered.has(`${a.kind}:${a.ref}`));
}

/**
 * The running session's id, when the run can wait on answers, after noting
 * that it now waits on this one. Null when the run has no session (it cannot
 * pause): the caller then sends the request without a session to answer
 * into, and the answer goes to the node's inbox.
 */
export async function registerAwait(kind: AwaitKind, ref: string): Promise<string | null> {
  const session = getUsageContext().session;
  if (!session) return null;
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, node_id, status, awaiting)
     VALUES ($1, $2, $3, 'running', $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET awaiting = agent_sessions.awaiting || $4::jsonb, updated_at = now()`,
    [session.id, session.role, session.nodeId, JSON.stringify([{ kind, ref }])]
  );
  return session.id;
}

/** The session's id for a request that expects an answer, without registering one. */
export function currentSessionId(): string | null {
  return getUsageContext().session?.id ?? null;
}

/**
 * Route an answer to the session that asked for it. A running session shows
 * it in the run's next tool result; a paused one is resumed. Returns
 * 'session' when the session took it, 'inbox' when it went to the node's
 * inbox instead (the session expired, closed, or never existed).
 */
export async function deliverReply(input: {
  sessionId: string | null;
  kind: AwaitKind;
  ref: string;
  text: string;
  /** Where the answer goes if the session can't take it. */
  fallback: { nodeId: string; trigger: "research_report" | "message_reply"; sender: MessageSender; replyTo?: string | null } | null;
}): Promise<"session" | "inbox" | "dropped"> {
  const reply: SessionReply = { kind: input.kind, ref: input.ref, text: input.text, at: new Date().toISOString(), delivered: false };
  let resume: SessionRow | null = null;
  const took = input.sessionId
    ? await withTransaction(async (tx) => {
        const [s] = await tx.query<SessionRow>(
          `SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 FOR UPDATE`,
          [input.sessionId]
        );
        if (!s || s.status === "expired" || s.status === "closed") return false;
        const next = s.status === "waiting" ? "ready" : s.status;
        const [row] = await tx.query<SessionRow>(
          `UPDATE agent_sessions
              SET replies = replies || $2::jsonb, status = $3, updated_at = now()
            WHERE id = $1
            RETURNING ${COLUMNS}`,
          [s.id, JSON.stringify([reply]), next]
        );
        if (s.status === "waiting") resume = row ?? null;
        return true;
      })
    : false;
  if (took) {
    if (resume) await commissionResumption(resume);
    return "session";
  }
  if (!input.fallback) return "dropped";
  await postMessage({
    nodeId: input.fallback.nodeId,
    trigger: input.fallback.trigger,
    body: input.text,
    sender: input.fallback.sender,
    replyTo: input.fallback.replyTo ?? null,
  });
  return "inbox";
}

/** Answers that arrived for a running session and have not been shown, marked shown. */
export async function takeLiveReplies(sessionId: string): Promise<SessionReply[]> {
  return withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(
      `SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 AND status = 'running' FOR UPDATE`,
      [sessionId]
    );
    if (!s) return [];
    const fresh = s.replies.filter((r) => !r.delivered);
    if (fresh.length === 0) return [];
    await tx.query(
      `UPDATE agent_sessions SET replies = $2::jsonb, updated_at = now() WHERE id = $1`,
      [s.id, JSON.stringify(s.replies.map((r) => ({ ...r, delivered: true })))]
    );
    return fresh;
  });
}

/** Answers that arrived mid-run, as the next tool result shows them; null when none. */
export function renderResearchSessionArrivals(replies: SessionReply[]): string | null {
  return replies.length ? `## Arrived while you worked\n\n${renderReplies(replies)}` : null;
}

/** How answers read when they arrive in a session. */
export function renderReplies(replies: SessionReply[]): string {
  return replies
    .map(
      (r) =>
        `### ${r.kind === "research" ? `Research run ${r.ref} has reported` : `An answer to your message ${r.ref}`}\n\n${r.text}`
    )
    .join("\n\n");
}

/**
 * A transcript that can be sent again later: thinking blocks are dropped
 * (they belong to the turn that produced them), and server-tool blocks (web
 * search, code execution) become text, since their containers are gone.
 */
export function portableTranscript(messages: MessageParam[]): MessageParam[] {
  const asText = (label: string, value: unknown): { type: "text"; text: string } => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return { type: "text", text: `[${label}] ${raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw}` };
  };
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const blocks: unknown[] = [];
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      const type = String(b.type ?? "");
      if (type === "thinking" || type === "redacted_thinking") continue;
      if (type === "text" || type === "tool_use" || type === "tool_result" || type === "image" || type === "document") {
        blocks.push(b);
      } else if (type === "server_tool_use") {
        blocks.push(asText(`you called ${String(b.name ?? "a server tool")}`, b.input));
      } else {
        blocks.push(asText(`${type}`, b.content ?? b));
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "(nothing to show)" });
    return { ...m, content: blocks } as MessageParam;
  });
}

/**
 * The run ended its turn. With answers outstanding the session pauses with
 * its transcript, and resumes when one arrives; with none, it closes. An
 * answer that came back after the run last looked is resumed at once.
 * Returns the session's status after.
 */
export async function suspendSession(input: {
  id: string;
  transcript: MessageParam[];
  model: string;
  budgetLeftMicroUsd: number;
  payer: CommissionPayer | null;
}): Promise<SessionRow["status"] | null> {
  const config = loadConfig();
  const payer =
    input.payer?.kind === "grant" ? { grantId: input.payer.grantId } : input.payer?.kind === "user" ? { userId: input.payer.userId } : null;
  let resume: SessionRow | null = null;
  const status = await withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(`SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 FOR UPDATE`, [input.id]);
    if (!s || s.status !== "running") return s?.status ?? null;
    const waiting = outstanding(s).length > 0;
    const undelivered = s.replies.some((r) => !r.delivered);
    const next: SessionRow["status"] = undelivered ? "ready" : waiting ? "waiting" : "closed";
    const [row] = await tx.query<SessionRow>(
      `UPDATE agent_sessions
          SET status = $2, transcript = $3::jsonb, model = $4, payer = $5::jsonb,
              budget_left_micro_usd = $6, suspended_at = now(),
              deadline = now() + make_interval(secs => $7), updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [
        s.id,
        next,
        next === "closed" ? null : JSON.stringify(portableTranscript(input.transcript)),
        input.model,
        payer ? JSON.stringify(payer) : null,
        Math.max(0, Math.round(input.budgetLeftMicroUsd)),
        Math.round(config.sessionWaitHours * 3600),
      ]
    );
    if (next === "ready") resume = row ?? null;
    return next;
  });
  if (resume) await commissionResumption(resume);
  return status;
}

/** The floor on a resumption's budget: enough to read the answer and record what follows. */
const MIN_RESUME_MICRO_USD = 100_000;

/**
 * Commission the pass that resumes a session with an answer, from whoever paid
 * for the paused run, at what that run had left. If the payer can't (its day
 * is spent), the session stays ready and the node's next pass resumes it.
 */
async function commissionResumption(s: SessionRow): Promise<void> {
  if (!s.payer) return;
  const payer: CommissionPayer | null = s.payer.grantId
    ? { kind: "grant", grantId: s.payer.grantId }
    : s.payer.userId
      ? { kind: "user", userId: s.payer.userId }
      : null;
  if (!payer) return;
  const { commissionNodePass } = await import("./commission-service.js");
  const budget = Math.max(MIN_RESUME_MICRO_USD, Number(s.budget_left_micro_usd));
  await commissionNodePass({
    payer,
    claimId: s.node_id,
    budgetMicroUsd: budget,
    brief: "A paused session on this node got back what it asked for; this pass resumes it.",
    reason: "Resuming a paused session with the answer it waited for.",
    commissionedBy: "session_resume",
    message: { trigger: "session_resume", sender: { kind: "system" } },
  }).catch((err) =>
    console.warn(`[session] resuming ${s.id} failed:`, err instanceof Error ? err.message : err)
  );
}

/**
 * A session on this node with an answer waiting, taken for this pass to
 * resume (running again, its answers marked shown). Null when there is none,
 * or when its transcript is too long to resume, in which case its answers go
 * to the inbox and it closes.
 */
export async function takeReadySession(nodeId: string, role: string): Promise<{ session: SessionRow; replies: SessionReply[] } | null> {
  const config = loadConfig();
  const taken = await withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(
      `SELECT ${COLUMNS} FROM agent_sessions
        WHERE node_id = $1 AND role = $2 AND status = 'ready'
        ORDER BY suspended_at ASC LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [nodeId, role]
    );
    if (!s) return null;
    const replies = s.replies.filter((r) => !r.delivered);
    const tooLong = JSON.stringify(s.transcript ?? []).length > config.sessionMaxTranscriptChars;
    await tx.query(
      `UPDATE agent_sessions
          SET status = $2, replies = $3::jsonb, resumed_at = now(), resumes = resumes + 1, updated_at = now()
        WHERE id = $1`,
      [s.id, tooLong || !s.transcript ? "closed" : "running", JSON.stringify(s.replies.map((r) => ({ ...r, delivered: true })))]
    );
    return { session: s, replies, tooLong: tooLong || !s.transcript };
  });
  if (!taken) return null;
  if (taken.tooLong) {
    for (const r of taken.replies) {
      await postMessage({
        nodeId,
        trigger: r.kind === "research" ? "research_report" : "message_reply",
        body: r.text,
        sender: r.kind === "research" ? { kind: "researcher", ref: r.ref } : { kind: "system" },
      });
    }
    return null;
  }
  return { session: taken.session, replies: taken.replies };
}

/**
 * What a resumed session reads first: the answers, and what changed on its
 * node while it was paused, appended to the conversation it left.
 */
export async function resumeMessages(
  s: SessionRow,
  replies: SessionReply[],
  extra: { newMessages?: string; budgetLine?: string }
): Promise<MessageParam[]> {
  const transcript = [...(s.transcript ?? [])];
  const [changed] = await rawQuery<{ assessed_at: string | null; status: string | null; passes: number }>(
    `SELECT (SELECT MAX(assessed_at)::text FROM assessments WHERE claim_id = $1 AND assessed_at > $2::timestamptz) AS assessed_at,
            (SELECT status FROM assessments WHERE claim_id = $1 AND is_current = true LIMIT 1) AS status,
            (SELECT count(*)::int FROM agent_runs WHERE claim_id = $1 AND agent = 'steward' AND started_at > $2::timestamptz) AS passes`,
    [s.node_id, s.suspended_at ?? new Date().toISOString()]
  ).catch(() => [{ assessed_at: null, status: null, passes: 0 }]);
  const since = (s.suspended_at ?? "").slice(0, 16).replace("T", " ");
  const changes = changed?.assessed_at
    ? `While you were paused (since ${since} UTC), another pass on this node recorded a new assessment` +
      `${changed.status ? ` (now ${changed.status})` : ""}. Read the node again before you record anything, and reconcile with it.`
    : `Nothing on this node's assessment changed while you were paused (since ${since} UTC).`;
  const text =
    `## Your session resumes\n\nYou paused waiting for what you asked for. It has arrived.\n\n${renderReplies(replies)}\n\n` +
    `${changes}` +
    (extra.newMessages ? `\n\n${extra.newMessages}` : "") +
    (extra.budgetLine ? `\n\n${extra.budgetLine}` : "") +
    `\n\nContinue from where you left off.`;
  // The answer is a new user turn. A last assistant turn that ended on tool
  // calls (a final tool) needs their results first.
  const last = transcript[transcript.length - 1];
  const pendingCalls =
    last?.role === "assistant" && Array.isArray(last.content)
      ? (last.content as Array<{ type: string; id?: string }>).filter((b) => b.type === "tool_use")
      : [];
  const content: Array<Record<string, unknown>> = pendingCalls.map((b) => ({
    type: "tool_result",
    tool_use_id: b.id,
    content: "This call ended your turn; the session paused here.",
  }));
  content.push({ type: "text", text });
  if (last?.role === "user") {
    const prior = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as unknown[]);
    transcript[transcript.length - 1] = { role: "user", content: [...prior, ...content] } as MessageParam;
  } else {
    transcript.push({ role: "user", content } as unknown as MessageParam);
  }
  return transcript;
}

/**
 * The sweep: a running session whose run died is closed; a paused one past
 * its deadline expires. Answers either held unshown go to the node's inbox.
 */
export async function sweepSessions(): Promise<number> {
  const rows = await rawQuery<SessionRow>(
    `UPDATE agent_sessions
        SET status = CASE WHEN status = 'running' THEN 'closed' ELSE 'expired' END, updated_at = now()
      WHERE (status = 'running' AND updated_at < now() - interval '3 hours')
         OR (status IN ('waiting', 'ready') AND deadline < now())
      RETURNING ${COLUMNS}`
  );
  for (const s of rows) {
    for (const r of s.replies.filter((x) => !x.delivered)) {
      await postMessage({
        nodeId: s.node_id,
        trigger: r.kind === "research" ? "research_report" : "message_reply",
        body: r.text,
        sender: r.kind === "research" ? { kind: "researcher", ref: r.ref } : { kind: "system" },
      }).catch(() => null);
    }
  }
  return rows.length;
}

/** The sentence the pausing tools and the task message use for the limits. */
export function sessionLimitsSentence(): string {
  const hours = loadConfig().sessionWaitHours;
  return (
    `Your session waits at most ${hours} hours for what it asked for; after that, the answer goes to ` +
    `this node's inbox for a later pass instead. A resumed session is paid for from what this run has ` +
    `left, by whoever paid for this run.`
  );
}

export const owls = (micro: number) => microUsdToOwls(micro);
