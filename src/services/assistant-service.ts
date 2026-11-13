/**
 * Assistant conversations (#646, #619, #312).
 *
 * A conversation is a user's private exchange with the Assistant
 * (llm/agents/assistant.ts). The turn protocol is the granting
 * conversation's: a message is saved and claims the turn, the reply is
 * written in the background with a heartbeat and the text as it forms, and
 * the caller reads the conversation until the turn is idle.
 *
 * Three things are this service's own:
 *
 *   - The bill. The Assistant's work has no cap. It is charged to the
 *     user's balance as it runs (owl-ledger chargeMetered, from the run's
 *     per-turn hook), the conversation keeps what it has cost, and the
 *     running turn's cost is saved as it grows so the page can show it.
 *     What stops a run is the balance reaching zero or the user's stop.
 *
 *   - Held actions. A tool that spends owls on the graph or publishes under
 *     the user's name waits as a row here until the user presses it or
 *     declines it (llm/tools/assistant-tools.ts says why). Pressing runs the
 *     same tool call the Assistant made, as the user.
 *
 *   - Allowed kinds. The user may let kinds of held action run without
 *     asking, for one conversation or for the account. An allowed call runs
 *     at once and is recorded here the same way, as a receipt.
 */
import { and, desc, eq, getTableColumns, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getDb, rawQuery } from "../db/client.js";
import {
  assistantAllowances,
  assistantConversations,
  assistantHeldActions,
  type AssistantConversation,
  type AssistantHeldAction,
} from "../db/schema.js";
import { loadConfig } from "../config.js";
import { currentLabel, runAtLabel, runWithUsageContext, untraced, withAgent } from "../llm/usage-context.js";
import { complete } from "../llm/client.js";
import { runAssistantTurn, type AssistantToolUse } from "../llm/agents/assistant.js";
import {
  getAssistantContext,
  getAssistantTitleSystemPrompt,
  EXTENSION_SECTION,
  NODE_SECTION,
  WEB_SECTION,
} from "../llm/prompts/assistant.js";
import { RUN_TURN_GUARD } from "../llm/prompts/turn-budget.js";
import { getChatContextPrompt } from "../llm/prompts/extension-agent.js";
import {
  assistantAuth,
  HELD_KINDS,
  HELD_TOOL_LABELS,
  HELD_TOOLS,
  isHeldKind,
  openAccountTools,
  type AccountToolResult,
  type HeldKind,
} from "../llm/tools/assistant-tools.js";
import { chargeMetered } from "./owl-ledger-service.js";
import { openAssistantStream, publishAssistantEvent } from "./assistant-stream.js";
import { getEntitlement, serializeEntitlement, serializeOwlPacks } from "./billing-service.js";
import { getClaimCards } from "./claim-card-service.js";

/** A model id as a person reads it: "claude-fable-5-2" is "Claude Fable 5.2". */
export function modelDisplayName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!m) return id;
  return `Claude ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** The operation the Assistant's charges carry in the owl history. */
export const ASSISTANT_OP = "assistant";

const HEARTBEAT_MS = 30_000;
const PARTIAL_FLUSH_MS = 1_000;
/** A turn whose heartbeat is older than this has lost its process. */
const TURN_LOST_AFTER_MS = 120_000;
const MAX_MESSAGE_CHARS = 20_000;

export interface AssistantCitation {
  id: string;
  kind: string;
  text: string;
  status: string | null;
  standing: string | null;
  estimate: Record<string, unknown> | null;
  unit: Record<string, unknown> | null;
  contestation: number | null;
  confidence: number | null;
  assessed_at: string | null;
  url: string;
}

export type AssistantCard =
  | { type: "held"; id: string }
  | { type: "grant_conversation"; id: string }
  | { type: "page"; id: string };

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  citations?: AssistantCitation[];
  /** What the run did, as tool names with counts. */
  worked?: Array<{ tool: string; count: number }>;
  /** What the reply cost its user. */
  cost_micro_usd?: number;
  run_id?: string | null;
  cards?: AssistantCard[];
  /** Set when the run ended before the reply was finished. */
  stopped?: "user" | "balance";
}

/** One thing a running turn did: the tool, and what it was pointed at. */
export interface AssistantActivity {
  tool: string;
  about: string | null;
}

const ACTIVITY_KEPT = 12;

/** The argument that says what a call was about, cut short. */
function aboutOf(input: Record<string, unknown>): string | null {
  for (const key of ["query", "q", "title", "text", "claim", "task", "message", "url", "name", "slug", "sql"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.replace(/\s+/g, " ").trim();
      return line.length > 90 ? `${line.slice(0, 90)}…` : line;
    }
  }
  return null;
}

export interface AssistantUser {
  id: string;
  externalId: string | null;
}

export type AssistantResult =
  | { ok: true; conversation: AssistantConversation }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "EMPTY_MESSAGE"
        | "TURN_IN_PROGRESS"
        | "INSUFFICIENT_OWLS"
        | "UNKNOWN_MODEL";
      message: string;
    };

// In-flight turns, so tests (and a graceful shutdown) can wait for them.
const pendingTurns = new Set<Promise<void>>();

/** Test hook: resolves once every turn started so far has finished. */
export async function settleAssistantTurns(): Promise<void> {
  while (pendingTurns.size > 0) await Promise.all([...pendingTurns]);
}

/** The models a user may pick for a conversation: the default first. */
export function assistantModels(): Array<{ id: string; name: string; default: boolean }> {
  const config = loadConfig();
  const ids = [...new Set([config.assistantModel, config.assistantStandardModel])];
  return ids.map((id, i) => ({ id, name: modelDisplayName(id), default: i === 0 }));
}

function modelFor(convo: AssistantConversation): string {
  const allowed = assistantModels().map((m) => m.id);
  return convo.model && allowed.includes(convo.model) ? convo.model : allowed[0]!;
}

const CITATION_RE =
  /\[claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** Node ids cited inline in a reply as [claim:<uuid>], in order of first use. */
export function citedIds(reply: string): string[] {
  return [...new Set([...reply.matchAll(CITATION_RE)].map((m) => m[1]!.toLowerCase()))];
}

/**
 * The cited nodes as the graph holds them now. An id that resolves to
 * nothing is left out, which drops its marker from the rendered reply: an
 * id made up from thin air virtually never resolves.
 */
async function hydrateCitations(reply: string): Promise<AssistantCitation[]> {
  const ids = citedIds(reply).slice(0, 100);
  if (ids.length === 0) return [];
  const cards = await getClaimCards(ids);
  const out: AssistantCitation[] = [];
  for (const id of ids) {
    const card = cards.get(id);
    if (!card) continue;
    out.push({
      id,
      kind: card.kind,
      text: card.text,
      status: card.assessment_status,
      standing: card.standing,
      estimate: card.estimate,
      unit: card.unit,
      contestation: card.contestation,
      confidence: card.assessment_confidence,
      assessed_at: card.assessed_at,
      url: card.page_url,
    });
  }
  return out;
}

function summarizeWork(uses: AssistantToolUse[]): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const u of uses) counts.set(u.tool, (counts.get(u.tool) ?? 0) + 1);
  return [...counts].map(([tool, count]) => ({ tool, count }));
}

// ---- allowed kinds ---------------------------------------------------------

function kindsOf(value: unknown): HeldKind[] {
  return Array.isArray(value) ? [...new Set(value.filter(isHeldKind))] : [];
}

/** The kinds the account allows without asking, in every conversation. */
export async function getAllowance(userId: string): Promise<HeldKind[]> {
  const [row] = await getDb()
    .select()
    .from(assistantAllowances)
    .where(eq(assistantAllowances.userId, userId))
    .limit(1);
  return kindsOf(row?.kinds);
}

export async function setAllowance(userId: string, kinds: unknown): Promise<HeldKind[]> {
  const clean = kindsOf(kinds);
  await getDb()
    .insert(assistantAllowances)
    .values({ userId, kinds: clean })
    .onConflictDoUpdate({
      target: assistantAllowances.userId,
      set: { kinds: clean, updatedAt: new Date() },
    });
  return clean;
}

async function allowedKinds(convo: { id: string; userId: string }): Promise<Set<HeldKind>> {
  const [row] = await getDb()
    .select({ kinds: assistantConversations.allowedKinds })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, convo.id))
    .limit(1);
  return new Set([...kindsOf(row?.kinds), ...(await getAllowance(convo.userId))]);
}

// ---- held actions ----------------------------------------------------------

function heldSummary(row: Pick<AssistantHeldAction, "tool" | "input">): string {
  const input = JSON.stringify(row.input);
  return `${row.tool} ${input.length > 300 ? `${input.slice(0, 300)}…` : input}`;
}

async function recordHeld(input: {
  conversationId: string;
  userId: string;
  tool: string;
  kind: HeldKind;
  input: Record<string, unknown>;
  ran?: AccountToolResult;
}): Promise<AssistantHeldAction> {
  const [row] = await getDb()
    .insert(assistantHeldActions)
    .values({
      conversationId: input.conversationId,
      userId: input.userId,
      tool: input.tool,
      kind: input.kind,
      input: input.input,
      // The Assistant's turn made this call, so it carries the turn's label
      // (src/labels.ts) to whenever the user presses.
      sensitivityLabel: currentLabel(),
      ...(input.ran
        ? {
            status: input.ran.isError ? "failed" : "done",
            auto: true,
            result: { ok: !input.ran.isError, text: input.ran.text },
            decidedAt: new Date(),
          }
        : {}),
    })
    .returning();
  return row!;
}

export type HeldDecision =
  | { ok: true; action: AssistantHeldAction }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_DECIDED"; message: string };

/**
 * The user's answer to a held action. "run" performs the same tool call the
 * Assistant made, as the user, and records what came back; "decline" records
 * that they said no. With `allow`, the action's kind (and any others named)
 * runs without asking from now on, in this conversation or in all of them.
 */
export async function decideHeldAction(input: {
  app: FastifyInstance;
  user: AssistantUser;
  conversationId: string;
  actionId: string;
  decision: "run" | "decline";
  allow?: { kinds?: unknown; scope: "conversation" | "always" };
}): Promise<HeldDecision> {
  const db = getDb();
  const mine = and(
    eq(assistantHeldActions.id, input.actionId),
    eq(assistantHeldActions.conversationId, input.conversationId),
    eq(assistantHeldActions.userId, input.user.id)
  );
  const [row] = await db.select().from(assistantHeldActions).where(mine).limit(1);
  if (!row) return { ok: false, code: "NOT_FOUND", message: "No such held action" };

  if (input.allow && input.decision === "run") {
    const kinds = [...new Set([...kindsOf(input.allow.kinds), row.kind as HeldKind])].filter(isHeldKind);
    if (input.allow.scope === "always") {
      await setAllowance(input.user.id, [...(await getAllowance(input.user.id)), ...kinds]);
    } else {
      const [convo] = await db
        .select({ kinds: assistantConversations.allowedKinds })
        .from(assistantConversations)
        .where(eq(assistantConversations.id, input.conversationId))
        .limit(1);
      await db
        .update(assistantConversations)
        .set({ allowedKinds: [...new Set([...kindsOf(convo?.kinds), ...kinds])] })
        .where(eq(assistantConversations.id, input.conversationId));
    }
  }

  // Claim the decision in one conditional write, so two presses run it once.
  const [claimed] = await db
    .update(assistantHeldActions)
    .set({ status: input.decision === "run" ? "running" : "declined", decidedAt: new Date() })
    .where(and(mine, eq(assistantHeldActions.status, "held")))
    .returning();
  if (!claimed) {
    return { ok: false, code: "ALREADY_DECIDED", message: "This action was already decided" };
  }
  if (input.decision === "decline") return { ok: true, action: claimed };

  const account = await openAccountTools(input.app, assistantAuth(input.user), `held:${claimed.id}`);
  let result: AccountToolResult;
  try {
    // The call is the one the Assistant made in its turn, run now. It runs
    // at the label that turn worked at, so an order, a job or a mandate it
    // creates is the turn's work and not the public work of a bare request.
    result = await runAtLabel(claimed.sensitivityLabel, `held action ${claimed.id}`, () =>
      runWithUsageContext({ userId: input.user.id }, () =>
        account.call(claimed.tool, claimed.input as Record<string, unknown>)
      )
    );
  } catch (err) {
    result = { isError: true, text: err instanceof Error ? err.message : String(err) };
  } finally {
    await account.close();
  }
  const [done] = await db
    .update(assistantHeldActions)
    .set({
      status: result.isError ? "failed" : "done",
      result: { ok: !result.isError, text: result.text },
    })
    .where(eq(assistantHeldActions.id, claimed.id))
    .returning();
  return { ok: true, action: done! };
}

async function heldActionsOf(conversationId: string): Promise<AssistantHeldAction[]> {
  return getDb()
    .select()
    .from(assistantHeldActions)
    .where(eq(assistantHeldActions.conversationId, conversationId))
    .orderBy(assistantHeldActions.createdAt);
}

// ---- turns -----------------------------------------------------------------

function turnRunning(convo: AssistantConversation, now = Date.now()): boolean {
  return (
    !!convo.turnStartedAt &&
    !!convo.turnHeartbeatAt &&
    convo.turnHeartbeatAt.getTime() > now - TURN_LOST_AFTER_MS
  );
}

async function claimTurn(
  convo: AssistantConversation,
  userMessage: string
): Promise<{ claimed: AssistantConversation; startedAt: Date } | null> {
  const startedAt = new Date();
  const entry: AssistantMessage = {
    role: "user",
    content: userMessage,
    at: startedAt.toISOString(),
  };
  const [claimed] = await getDb()
    .update(assistantConversations)
    .set({
      messages: sql`${assistantConversations.messages} || ${JSON.stringify([entry])}::jsonb`,
      turnStartedAt: startedAt,
      turnHeartbeatAt: startedAt,
      turnError: null,
      turnPartial: null,
      turnNote: null,
      turnActivity: null,
      turnCostMicroUsd: 0,
      stopRequested: false,
      updatedAt: startedAt,
    })
    .where(
      and(
        eq(assistantConversations.id, convo.id),
        or(
          isNull(assistantConversations.turnStartedAt),
          lt(
            assistantConversations.turnHeartbeatAt,
            new Date(startedAt.getTime() - TURN_LOST_AFTER_MS)
          )
        )
      )
    )
    .returning();
  return claimed ? { claimed, startedAt } : null;
}

/** The transcript the Assistant is given: the visible text of each message. */
function transcriptOf(convo: AssistantConversation) {
  return ((convo.messages ?? []) as AssistantMessage[]).map((m) => ({
    role: m.role,
    content:
      m.role === "assistant" && m.stopped
        ? `${m.content}\n\n[This reply ended early: ${
            m.stopped === "user" ? "your user stopped it" : "the balance ran out"
          }.]`
        : m.content || "(no text)",
  }));
}

/** The page a conversation was opened from in the browser extension. */
export interface AssistantPageOrigin {
  url: string | null;
  title: string | null;
  /** What the extension found on the page, as it reported it. */
  claims: Array<{
    verbatim_text: string;
    verdict: string;
    claim_id: string | null;
    canonical_form: string | null;
    status: string | null;
  }>;
}

type Origin = { node_id?: string; page?: AssistantPageOrigin } | null;

async function openedFrom(convo: AssistantConversation): Promise<string> {
  const origin = convo.origin as Origin;
  if (origin?.page) {
    // Everything in this block is the page's or the extension's reading of
    // it; the prompt's extension section says so.
    return (
      "the browser extension.\n\n" +
      getChatContextPrompt({
        pageUrl: origin.page.url,
        pageTitle: origin.page.title,
        pageClaims: origin.page.claims,
      })
    );
  }
  if (!origin?.node_id) return "the Ask page";
  const card = (await getClaimCards([origin.node_id])).get(origin.node_id);
  return card
    ? `the page of the ${card.kind} "${card.text}" (${card.id})`
    : `the page of node ${origin.node_id}`;
}

async function runTurn(
  app: FastifyInstance,
  user: AssistantUser,
  convo: AssistantConversation,
  startedAt: Date
): Promise<void> {
  const db = getDb();
  const holdsTurn = and(
    eq(assistantConversations.id, convo.id),
    eq(assistantConversations.turnStartedAt, startedAt)
  );
  const heartbeat = setInterval(() => {
    void db
      .update(assistantConversations)
      .set({ turnHeartbeatAt: new Date() })
      .where(holdsTurn)
      .catch((err) => console.error(`[assistant] heartbeat failed on ${convo.id}:`, err));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let partial = "";
  let partialTurn = -1;
  let flushed = "";
  let note: string | null = null;
  let flushedNote: string | null = null;
  const activity: AssistantActivity[] = [];
  let flushedActivity = 0;
  let steps = 0;
  const flush = () => {
    if (partial === flushed && note === flushedNote && steps === flushedActivity) return;
    flushed = partial;
    flushedNote = note;
    flushedActivity = steps;
    void db
      .update(assistantConversations)
      .set({ turnPartial: partial, turnNote: note, turnActivity: activity })
      .where(holdsTurn)
      .catch((err) => console.error(`[assistant] saving the partial reply on ${convo.id} failed:`, err));
  };
  const partialTimer = setInterval(flush, PARTIAL_FLUSH_MS);
  partialTimer.unref?.();

  // What this reply has been charged so far. The run reports its metered
  // cost; the difference since the last report is debited, up to what the
  // balance holds.
  let charged = 0;
  let metered = 0;
  const charge = async (replyMicroUsd: number) => {
    const delta = Math.max(0, replyMicroUsd - metered);
    metered = Math.max(metered, replyMicroUsd);
    const { chargedMicroUsd, balanceMicroUsd } = await chargeMetered({
      userId: user.id,
      microUsd: delta,
      op: ASSISTANT_OP,
    });
    charged += chargedMicroUsd;
    const [row] = await db
      .update(assistantConversations)
      .set({
        turnCostMicroUsd: charged,
        ...(chargedMicroUsd > 0
          ? { spentMicroUsd: sql`${assistantConversations.spentMicroUsd} + ${chargedMicroUsd}` }
          : {}),
      })
      .where(holdsTurn)
      .returning({ stop: assistantConversations.stopRequested });
    // A turn that no longer holds the conversation has been taken over: stop.
    return { balanceMicroUsd, stop: row ? row.stop : true };
  };

  const cards: AssistantCard[] = [];
  const hold = async (tool: string, kind: HeldKind, input: Record<string, unknown>) => {
    const allowed = (await allowedKinds(convo)).has(kind);
    const ran = allowed
      ? await account.call(tool, input).catch(
          (err): AccountToolResult => ({
            isError: true,
            text: err instanceof Error ? err.message : String(err),
          })
        )
      : undefined;
    const row = await recordHeld({
      conversationId: convo.id,
      userId: user.id,
      tool,
      kind,
      input,
      ...(ran ? { ran } : {}),
    });
    cards.push({ type: "held", id: row.id });
    return ran ?? null;
  };

  const account = await openAccountTools(app, assistantAuth(user), `assistant:${convo.id}`);
  const stream = openAssistantStream(convo.id);
  try {
    const model = modelFor(convo);
    const lastReplyAt = ((convo.messages ?? []) as AssistantMessage[])
      .filter((m) => m.role === "assistant")
      .at(-1)?.at;
    const held = await heldActionsOf(convo.id);
    const context = getAssistantContext({
      openedFrom: await openedFrom(convo),
      model: modelDisplayName(model),
      balanceMicroUsd: (await getEntitlement(user.id)).owlBalanceMicroUsd,
      conversationMicroUsd: convo.spentMicroUsd,
      allowedKinds: [...(await allowedKinds(convo))].map((k) => HELD_KINDS[k]),
      waiting: held.filter((h) => h.status === "held").map(heldSummary),
      decided: held
        .filter((h) => !h.auto && h.decidedAt && (!lastReplyAt || h.decidedAt > new Date(lastReplyAt)))
        .map((h) => {
          const result = h.result as { ok?: boolean; text?: string } | null;
          const what =
            h.status === "declined"
              ? "declined"
              : `pressed; it ${h.status === "done" ? "ran" : "failed"}: ${(result?.text ?? "").slice(0, 600)}`;
          return `${heldSummary(h)} (${what})`;
        }),
      maxTurns: RUN_TURN_GUARD,
    });

    const turn = await runWithUsageContext({ userId: user.id }, () =>
      runAssistantTurn({
        transcript: transcriptOf(convo),
        context,
        sections:
          convo.surface === "extension"
            ? [EXTENSION_SECTION]
            : [WEB_SECTION, ...((convo.origin as Origin)?.node_id ? [NODE_SECTION] : [])],
        model,
        account,
        conversationMicroUsd: convo.spentMicroUsd,
        charge,
        hold,
        onText: (delta, t) => {
          if (t !== partialTurn) {
            partialTurn = t;
            partial = "";
          }
          partial += delta;
          publishAssistantEvent(convo.id, { type: "text", turn: t, delta });
        },
        onNote: (text) => {
          note = text;
          publishAssistantEvent(convo.id, { type: "note", note: text });
        },
        onTool: (tool, toolInput) => {
          if (tool === "note_progress") return;
          steps += 1;
          activity.push({ tool, about: aboutOf(toolInput) });
          publishAssistantEvent(convo.id, { type: "activity", tool, about: aboutOf(toolInput) });
          // The page shows the latest steps; the reply keeps the full count.
          if (activity.length > ACTIVITY_KEPT) activity.shift();
        },
      })
    );
    clearInterval(partialTimer);

    for (const id of new Set(turn.toolUses.map((u) => u.grantConversationId).filter(Boolean))) {
      cards.push({ type: "grant_conversation", id: id! });
    }
    for (const id of new Set(turn.toolUses.map((u) => u.pageId).filter(Boolean))) {
      cards.push({ type: "page", id: id! });
    }
    const citations = await hydrateCitations(turn.reply).catch(() => []);
    const reply: AssistantMessage = {
      role: "assistant",
      content: turn.reply,
      at: new Date().toISOString(),
      ...(citations.length > 0 ? { citations } : {}),
      worked: summarizeWork(turn.toolUses),
      cost_micro_usd: charged,
      run_id: turn.runId,
      ...(cards.length > 0 ? { cards } : {}),
      ...(turn.stopped ? { stopped: turn.stopped } : {}),
    };
    await db
      .update(assistantConversations)
      .set({
        messages: sql`${assistantConversations.messages} || ${JSON.stringify([reply])}::jsonb`,
        turnStartedAt: null,
        turnHeartbeatAt: null,
        turnPartial: null,
        turnNote: null,
        turnActivity: null,
        stopRequested: false,
        updatedAt: new Date(),
      })
      .where(holdsTurn);
  } catch (err) {
    console.error(`[assistant] turn failed on conversation ${convo.id}:`, err);
    await db
      .update(assistantConversations)
      .set({
        turnStartedAt: null,
        turnHeartbeatAt: null,
        turnPartial: null,
        turnNote: null,
        turnActivity: null,
        stopRequested: false,
        turnError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        updatedAt: new Date(),
      })
      .where(holdsTurn)
      .catch((e) => console.error(`[assistant] recording the failure on ${convo.id} failed:`, e));
  } finally {
    clearInterval(heartbeat);
    clearInterval(partialTimer);
    await account.close();
    // After the reply (or the failure) is saved, so a watcher told the turn
    // is done reads it finished.
    stream.end();
  }
}

/** Reading costs nothing; a reply needs something to be charged against. */
async function affordable(userId: string): Promise<AssistantResult | null> {
  const entitlement = await getEntitlement(userId);
  if (entitlement.owlBalanceMicroUsd > 0) return null;
  return {
    ok: false,
    code: "INSUFFICIENT_OWLS",
    message:
      "The Assistant's work is charged in owls at what it costs, and your balance is 0. " +
      "Searching and reading the graph are free.",
  };
}

async function beginTurn(
  app: FastifyInstance,
  user: AssistantUser,
  convo: AssistantConversation,
  message: string
): Promise<AssistantResult> {
  const claim = await claimTurn(convo, message);
  if (!claim) {
    return {
      ok: false,
      code: "TURN_IN_PROGRESS",
      message:
        "The Assistant is still working on your last message. Your new message was not saved; " +
        "read the conversation until its turn is idle, or stop the turn, then send it.",
    };
  }
  const running = runTurn(app, user, claim.claimed, claim.startedAt).finally(() =>
    pendingTurns.delete(running)
  );
  pendingTurns.add(running);
  return { ok: true, conversation: claim.claimed };
}

/** A conversation is named by how it opened, cut at a word. */
function titleOf(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

/** What a model's title reply comes to, or null when it is not usable as one. */
export function cleanTitle(reply: string): string | null {
  const line = (reply.split("\n").find((l) => l.trim()) ?? "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, "")
    .replace(/\s+/g, " ");
  return line.length >= 2 && line.length <= 80 ? line : null;
}

/**
 * Give a new conversation a short name in place of its opening words. A
 * small model writes it from the first message while the Assistant starts
 * on the reply. Its cost is charged with the conversation's like the rest
 * of the work, and if it fails the opening words stay as the title.
 *
 * While the log is best-effort the call is untraced and the name is all
 * that is kept of it. The message is no secret from the log (it is in the
 * conversation, and in the transcript of the Assistant's reply); the reason
 * is deletion: deleting a conversation deletes the runs its messages name
 * (deleteAssistantConversation), and no message names this one. In record
 * mode, where a deleted conversation's runs are kept anyway, it is logged
 * like any run (untraced in llm/usage-context.ts): the prompt, the reply
 * and the seal, in a run of the "assistant" agent whose role part is
 * "assistant-title".
 */
async function nameConversation(convo: AssistantConversation, message: string): Promise<void> {
  const meter = { billedMicroUsd: 0 };
  try {
    const result = await runWithUsageContext({ userId: convo.userId, meter }, () =>
      withAgent("assistant", () =>
        untraced(() =>
          complete({
            model: loadConfig().assistantTitleModel,
            system: getAssistantTitleSystemPrompt(),
            messages: [{ role: "user", content: message.slice(0, 2_000) }],
            maxTokens: 400,
          })
        )
      )
    );
    const title = cleanTitle(result.content);
    if (title) {
      await getDb()
        .update(assistantConversations)
        .set({ title })
        .where(eq(assistantConversations.id, convo.id));
    }
  } catch (err) {
    console.error(`[assistant] naming conversation ${convo.id} failed:`, err);
  } finally {
    if (meter.billedMicroUsd > 0) {
      const { chargedMicroUsd } = await chargeMetered({
        userId: convo.userId,
        microUsd: meter.billedMicroUsd,
        op: ASSISTANT_OP,
      }).catch(() => ({ chargedMicroUsd: 0 }));
      if (chargedMicroUsd > 0) {
        await getDb()
          .update(assistantConversations)
          .set({ spentMicroUsd: sql`${assistantConversations.spentMicroUsd} + ${chargedMicroUsd}` })
          .where(eq(assistantConversations.id, convo.id))
          .catch(() => undefined);
      }
    }
  }
}

function cleanMessage(message: string): string {
  return message.trim().slice(0, MAX_MESSAGE_CHARS);
}

export async function startAssistantConversation(input: {
  app: FastifyInstance;
  user: AssistantUser;
  message: string;
  nodeId?: string | null;
  /** Set when the conversation is opened from the browser extension. */
  page?: AssistantPageOrigin | null;
  model?: string | null;
}): Promise<AssistantResult> {
  const message = cleanMessage(input.message);
  if (!message) return { ok: false, code: "EMPTY_MESSAGE", message: "The message is empty" };
  if (input.model && !assistantModels().some((m) => m.id === input.model)) {
    return { ok: false, code: "UNKNOWN_MODEL", message: "That model is not offered for the Assistant" };
  }
  const denied = await affordable(input.user.id);
  if (denied) return denied;
  const [convo] = await getDb()
    .insert(assistantConversations)
    .values({
      userId: input.user.id,
      // The label of the request that opens the conversation (src/labels.ts).
      sensitivityLabel: currentLabel(),
      title: titleOf(message),
      origin: input.page
        ? { page: input.page }
        : input.nodeId
          ? { node_id: input.nodeId }
          : null,
      ...(input.page ? { surface: "extension" } : {}),
      model: input.model ?? null,
    })
    .returning();
  const begun = await beginTurn(input.app, input.user, convo!, message);
  if (begun.ok) {
    const naming = nameConversation(convo!, message).finally(() => pendingTurns.delete(naming));
    pendingTurns.add(naming);
  }
  return begun;
}

export async function addAssistantMessage(input: {
  app: FastifyInstance;
  user: AssistantUser;
  conversationId: string;
  message: string;
}): Promise<AssistantResult> {
  const message = cleanMessage(input.message);
  if (!message) return { ok: false, code: "EMPTY_MESSAGE", message: "The message is empty" };
  const convo = await getAssistantConversation(input.conversationId, input.user.id);
  if (!convo) return { ok: false, code: "NOT_FOUND", message: "Conversation not found" };
  const denied = await affordable(input.user.id);
  if (denied) return denied;
  return beginTurn(input.app, input.user, convo, message);
}

// ---- reads and small writes ------------------------------------------------

export async function getAssistantConversation(
  conversationId: string,
  userId: string
): Promise<AssistantConversation | null> {
  const [convo] = await getDb()
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  if (!convo || convo.userId !== userId) return null;
  return convo;
}

/**
 * The user's conversations as a list shows them (serializeAssistantSummary),
 * newest first. Their transcripts are not read: `messages` is empty on every
 * row. Fifty whole transcripts were read for a list that shows titles, on
 * every page of the Ask section.
 */
export async function listAssistantConversations(
  userId: string,
  limit = 50
): Promise<AssistantConversation[]> {
  return getDb()
    .select({ ...getTableColumns(assistantConversations), messages: sql<unknown>`'[]'::jsonb` })
    .from(assistantConversations)
    .where(eq(assistantConversations.userId, userId))
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(limit);
}

/** Ask the running turn to stop at its next step. True when one was running. */
export async function stopAssistantTurn(conversationId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .update(assistantConversations)
    .set({ stopRequested: true })
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.userId, userId),
        gt(assistantConversations.turnHeartbeatAt, new Date(Date.now() - TURN_LOST_AFTER_MS))
      )
    )
    .returning({ id: assistantConversations.id });
  return rows.length > 0;
}

export async function setAssistantModel(
  conversationId: string,
  userId: string,
  model: string
): Promise<AssistantResult> {
  if (!assistantModels().some((m) => m.id === model)) {
    return { ok: false, code: "UNKNOWN_MODEL", message: "That model is not offered for the Assistant" };
  }
  const [convo] = await getDb()
    .update(assistantConversations)
    .set({ model })
    .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.userId, userId)))
    .returning();
  return convo
    ? { ok: true, conversation: convo }
    : { ok: false, code: "NOT_FOUND", message: "Conversation not found" };
}

/**
 * Delete a conversation: its text, its held actions and, where run logs are
 * a window and not a record, the transcripts of its runs. A run that wrote
 * to the graph keeps its transcript like any other (none of the Assistant's
 * does: it writes nothing itself). What the conversation cost stays in the
 * owl ledger.
 */
export async function deleteAssistantConversation(
  conversationId: string,
  userId: string
): Promise<boolean> {
  const convo = await getAssistantConversation(conversationId, userId);
  if (!convo) return false;
  const runIds = ((convo.messages ?? []) as AssistantMessage[])
    .map((m) => m.run_id)
    .filter((id): id is string => typeof id === "string");
  await getDb().delete(assistantConversations).where(eq(assistantConversations.id, convo.id));
  if (runIds.length > 0 && loadConfig().runLogMode !== "record") {
    await rawQuery(
      `DELETE FROM agent_runs WHERE id = ANY($1::uuid[]) AND wrote_to_graph = false`,
      [runIds]
    ).catch((err) => console.error(`[assistant] deleting the runs of ${convo.id} failed:`, err));
  }
  return true;
}

// ---- wire shapes -----------------------------------------------------------

function serializeTurn(convo: AssistantConversation, now = Date.now()) {
  if (convo.turnStartedAt) {
    if (turnRunning(convo, now)) {
      return {
        state: "replying" as const,
        started_at: convo.turnStartedAt.toISOString(),
        error: null,
        partial: convo.turnPartial || null,
        note: convo.turnNote || null,
        activity: (convo.turnActivity ?? []) as AssistantActivity[],
        cost_micro_usd: convo.turnCostMicroUsd,
        stopping: convo.stopRequested,
      };
    }
    return {
      state: "failed" as const,
      started_at: convo.turnStartedAt.toISOString(),
      error: "The Assistant's turn was interrupted (the server restarted) before it replied",
      partial: null,
      note: null,
      activity: [] as AssistantActivity[],
      cost_micro_usd: convo.turnCostMicroUsd,
      stopping: false,
    };
  }
  const idle = {
    started_at: null,
    partial: null,
    note: null,
    activity: [] as AssistantActivity[],
    cost_micro_usd: 0,
    stopping: false,
  };
  return convo.turnError
    ? { state: "failed" as const, error: convo.turnError, ...idle }
    : { state: "idle" as const, error: null, ...idle };
}

function serializeHeld(row: AssistantHeldAction) {
  const kind = isHeldKind(row.kind) ? row.kind : null;
  return {
    id: row.id,
    tool: row.tool,
    label: HELD_TOOL_LABELS[row.tool] ?? row.tool,
    kind: row.kind,
    kind_label: kind ? HELD_KINDS[kind] : row.kind,
    input: row.input,
    status: row.status,
    ran_without_asking: row.auto,
    result: row.result ?? null,
    created_at: row.createdAt.toISOString(),
    decided_at: row.decidedAt?.toISOString() ?? null,
  };
}

/** A conversation as a list shows it. */
export function serializeAssistantSummary(convo: AssistantConversation) {
  return {
    id: convo.id,
    title: convo.title,
    spent_micro_usd: convo.spentMicroUsd,
    turn_state: serializeTurn(convo).state,
    created_at: convo.createdAt.toISOString(),
    updated_at: convo.updatedAt.toISOString(),
  };
}

/** A conversation in full: transcript, held actions, turn, bill and balance. */
export async function serializeAssistantConversation(convo: AssistantConversation) {
  const [held, account, entitlement] = await Promise.all([
    heldActionsOf(convo.id),
    getAllowance(convo.userId),
    getEntitlement(convo.userId),
  ]);
  return {
    ...serializeAssistantSummary(convo),
    surface: convo.surface,
    origin: convo.origin ?? null,
    model: modelFor(convo),
    models: assistantModels(),
    messages: (convo.messages ?? []) as AssistantMessage[],
    held_actions: held.map(serializeHeld),
    allowed_kinds: {
      conversation: kindsOf(convo.allowedKinds),
      always: account,
      labels: HELD_KINDS,
    },
    turn: serializeTurn(convo),
    balance_micro_usd: entitlement.owlBalanceMicroUsd,
  };
}

/** The body of a 402: what the balance is and how to add to it. */
export async function insufficientOwlsBody(userId: string, message: string) {
  return {
    error: message,
    code: "INSUFFICIENT_OWLS",
    entitlement: serializeEntitlement(await getEntitlement(userId)),
    packs: serializeOwlPacks(),
  };
}

/** Every held tool with its kind, for the page's "always allow" form. */
export function heldToolKinds(): Record<string, HeldKind> {
  return { ...HELD_TOOLS };
}

