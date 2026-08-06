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

/** Hard ceiling on turns per conversation — a runaway/abuse backstop. */
const MAX_MESSAGES = 60;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export type ConverseResult =
  | { ok: true; conversation: GrantConversation }
  | {
      ok: false;
      code: "NOT_FOUND" | "CLOSED" | "TOO_LONG" | "EMPTY_MESSAGE";
      message: string;
    };

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

  const turn = await runWithUsageContext({ userId: convo.userId }, () =>
    runGrantmakerTurn({
      transcript: [
        ...transcriptOf(convo),
        { role: "user", content: userMessage },
      ],
    })
  );

  messages.push({
    role: "assistant",
    content: turn.reply,
    at: new Date().toISOString(),
  });

  const status = turn.mandate
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
  if (convo.status === "funded") {
    return {
      ok: false,
      code: "CLOSED",
      message:
        "This mandate is funded; follow it on its grant page. Start a new " +
        "conversation for new work.",
    };
  }
  if (((convo.messages ?? []) as unknown[]).length >= MAX_MESSAGES) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: "This conversation is at its length limit; start a fresh one",
    };
  }
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
