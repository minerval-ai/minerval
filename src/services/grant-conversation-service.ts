/**
 * Grant conversations — the granting flow's state machine.
 *
 * A conversation is the only way a person creates a grant: they talk the
 * mandate through with the Grantmaker agent (llm/agents/grantmaker.ts),
 * which surveys the graph, quotes costs, and either drafts a mandate or
 * declines one. The service owns the transcript, the drafted mandate, and
 * the funding step that turns a draft into a live grant with an escrowed
 * budget. Nothing is charged for the conversation itself; the mandate's
 * overhead line is where that cost is recovered on funded mandates.
 *
 * Statuses: active (talking) → proposed (mandate drafted, fundable) →
 * funded (grant created). 'declined' marks a refused mandate; the
 * conversation can continue and recover to active/proposed.
 *
 * Turns run in the background. Sending a message saves it and claims the
 * conversation's turn, and the caller gets the conversation back at once
 * with turn.state "replying"; the reply lands in the transcript when the
 * Grantmaker finishes, which can take minutes. One turn at a time, and no
 * funding while one runs.
 */
import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import {
  budgetJobs,
  grants,
  grantConversations,
  type GrantConversation,
} from "../db/schema.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import {
  runGrantmakerTurn,
  type GrantMandate,
  type TranscriptMessage,
} from "../llm/agents/grantmaker.js";
import { owlsToMicroUsd } from "./owl.js";
import { withOwlBalanceLock } from "./owl-ledger-service.js";
import { PLATFORM_EXTERNAL_ID } from "./platform-account.js";
import { loadConfig } from "../config.js";

/** Hard ceilings on turns per conversation — a runaway/abuse backstop.
 * Funded conversations get more room: they manage a live mandate and stay
 * open for its whole life. */
const MAX_MESSAGES = 60;
const MAX_MESSAGES_FUNDED = 400;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export type ConverseResult =
  | { ok: true; conversation: GrantConversation }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "CLOSED"
        | "TOO_LONG"
        | "EMPTY_MESSAGE"
        | "RATE_LIMITED"
        | "TURN_IN_PROGRESS";
      message: string;
    };

/** How often a running turn refreshes its heartbeat. */
const HEARTBEAT_MS = 30_000;
/** How often the reply-so-far is saved while the Grantmaker writes it. */
const PARTIAL_FLUSH_MS = 1_000;
/**
 * A turn whose heartbeat is older than this has lost its process (a deploy,
 * a crash) and reads as failed. A liveness check, not a limit on the turn:
 * a turn that is still running refreshes its heartbeat however long it takes.
 */
const TURN_LOST_AFTER_MS = 120_000;

// userId → turn timestamps (ms) within the last hour. In-memory sliding
// window, the same construction as the contribution rate limit: a blunt
// backstop, not an accounting system.
const turnWindows = new Map<string, number[]>();

/** Test hook. */
export function resetGrantConversationRateLimiter(): void {
  turnWindows.clear();
}

/**
 * Per-user hourly cap on conversation turns.
 *
 * Every turn runs the Grantmaker on the best model, deliberately free —
 * nothing is charged until a mandate is funded. The per-conversation
 * MAX_MESSAGES ceilings above don't bound this: a user can open unlimited
 * conversations, each with its own fresh allowance. And because these turns
 * are attributed to a user, they are outside the process-wide LLM breaker
 * (budget-tracker.ts scopes that to unattributed work, on the grounds that
 * attributed work is bounded by its own money — true of a funded job, and
 * true of this only once there is a rate on it).
 */
function checkTurnRateLimit(userId: string): boolean {
  const limit = loadConfig().grantConversationRateLimitPerHour;
  if (limit <= 0) return true;
  const now = Date.now();
  const hits = (turnWindows.get(userId) ?? []).filter((t) => t > now - 3_600_000);
  if (hits.length >= limit) {
    turnWindows.set(userId, hits);
    return false;
  }
  hits.push(now);
  turnWindows.set(userId, hits);
  return true;
}

/** Give back the allowance a turn took when the agent failed to run it. */
function releaseTurn(userId: string): void {
  turnWindows.get(userId)?.pop();
}

const rateLimited = (): ConverseResult => ({
  ok: false,
  code: "RATE_LIMITED",
  message:
    `You've reached the hourly limit on granting-conversation turns ` +
    `(${loadConfig().grantConversationRateLimitPerHour}). Each turn runs a ` +
    `full agent on your behalf at no charge; the limit resets within the ` +
    `hour, and a funded mandate's conversation is unaffected by the wait.`,
});

function transcriptOf(convo: GrantConversation): TranscriptMessage[] {
  const messages = (convo.messages ?? []) as ConversationMessage[];
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** True while a turn holds the conversation and its process is alive. */
type TurnFields = Pick<
  GrantConversation,
  "turnStartedAt" | "turnHeartbeatAt" | "turnError" | "turnPartial"
>;

function turnRunning(convo: TurnFields, now = Date.now()): boolean {
  return (
    !!convo.turnStartedAt &&
    !!convo.turnHeartbeatAt &&
    convo.turnHeartbeatAt.getTime() > now - TURN_LOST_AFTER_MS
  );
}

// In-flight turns, so tests (and a graceful shutdown) can wait for them.
const pendingTurns = new Set<Promise<void>>();

/** Test hook: resolves once every turn started so far has finished. */
export async function settleGrantConversationTurns(): Promise<void> {
  while (pendingTurns.size > 0) await Promise.all([...pendingTurns]);
}

/**
 * Save the funder's message and claim the conversation for a turn, in one
 * conditional write: a second message while a turn is running, or one while
 * the mandate is being funded, claims nothing. A turn whose process died
 * (stale heartbeat) can be taken over.
 */
async function claimTurn(
  convo: GrantConversation,
  userMessage: string
): Promise<{ claimed: GrantConversation; startedAt: Date } | null> {
  const startedAt = new Date();
  const entry: ConversationMessage = {
    role: "user",
    content: userMessage,
    at: startedAt.toISOString(),
  };
  const [claimed] = await getDb()
    .update(grantConversations)
    .set({
      messages: sql`${grantConversations.messages} || ${JSON.stringify([entry])}::jsonb`,
      turnStartedAt: startedAt,
      turnHeartbeatAt: startedAt,
      turnError: null,
      turnPartial: null,
      updatedAt: startedAt,
    })
    .where(
      and(
        eq(grantConversations.id, convo.id),
        ne(grantConversations.status, "funding"),
        or(
          isNull(grantConversations.turnStartedAt),
          lt(
            grantConversations.turnHeartbeatAt,
            new Date(startedAt.getTime() - TURN_LOST_AFTER_MS)
          )
        )
      )
    )
    .returning();
  return claimed ? { claimed, startedAt } : null;
}

/**
 * Run the Grantmaker's turn and record its reply. Every write is
 * conditioned on still holding the turn (turn_started_at unchanged), so a
 * turn that was presumed lost and taken over never writes over its
 * successor.
 */
async function runTurn(convo: GrantConversation, startedAt: Date): Promise<void> {
  const db = getDb();
  const holdsTurn = and(
    eq(grantConversations.id, convo.id),
    eq(grantConversations.turnStartedAt, startedAt)
  );
  const heartbeat = setInterval(() => {
    void db
      .update(grantConversations)
      .set({ turnHeartbeatAt: new Date() })
      .where(holdsTurn)
      .catch((err) => console.error(`[grantmaker] heartbeat failed on ${convo.id}:`, err));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // The reply as it forms: the current model turn's text, saved about once a
  // second while it changes. A new model turn (after a tool call) starts it
  // over, so what shows is what the Grantmaker is writing now.
  let partial = "";
  let partialTurn = -1;
  let flushed = "";
  const flush = () => {
    if (partial === flushed) return;
    flushed = partial;
    void db
      .update(grantConversations)
      .set({ turnPartial: partial })
      .where(holdsTurn)
      .catch((err) => console.error(`[grantmaker] saving the partial reply on ${convo.id} failed:`, err));
  };
  const partialTimer = setInterval(flush, PARTIAL_FLUSH_MS);
  partialTimer.unref?.();
  const onText = (delta: string, turn: number) => {
    if (turn !== partialTurn) {
      partialTurn = turn;
      partial = "";
    }
    partial += delta;
  };

  try {
    // A funded conversation manages its live grant: the turn runs in
    // management mode, with the analytics and plan-adjustment tools scoped
    // to that grant, and the usage meters to the grant's escrow (management
    // is part of what the mandate's overhead pays for).
    const funded = convo.status === "funded" && !!convo.grantId;
    const jobId = funded
      ? (
          await rawQuery<{ budget_job_id: string }>(
            `SELECT budget_job_id FROM grants WHERE id = $1`,
            [convo.grantId]
          )
        )[0]?.budget_job_id
      : undefined;

    const platform = await isPlatformAccount(convo.userId);
    const turn = await runWithUsageContext(
      { userId: convo.userId, ...(jobId ? { jobId } : {}) },
      () =>
        runGrantmakerTurn({
          // The claimed row's transcript already ends with the new message.
          transcript: transcriptOf(convo),
          ...(funded && convo.grantId ? { grantId: convo.grantId } : {}),
          ...(platform ? { funder: "platform" as const } : {}),
          onText,
        })
    );
    clearInterval(partialTimer);

    const reply: ConversationMessage = {
      role: "assistant",
      content: turn.reply,
      at: new Date().toISOString(),
    };
    const status = funded
      ? "funded" // management mode never changes the conversation's state
      : turn.mandate
        ? "proposed"
        : turn.declined
          ? "declined"
          : convo.status === "proposed"
            ? "proposed" // an unchanged draft stays fundable while they talk
            : "active";

    await db
      .update(grantConversations)
      .set({
        messages: sql`${grantConversations.messages} || ${JSON.stringify([reply])}::jsonb`,
        status,
        ...(turn.mandate ? { mandate: turn.mandate } : {}),
        turnStartedAt: null,
        turnHeartbeatAt: null,
        turnPartial: null,
        updatedAt: new Date(),
      })
      .where(holdsTurn);
  } catch (err) {
    // The funder's message is already saved; record why no reply came, and
    // give back the turn's share of the hourly allowance.
    releaseTurn(convo.userId);
    console.error(`[grantmaker] turn failed on conversation ${convo.id}:`, err);
    await db
      .update(grantConversations)
      .set({
        turnStartedAt: null,
        turnHeartbeatAt: null,
        turnPartial: null,
        turnError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        updatedAt: new Date(),
      })
      .where(holdsTurn)
      .catch((e) => console.error(`[grantmaker] recording the failure on ${convo.id} failed:`, e));
  } finally {
    clearInterval(heartbeat);
    clearInterval(partialTimer);
  }
}

/**
 * Claim a turn and start it in the background. The caller gets the saved
 * conversation at once, its turn marked replying, and reads the reply from
 * the conversation when the turn finishes: a turn can take minutes, longer
 * than an HTTP request or an MCP tool call should be held open.
 */
async function beginTurn(
  convo: GrantConversation,
  message: string
): Promise<ConverseResult> {
  const claim = await claimTurn(convo, message);
  if (!claim) {
    releaseTurn(convo.userId);
    return {
      ok: false,
      code: "TURN_IN_PROGRESS",
      message:
        "The Grantmaker is still replying to your last message (or the " +
        "mandate is being funded). Your new message was not saved; read the " +
        "conversation until its turn is idle, then send it.",
    };
  }
  const running = runTurn(claim.claimed, claim.startedAt).finally(() =>
    pendingTurns.delete(running)
  );
  pendingTurns.add(running);
  return { ok: true, conversation: claim.claimed };
}

/** Open a conversation with the funder's first message; the reply follows. */
export async function startConversation(input: {
  userId: string;
  message: string;
}): Promise<ConverseResult> {
  if (!input.message.trim()) {
    return {
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "Say what you want the mandate to do",
    };
  }
  // Checked before the row is created: otherwise a rate-limited caller still
  // leaves an empty conversation behind on every attempt.
  if (!checkTurnRateLimit(input.userId)) return rateLimited();
  const db = getDb();
  const [convo] = await db
    .insert(grantConversations)
    .values({ userId: input.userId })
    .returning();
  return beginTurn(convo!, input.message.trim());
}

/** Continue a conversation; the reply follows in the background. */
export async function addMessage(input: {
  conversationId: string;
  userId: string;
  message: string;
}): Promise<ConverseResult> {
  if (!input.message.trim()) {
    return {
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "The message is empty",
    };
  }
  const convo = await getConversation(input.conversationId, input.userId);
  if (!convo) {
    return { ok: false, code: "NOT_FOUND", message: "Conversation not found" };
  }
  const cap = convo.status === "funded" ? MAX_MESSAGES_FUNDED : MAX_MESSAGES;
  if (((convo.messages ?? []) as unknown[]).length >= cap) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: "This conversation is at its length limit; start a fresh one",
    };
  }
  if (!checkTurnRateLimit(input.userId)) return rateLimited();
  return beginTurn(convo, input.message.trim());
}

export type FundResult =
  | { ok: true; conversation: GrantConversation; grantId: string }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "NOT_PROPOSED"
        | "BUDGET_BELOW_QUOTE"
        | "INSUFFICIENT_OWLS"
        | "PLATFORM_FUNDS_BY_APPROVAL"
        | "TURN_IN_PROGRESS";
      message: string;
    };

/**
 * Fund the drafted mandate: escrow the budget and create the grant, active
 * immediately (the mandate IS the approved plan — the funder read it in the
 * conversation and is funding exactly it).
 */
export async function fundConversationMandate(input: {
  conversationId: string;
  userId: string;
  budgetOwls: number;
}): Promise<FundResult> {
  const convo = await getConversation(input.conversationId, input.userId);
  if (!convo) {
    return { ok: false, code: "NOT_FOUND", message: "Conversation not found" };
  }
  // The platform's money moves only through the operator route, once a
  // public approval pins the draft (#529); never through this path, whoever
  // is holding the platform's conversation.
  if (await isPlatformAccount(convo.userId)) {
    return {
      ok: false,
      code: "PLATFORM_FUNDS_BY_APPROVAL",
      message:
        "A platform mandate is funded by a reviewed approval that pins this " +
        "draft (mandates/platform/ in the repository), not from the conversation",
    };
  }
  const mandate = convo.mandate as GrantMandate | null;
  if (convo.status !== "proposed" || !mandate) {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: "There is no drafted mandate to fund yet",
    };
  }
  // A running turn may still revise the draft; fund what it settles on.
  if (turnRunning(convo)) {
    return {
      ok: false,
      code: "TURN_IN_PROGRESS",
      message:
        "The Grantmaker is still replying and may revise the draft; fund it " +
        "once the conversation's turn is idle",
    };
  }
  if (input.budgetOwls < mandate.expected_cost_owls) {
    return {
      ok: false,
      code: "BUDGET_BELOW_QUOTE",
      message:
        `The drafted mandate is quoted at ${mandate.expected_cost_owls} ` +
        `owls; fund at least that (unspent budget refunds)`,
    };
  }

  const db = getDb();
  const budgetMicro = owlsToMicroUsd(input.budgetOwls);

  // Claim the conversation first, conditionally: two concurrent /fund
  // calls must not both escrow and mint two grants from one conversation.
  const claimed = await rawQuery<{ id: string }>(
    `UPDATE grant_conversations SET status = 'funding', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'proposed'
        AND (turn_started_at IS NULL
             OR turn_heartbeat_at < now() - make_interval(secs => $3))
      RETURNING id`,
    [convo.id, input.userId, TURN_LOST_AFTER_MS / 1000]
  );
  if (claimed.length === 0) {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: "This mandate is already being funded, or a turn just started",
    };
  }
  const revertClaim = () =>
    rawQuery(
      `UPDATE grant_conversations SET status = 'proposed', updated_at = now()
        WHERE id = $1 AND status = 'funding'`,
      [convo.id]
    );

  const [job] = await db
    .insert(budgetJobs)
    .values({
      userId: input.userId,
      kind: "grant",
      claimId: mandate.scope_claim_id ?? null,
      budgetMicroUsd: 0,
      status: "running",
    })
    .returning();

  // Escrow behind the balance guard, under the owl-balance lock (same
  // shape as chargeOwls).
  const held = await withOwlBalanceLock(input.userId, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       SELECT $1, $2, 'escrow_hold', $3
        WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
                 FROM owl_ledger WHERE user_id = $1) >= $4
       RETURNING id`,
      [input.userId, -budgetMicro, job!.id, budgetMicro]
    )
  );
  if (held.length === 0) {
    await db.delete(budgetJobs).where(eq(budgetJobs.id, job!.id));
    await revertClaim();
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Funding this mandate takes ${input.budgetOwls} owls and your balance can't cover it`,
    };
  }
  await db
    .update(budgetJobs)
    .set({ budgetMicroUsd: budgetMicro })
    .where(eq(budgetJobs.id, job!.id));

  const [grant] = await db
    .insert(grants)
    .values({
      funderUserId: input.userId,
      budgetJobId: job!.id,
      name: mandate.title,
      scopeClaimId: mandate.scope_claim_id ?? null,
      scopeQuery: mandate.scope_query ?? null,
      policy: "agent",
      status: "active",
      plan: mandate.plan,
      planCursor: 0,
      // The public dashboard's text: the agent-authored mandate, verbatim.
      mandate,
      // The domain skills the mandate's Grantmaker carries on its review
      // passes (docs/mathematics.md §3.4); proposed by the Grantmaker itself.
      skills: mandate.skills ?? [],
    })
    .returning();

  const [updated] = await db
    .update(grantConversations)
    .set({ status: "funded", grantId: grant!.id, updatedAt: new Date() })
    .where(eq(grantConversations.id, convo.id))
    .returning();
  return { ok: true, conversation: updated!, grantId: grant!.id };
}

/** True when the account is the platform's own (`platform:minerval`). */
export async function isPlatformAccount(userId: string): Promise<boolean> {
  const [row] = await rawQuery<{ external_id: string }>(
    `SELECT external_id FROM contributors WHERE id = $1`,
    [userId]
  );
  return row?.external_id === PLATFORM_EXTERNAL_ID;
}

export async function getConversation(
  conversationId: string,
  userId: string
): Promise<GrantConversation | null> {
  const db = getDb();
  const [convo] = await db
    .select()
    .from(grantConversations)
    .where(eq(grantConversations.id, conversationId))
    .limit(1);
  if (!convo || convo.userId !== userId) return null;
  return convo;
}

export async function listConversations(
  userId: string,
  limit = 50
): Promise<GrantConversation[]> {
  const db = getDb();
  return db
    .select()
    .from(grantConversations)
    .where(eq(grantConversations.userId, userId))
    .orderBy(desc(grantConversations.createdAt))
    .limit(limit);
}

/**
 * The Grantmaker's turn, for a caller waiting on a reply: "replying" while
 * it runs (read the conversation again shortly; `partial` is the reply so
 * far, for showing it as it forms), "idle" when the last
 * message is its reply, "failed" when it ended without one (the funder's
 * message is saved; send a short follow-up to ask again).
 */
export function serializeTurn(convo: TurnFields, now = Date.now()) {
  if (convo.turnStartedAt) {
    if (turnRunning(convo, now)) {
      return {
        state: "replying" as const,
        started_at: convo.turnStartedAt.toISOString(),
        error: null,
        // What the Grantmaker has written of its reply so far; null until
        // it starts writing.
        partial: convo.turnPartial || null,
      };
    }
    return {
      state: "failed" as const,
      started_at: convo.turnStartedAt.toISOString(),
      error:
        "The Grantmaker's turn was interrupted (the server restarted) " +
        "before it replied",
      partial: null,
    };
  }
  return convo.turnError
    ? { state: "failed" as const, started_at: null, error: convo.turnError, partial: null }
    : { state: "idle" as const, started_at: null, error: null, partial: null };
}

export function serializeConversation(convo: GrantConversation) {
  const mandate = convo.mandate as GrantMandate | null;
  return {
    id: convo.id,
    status: convo.status,
    messages: (convo.messages ?? []) as ConversationMessage[],
    mandate: mandate
      ? {
          title: mandate.title,
          objective: mandate.objective,
          scope_claim_id: mandate.scope_claim_id ?? null,
          scope_query: mandate.scope_query ?? null,
          plan: mandate.plan,
          expected_cost_owls: mandate.expected_cost_owls,
          expected_cost_usd:
            Math.round(owlsToMicroUsd(mandate.expected_cost_owls) / 10_000) /
            100,
          notes: mandate.notes ?? null,
        }
      : null,
    turn: serializeTurn(convo),
    grant_id: convo.grantId,
    created_at: convo.createdAt?.toISOString(),
    updated_at: convo.updatedAt?.toISOString(),
  };
}
