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
 *
 * A session keeps the label its run worked at (src/labels.ts), and is
 * resumed at it. The answer that wakes a session is often delivered by
 * other work (a research run reporting, the sweep), so the resumption is
 * commissioned at the session's label, not the deliverer's, and a pass
 * resumes only a session of the label it is running at.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { severalInForceForRun } from "./judgment-version-service.js";
import { loadConfig } from "../config.js";
import { currentLabel, getUsageContext, runAtLabel } from "../llm/usage-context.js";
import type Anthropic from "@anthropic-ai/sdk";
type MessageParam = Anthropic.MessageParam;
import { postMessage, type MessageSender } from "./inbox-service.js";
import type { CommissionPayer } from "./commission-service.js";
import { microUsdToOwls } from "./owl.js";

export type AwaitKind = "research" | "reply" | "petition" | "subscription";

export interface SessionReply {
  kind: AwaitKind;
  ref: string;
  text: string;
  at: string;
  delivered: boolean;
  /**
   * Money that came with the answer for the running run (a petition granted
   * while it worked): the run raises its own ceiling by this when it reads
   * the answer, since the grant is already placed on its row.
   */
  credit_micro_usd?: number;
  /**
   * False for a delivery the agent asked to have waiting for its next turn
   * (a subscription with delivery `queue`): it does not resume a paused
   * session by itself.
   */
  wake?: boolean;
}

export interface SessionRow {
  id: string;
  role: string;
  /** The node a Steward's session is on; null for other agents' sessions. */
  node_id: string | null;
  /** What the agent's run was called with, to rebuild it on resumption (non-Steward roles). */
  context: { input?: unknown } | null;
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
  extra_funding: Array<{ grantId: string; microUsd: number }>;
  /** Why the paused run's transcript was private; the resumed run takes them on. */
  private_reasons: string[];
  /** The label the session's run worked at; it resumes at the same one. */
  sensitivity_label: string;
}

const COLUMNS = `id, role, node_id, context, status, transcript, model, awaiting, replies, payer,
  budget_left_micro_usd::bigint AS budget_left_micro_usd, suspended_at::text AS suspended_at,
  deadline::text AS deadline, resumes, extra_funding, private_reasons, sensitivity_label`;

/** Where a session stands, for a decider that must know whether its run is still live. */
export async function sessionStatus(id: string | null): Promise<SessionRow["status"] | null> {
  if (!id) return null;
  const [row] = await rawQuery<{ status: SessionRow["status"] }>(`SELECT status FROM agent_sessions WHERE id = $1`, [id]);
  return row?.status ?? null;
}

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
  // The row is made by the run's first request that waits, so it takes the
  // run's label; a later request, or one after a resumption, leaves it.
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, node_id, status, awaiting, sensitivity_label)
     VALUES ($1, $2, $3, 'running', $4::jsonb, $5)
     ON CONFLICT (id) DO UPDATE
       SET awaiting = agent_sessions.awaiting || $4::jsonb, updated_at = now()`,
    [session.id, session.role, session.nodeId, JSON.stringify([{ kind, ref }]), currentLabel()]
  );
  return session.id;
}

/** Make the running session's row if it has none yet (a subscription made before any other wait). */
export async function ensureSessionRow(): Promise<string | null> {
  const session = getUsageContext().session;
  if (!session) return null;
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, node_id, status, awaiting, sensitivity_label)
     VALUES ($1, $2, $3, 'running', '[]'::jsonb, $4)
     ON CONFLICT (id) DO NOTHING`,
    [session.id, session.role, session.nodeId, currentLabel()]
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
 *
 * A session takes only an answer of its own label (src/labels.ts). The
 * answer is written by whoever delivers it, at their label, and a session
 * shows what it holds to a run at the session's label, so an answer from
 * work at another label is not put into it: it goes where an answer goes
 * when the session cannot take it (the node's inbox, as a message at the
 * answer's own label, or nowhere when the caller names no fallback), and
 * the session waits on, to its deadline. The same reason a Steward's pass
 * resumes only a session of its own label (takeReadySession below).
 * Whether one label may read another is a clearance, which nothing checks
 * yet; until something does, only the same label is taken.
 */
export async function deliverReply(input: {
  sessionId: string | null;
  kind: AwaitKind;
  ref: string;
  text: string;
  /** Where the answer goes if the session can't take it. */
  fallback: { nodeId: string; trigger: "research_report" | "message_reply"; sender: MessageSender; replyTo?: string | null } | null;
  /** Money placed on the running run's row with the answer: the run credits its ceiling when it reads it. */
  creditMicroUsd?: number;
  /** Money granted to a paused session: placed on the pass that resumes it. */
  grant?: { grantId: string; microUsd: number } | null;
  /** False: show it on the session's next turn, but do not resume a paused session for it. */
  wake?: boolean;
}): Promise<"session" | "inbox" | "dropped"> {
  const wake = input.wake !== false;
  const reply: SessionReply = {
    kind: input.kind,
    ref: input.ref,
    text: input.text,
    at: new Date().toISOString(),
    delivered: false,
    ...(input.creditMicroUsd ? { credit_micro_usd: Math.round(input.creditMicroUsd) } : {}),
    ...(wake ? {} : { wake: false }),
  };
  let resume: SessionRow | null = null;
  const took = input.sessionId
    ? await withTransaction(async (tx) => {
        const [s] = await tx.query<SessionRow>(
          `SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 AND sensitivity_label = $2 FOR UPDATE`,
          [input.sessionId, currentLabel()]
        );
        if (!s || s.status === "expired" || s.status === "closed") return false;
        const next = s.status === "waiting" && wake ? "ready" : s.status;
        const paused = s.status === "waiting" || s.status === "ready";
        const extra = paused && input.grant && input.grant.microUsd > 0 ? [input.grant] : [];
        const [row] = await tx.query<SessionRow>(
          `UPDATE agent_sessions
              SET replies = replies || $2::jsonb, status = $3,
                  extra_funding = extra_funding || $4::jsonb, updated_at = now()
            WHERE id = $1
            RETURNING ${COLUMNS}`,
          [s.id, JSON.stringify([reply]), next, JSON.stringify(extra)]
        );
        if (s.status === "waiting" && wake) resume = row ?? null;
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
        `### ${
          r.kind === "research"
            ? `Research run ${r.ref} has reported`
            : r.kind === "petition"
              ? `The mandate decided your petition ${r.ref}`
              : r.kind === "subscription"
                ? `Something you subscribed to`
                : `An answer to your message ${r.ref}`
        }\n\n${r.text}`
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
      if (type === "tool_result" && Array.isArray(b.content)) {
        // An image or a document a tool showed (#912) is megabytes of base64
        // that a paused session would keep in its row and pay to re-read on
        // resuming. Its place is marked, so the resumed run knows what it no
        // longer sees and can look again.
        blocks.push({
          ...b,
          content: (b.content as Array<Record<string, unknown>>).map((c) =>
            c.type === "image" || c.type === "document"
              ? {
                  type: "text",
                  text: `[The ${c.type} this call showed is not carried into a resumed session. Call the tool again to see it.]`,
                }
              : c
          ),
        });
      } else if (type === "text" || type === "tool_use" || type === "tool_result" || type === "image" || type === "document") {
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
  /** What the run was called with, kept to rebuild it on resumption (non-Steward roles). */
  context?: { input: unknown } | null;
}): Promise<SessionRow["status"] | null> {
  const config = loadConfig();
  const payer =
    input.payer?.kind === "grant" ? { grantId: input.payer.grantId } : input.payer?.kind === "user" ? { userId: input.payer.userId } : null;
  let resume: SessionRow | null = null;
  const status = await withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(`SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 FOR UPDATE`, [input.id]);
    if (!s || s.status !== "running") return s?.status ?? null;
    // A session waits while something it asked for is outstanding, or while
    // it holds a subscription that would wake it (an event, a check-in, a
    // threshold): that is how an agent ends a turn to wait for what comes.
    const holds = await tx.query<{ n: number; due: string | null }>(
      `SELECT count(*) FILTER (WHERE delivery = 'wake')::int AS n, min(due_at)::text AS due
         FROM subscriptions WHERE subscriber_kind = 'session' AND subscriber_ref = $1 AND active`,
      [s.id]
    );
    const subscribed = Number(holds[0]?.n ?? 0) > 0;
    const waiting = outstanding(s).length > 0 || subscribed;
    const undelivered = s.replies.some((r) => !r.delivered && r.wake !== false);
    const next: SessionRow["status"] = undelivered ? "ready" : waiting ? "waiting" : "closed";
    // The session waits at least as long as the platform's wait, and past
    // its own latest check-in when it set one later than that.
    const dueAt = holds[0]?.due ? new Date(holds[0].due).getTime() : 0;
    const waitSecs = Math.max(
      Math.round(config.sessionWaitHours * 3600),
      dueAt ? Math.round((dueAt - Date.now()) / 1000) + 3600 : 0
    );
    const [row] = await tx.query<SessionRow>(
      `UPDATE agent_sessions
          SET status = $2, transcript = $3::jsonb, model = $4, payer = $5::jsonb,
              budget_left_micro_usd = $6, suspended_at = now(),
              deadline = now() + make_interval(secs => $7),
              context = COALESCE($8::jsonb, context),
              private_reasons = ARRAY(SELECT DISTINCT unnest(private_reasons || $9::text[])),
              updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [
        s.id,
        next,
        next === "closed" ? null : JSON.stringify(portableTranscript(input.transcript)),
        input.model,
        payer ? JSON.stringify(payer) : null,
        Math.max(0, Math.round(input.budgetLeftMicroUsd)),
        waitSecs,
        input.context ? JSON.stringify(input.context) : null,
        // The pausing run's private reasons, from its trace (run-visibility.ts).
        [...(getUsageContext().trace?.privateReasons ?? [])],
      ]
    );
    if (next === "ready") resume = row ?? null;
    if (next === "closed") {
      await tx.query(
        `UPDATE subscriptions SET active = false, ended_at = now()
          WHERE subscriber_kind = 'session' AND subscriber_ref = $1 AND active`,
        [s.id]
      );
    }
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
  // Whoever delivered the answer, the pass that resumes the session is the
  // session's work: its ledger row is opened at the session's label.
  return runAtLabel(s.sensitivity_label, `paused session ${s.id}`, () => commissionResumptionAtLabel(s));
}

async function commissionResumptionAtLabel(s: SessionRow): Promise<void> {
  const { commissionNodePass, placeCommission } = await import("./commission-service.js");
  const { ASSESS_GROUP } = await import("./action-service.js");
  const extras = (s.extra_funding ?? []).filter((e) => e.grantId && Number(e.microUsd) > 0);
  const payer: CommissionPayer | null = s.payer?.grantId
    ? { kind: "grant", grantId: s.payer.grantId }
    : s.payer?.userId
      ? { kind: "user", userId: s.payer.userId }
      : null;
  // The pass is commissioned from whoever paid for the paused run, at what it
  // had left; with no such payer, from the first grant that came while it was
  // paused. Any grants are then placed on the same pass.
  // A Grantmaker's session is its mandate's standing deliberation, not one
  // run's leftover: each sitting it resumes for works to the review-pass
  // figure its operating policy names, as a fresh pass would.
  const sittingBudget =
    s.role === "grantmaker" && payer?.kind === "grant" ? await grantmakerSittingMicroUsd(payer.grantId) : null;
  const first = payer
    ? { payer, budget: sittingBudget ?? Math.max(MIN_RESUME_MICRO_USD, Number(s.budget_left_micro_usd)), rest: extras }
    : extras.length > 0
      ? { payer: { kind: "grant", grantId: extras[0]!.grantId } as CommissionPayer, budget: Number(extras[0]!.microUsd), rest: extras.slice(1) }
      : null;
  if (!first) return;
  if (!s.node_id || s.role !== "steward") {
    await commissionResumeRow(s, first);
    return;
  }
  try {
    const res = await commissionNodePass({
      payer: first.payer,
      claimId: s.node_id!,
      budgetMicroUsd: first.budget,
      brief: "A paused session on this node got back what it asked for; this pass resumes it.",
      reason: "Resuming a paused session with the answer it waited for.",
      commissionedBy: "session_resume",
      message: { trigger: "session_resume", sender: { kind: "system" } },
    });
    if (!res.ok) return;
    for (const e of first.rest) {
      await placeCommission({
        group: ASSESS_GROUP(s.node_id!),
        actionId: res.actionId,
        claimId: s.node_id,
        payer: { kind: "grant", grantId: e.grantId },
        budget: Math.round(Number(e.microUsd)),
        commissionedBy: "petition",
        committer: "grantmaker",
        brief: null,
        reason: "Granted on a petition while the session was paused.",
      });
    }
    await rawQuery(`UPDATE agent_sessions SET extra_funding = '[]'::jsonb WHERE id = $1`, [s.id]);
  } catch (err) {
    console.warn(`[session] resuming ${s.id} failed:`, err instanceof Error ? err.message : err);
  }
}

export const RESUME_GROUP = (sessionId: string, n: number) => `resume:${sessionId}:${n}`;

/**
 * An agent whose work is not one node's (the Curator, the Consistency
 * Checker, the Audit Agent, a Correspondent) resumes through a `resume` row
 * on the ledger naming its session, commissioned like the Steward's pass;
 * the engine executor rebuilds the agent from the input it was called with
 * and continues its conversation (runResumeAction).
 */
async function commissionResumeRow(
  s: SessionRow,
  first: { payer: CommissionPayer; budget: number; rest: Array<{ grantId: string; microUsd: number }> }
): Promise<void> {
  const { placeCommission } = await import("./commission-service.js");
  try {
    const group = RESUME_GROUP(s.id, Number(s.resumes ?? 0) + 1);
    const total = first.budget + first.rest.reduce((t, e) => t + Number(e.microUsd), 0);
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('resume', $1, 'standard', $2, $3, $4, $5, $6)
       ON CONFLICT (exclusion_group, variant) DO NOTHING
       RETURNING id`,
      [group, s.node_id, s.id, `Resume a paused ${s.role.replace(/_/g, " ")} session`, total, currentLabel()]
    );
    if (!row) return; // Already commissioned.
    const placed = await placeCommission({
      group,
      actionId: row.id,
      claimId: s.node_id,
      payer: first.payer,
      budget: first.budget,
      commissionedBy: "session_resume",
      brief: null,
      reason: "Resuming a paused session with the answer it waited for.",
    });
    if (!placed.ok) {
      // The payer can't now: the row is withdrawn and the session stays
      // ready, to be resumed by the sweep's next attempt or to expire.
      await rawQuery(`UPDATE actions SET status = 'cancelled', updated_at = now() WHERE id = $1`, [row.id]);
      return;
    }
    for (const e of first.rest) {
      await placeCommission({
        group,
        actionId: row.id,
        claimId: s.node_id,
        payer: { kind: "grant", grantId: e.grantId },
        budget: Math.round(Number(e.microUsd)),
        commissionedBy: "petition",
        committer: "grantmaker",
        brief: null,
        reason: "Granted on a petition while the session was paused.",
      });
    }
    await rawQuery(`UPDATE agent_sessions SET extra_funding = '[]'::jsonb WHERE id = $1`, [s.id]);
  } catch (err) {
    console.warn(`[session] resuming ${s.id} failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * The session a `resume` row names, taken for that run (running again, its
 * answers marked shown). Null when it is no longer ready, or when its
 * transcript is too long to resume (it closes; its answers stay on record
 * where they came from, and on its node's inbox when it has one).
 */
export async function takeSessionForResume(sessionId: string): Promise<{ session: SessionRow; replies: SessionReply[] } | null> {
  const config = loadConfig();
  const taken = await withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(
      `SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 AND status = 'ready' FOR UPDATE`,
      [sessionId]
    );
    if (!s) return null;
    const replies = s.replies.filter((r) => !r.delivered);
    const tooLong = JSON.stringify(s.transcript ?? []).length > config.sessionMaxTranscriptChars || !s.transcript || !s.context;
    await tx.query(
      `UPDATE agent_sessions
          SET status = $2, replies = $3::jsonb, resumed_at = now(), resumes = resumes + 1, updated_at = now()
        WHERE id = $1`,
      [s.id, tooLong ? "closed" : "running", JSON.stringify(s.replies.map((r) => ({ ...r, delivered: true })))]
    );
    return { session: s, replies, tooLong };
  });
  if (!taken) return null;
  if (taken.tooLong) {
    await sendRepliesToInbox(taken.session, taken.replies);
    return null;
  }
  return { session: taken.session, replies: taken.replies };
}

/**
 * Answers that could not reach their session's run, to its node's inbox when
 * it has one. The messages carry the session's label, which is the label of
 * every answer it took (deliverReply), whatever sweep or pass sends them on.
 */
async function sendRepliesToInbox(s: Pick<SessionRow, "id" | "node_id" | "sensitivity_label">, replies: SessionReply[]): Promise<void> {
  const nodeId = s.node_id;
  if (!nodeId) return;
  await runAtLabel(s.sensitivity_label, `paused session ${s.id}`, async () => {
    for (const r of replies) {
      await postMessage({
        nodeId,
        trigger: r.kind === "research" ? "research_report" : "message_reply",
        body: r.text,
        sender: r.kind === "research" ? { kind: "researcher", ref: r.ref } : { kind: "system" },
      }).catch(() => null);
    }
  });
}

/**
 * A session on this node with an answer waiting, taken for this pass to
 * resume (running again, its answers marked shown). Null when there is none,
 * or when its transcript is too long to resume, in which case its answers go
 * to the inbox and it closes.
 *
 * A Steward's pass is opened by its ledger row before it looks for a session,
 * so it cannot take the session's label the way a `resume` row's run does.
 * It takes only a session of the label it is already running at: resuming
 * another label's transcript would write what that session read at this
 * pass's label. A session of another label waits for a pass at its own.
 */
export async function takeReadySession(nodeId: string, role: string): Promise<{ session: SessionRow; replies: SessionReply[] } | null> {
  const config = loadConfig();
  const taken = await withTransaction(async (tx) => {
    const [s] = await tx.query<SessionRow>(
      `SELECT ${COLUMNS} FROM agent_sessions
        WHERE node_id = $1 AND role = $2 AND status = 'ready'
          AND sensitivity_label = $3
        ORDER BY suspended_at ASC LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [nodeId, role, currentLabel()]
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
    await sendRepliesToInbox(taken.session, taken.replies);
    return null;
  }
  return { session: taken.session, replies: taken.replies };
}

/**
 * What a resumed session reads first: the answers, and what changed on its
 * node while it was paused, appended to the conversation it left.
 */
/**
 * The reasons a run resuming `s` with `replies` is private
 * (llm/run-visibility.ts): those of the run that paused, whose transcript it
 * continues, and a research report among the replies, which the claim page
 * leaves out and so is not public. The resuming run marks itself with them.
 */
export function sessionPrivateReasons(s: Pick<SessionRow, "private_reasons">, replies: SessionReply[]): string[] {
  const reasons = new Set(s.private_reasons ?? []);
  if (replies.some((r) => r.kind === "research")) reasons.add(RESEARCH_REPORT_REASON);
  return [...reasons];
}

/** A research report arrived in the run: reports are not served publicly. */
export const RESEARCH_REPORT_REASON = "input:research-report";

export async function resumeMessages(
  s: SessionRow,
  replies: SessionReply[],
  extra: { newMessages?: string; budgetLine?: string }
): Promise<MessageParam[]> {
  const transcript = [...(s.transcript ?? [])];
  // Only a Steward's session is about its node's assessment; another
  // agent's anchor node (the Curator's) is where it works, not what it judges.
  const nodeScoped = Boolean(s.node_id) && s.role === "steward";
  const [changed] = !nodeScoped
    ? [null]
    : await rawQuery<{ assessed_at: string | null; status: string | null; passes: number }>(
    `SELECT (SELECT MAX(assessed_at)::text FROM assessments WHERE claim_id = $1 AND assessed_at > $2::timestamptz) AS assessed_at,
            (SELECT status FROM assessments_in_force WHERE claim_id = $1 LIMIT 1) AS status,
            (SELECT count(*)::int FROM agent_runs WHERE claim_id = $1 AND agent = 'steward' AND started_at > $2::timestamptz) AS passes`,
    [s.node_id, s.suspended_at ?? new Date().toISOString()]
  ).catch(() => [{ assessed_at: null, status: null, passes: 0 }]);
  // The status above is one judgment's. Where the run reads two in force, it is told.
  const several = changed?.assessed_at && changed.status ? await severalInForceForRun(s.node_id) : "";
  const since = (s.suspended_at ?? "").slice(0, 16).replace("T", " ");
  const changes = !nodeScoped
    ? `You were paused since ${since} UTC; the graph may have moved meanwhile, so read again what you rely on before you record anything.`
    : changed?.assessed_at
    ? `While you were paused (since ${since} UTC), another pass on this node recorded a new assessment` +
      `${changed.status ? ` (now ${changed.status})` : ""}. Read the node again before you record anything, and reconcile with it.` +
      (several ? ` ${several}` : "")
    : `Nothing on this node's assessment changed while you were paused (since ${since} UTC).`;
  const text =
    `## Your session resumes\n\nYou paused waiting. Here is what came.\n\n${renderReplies(replies)}\n\n` +
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
  // A ready session whose resumption the payer could not fund when its answer
  // came (its day was spent) is tried again; a Steward's is resumed by its
  // node's next pass instead.
  const stalled = await rawQuery<SessionRow>(
    `SELECT ${COLUMNS} FROM agent_sessions s
      WHERE s.status = 'ready' AND s.role <> 'steward'
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.kind = 'resume' AND a.target_ref = s.id::text AND a.status IN ('open', 'running'))
      LIMIT 50`
  );
  for (const s of stalled) await commissionResumption(s);
  const rows = await rawQuery<SessionRow>(
    `UPDATE agent_sessions
        SET status = CASE WHEN status = 'running' THEN 'closed' ELSE 'expired' END, updated_at = now()
      WHERE (status = 'running' AND updated_at < now() - interval '3 hours')
         OR (status IN ('waiting', 'ready') AND deadline < now())
      RETURNING ${COLUMNS}`
  );
  for (const s of rows) {
    await sendRepliesToInbox(s, s.replies.filter((x) => !x.delivered));
    // A session that has ended holds no interest in anything.
    await rawQuery(
      `UPDATE subscriptions SET active = false, ended_at = now()
        WHERE subscriber_kind = 'session' AND subscriber_ref = $1 AND active`,
      [s.id]
    );
  }
  return rows.length;
}

/** The sentence the pausing tools and the task message use for the limits. */
/**
 * The limits a paused session works under, stated to every agent that can
 * pause (session-tools.ts, wait_for_answers): how long it waits, where its
 * answers go after that, what a resumption is paid with, and the length past
 * which a conversation is not resumed (re-reading it costs more than a
 * fresh start).
 */
export function sessionLimitsSentence(): string {
  const c = loadConfig();
  return (
    `A paused session waits at most ${c.sessionWaitHours} hours for what it asked for (longer for a check-in ` +
    `you set further out); after that it ends, and what arrives goes to the node's inbox for a later pass, or, ` +
    `for a run with no node, stays where it is recorded (a research report on its research run). A resumption ` +
    `is paid for from what the paused run had left, at least ${microUsdToOwls(MIN_RESUME_MICRO_USD)} owls, by ` +
    `whoever paid for it. A conversation longer than about ${Math.round(c.sessionMaxTranscriptChars / 1000)} ` +
    `thousand characters is not resumed, since re-reading it would cost more than starting again; its answers ` +
    `go where they would after the wait.`
  );
}

export const owls = (micro: number) => microUsdToOwls(micro);

/** The budget a Grantmaker's resumed sitting works to: its mandate's review-pass figure. */
async function grantmakerSittingMicroUsd(grantId: string): Promise<number | null> {
  const [g] = await rawQuery<{ id: string; mandate: Record<string, unknown> | null }>(
    `SELECT id, mandate FROM grants WHERE id = $1`,
    [grantId]
  );
  if (!g) return null;
  const { reviewPassBudgetMicroUsd, grantmakerShareLeftMicroUsd } = await import("./action-service.js");
  const share = await grantmakerShareLeftMicroUsd(g as never).catch(() => null);
  return reviewPassBudgetMicroUsd(g as never, "review", share);
}
