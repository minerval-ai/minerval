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
 */
import { desc, eq } from "drizzle-orm";
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
        | "RATE_LIMITED";
      message: string;
    };

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
 * Every turn runs the Grantmaker on the best model, synchronously, and
 * deliberately free — nothing is charged until a mandate is funded. The
 * per-conversation MAX_MESSAGES ceilings above don't bound this: a user can
 * open unlimited conversations, each with its own fresh allowance. And
 * because these turns are attributed to a user, they are outside the
 * process-wide LLM breaker (budget-tracker.ts scopes that to unattributed
 * work, on the grounds that attributed work is bounded by its own money —
 * true of a funded job, and true of this only once there is a rate on it).
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

async function runTurn(
  convo: GrantConversation,
  userMessage: string
): Promise<GrantConversation> {
  const db = getDb();
  const now = new Date().toISOString();
  const messages = [
    ...((convo.messages ?? []) as ConversationMessage[]),
    { role: "user" as const, content: userMessage, at: now },
  ];

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

  const turn = await runWithUsageContext(
    { userId: convo.userId, ...(jobId ? { jobId } : {}) },
    () =>
      runGrantmakerTurn({
        transcript: [
          ...transcriptOf(convo),
          { role: "user", content: userMessage },
        ],
        ...(funded && convo.grantId ? { grantId: convo.grantId } : {}),
      })
  );

  messages.push({
    role: "assistant",
    content: turn.reply,
    at: new Date().toISOString(),
  });

  const status = funded
    ? "funded" // management mode never changes the conversation's state
    : turn.mandate
      ? "proposed"
      : turn.declined
        ? "declined"
        : convo.status === "proposed"
          ? "proposed" // an unchanged draft stays fundable while they talk
          : "active";

  const [updated] = await db
    .update(grantConversations)
    .set({
      messages,
      status,
      ...(turn.mandate ? { mandate: turn.mandate } : {}),
      updatedAt: new Date(),
    })
    .where(eq(grantConversations.id, convo.id))
    .returning();
  return updated!;
}

/** Open a conversation with the funder's first message and get the reply. */
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
  const updated = await runTurn(convo!, input.message.trim());
  return { ok: true, conversation: updated };
}

/** Continue a conversation. Funded conversations are closed. */
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
  const updated = await runTurn(convo, input.message.trim());
  return { ok: true, conversation: updated };
}

export type FundResult =
  | { ok: true; conversation: GrantConversation; grantId: string }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_PROPOSED" | "BUDGET_BELOW_QUOTE" | "INSUFFICIENT_OWLS";
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
  const mandate = convo.mandate as GrantMandate | null;
  if (convo.status !== "proposed" || !mandate) {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: "There is no drafted mandate to fund yet",
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
      RETURNING id`,
    [convo.id, input.userId]
  );
  if (claimed.length === 0) {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: "This mandate is already being funded",
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

  // Escrow behind the balance guard (same shape as chargeOwls).
  const held = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
     SELECT $1, $2, 'escrow_hold', $3
      WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
               FROM owl_ledger WHERE user_id = $1) >= $4
     RETURNING id`,
    [input.userId, -budgetMicro, job!.id, budgetMicro]
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
    })
    .returning();

  const [updated] = await db
    .update(grantConversations)
    .set({ status: "funded", grantId: grant!.id, updatedAt: new Date() })
    .where(eq(grantConversations.id, convo.id))
    .returning();
  return { ok: true, conversation: updated!, grantId: grant!.id };
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
    grant_id: convo.grantId,
    created_at: convo.createdAt?.toISOString(),
    updated_at: convo.updatedAt?.toISOString(),
  };
}
