/**
 * The running side of a session (session-service.ts): reading what came back
 * while the run works, and wait_for_answers, the short wait for a run that has
 * nothing else to do while an answer is outstanding.
 *
 * A petition, research and a question to another Steward never block when
 * sent. Their answers appear in the run's next tool result. A run with nothing
 * else to do calls wait_for_answers, which holds it for a short, stated time,
 * since most petitions are decided in seconds; past that, the run ends its
 * turn and its session pauses until the answers arrive.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { getUsageContext } from "../usage-context.js";
import { creditRunBudget, runBudgetLeft } from "../run-funding.js";
import { runWithUsageContext } from "../usage-context.js";
import { randomUUID } from "node:crypto";
import { originalPayer } from "../../services/commission-service.js";
import {
  outstanding,
  renderResearchSessionArrivals,
  suspendSession,
  takeLiveReplies,
  type SessionRow,
} from "../../services/session-service.js";

type Tool = Anthropic.Tool;

export const WAIT_FOR_ANSWERS = "wait_for_answers";

export function getSessionToolDefinitions(): Tool[] {
  const seconds = loadConfig().sessionWaitForAnswersSeconds;
  return [
    {
      name: WAIT_FOR_ANSWERS,
      description:
        "Wait for what you are waiting on: a petition's decision, research you commissioned, or an " +
        "answer to a message you sent with expects_reply. Call it only when you have nothing else to " +
        "do without them: answers that arrive while you work appear in your next tool result anyway. " +
        `It waits at most ${seconds} seconds and returns as soon as one arrives. The limit is short ` +
        "because waiting holds this node and a worker that other work needs, and most petitions are " +
        "decided in seconds. If nothing has come by then, end your turn: your session pauses with this " +
        "conversation intact and resumes when the answers arrive.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
  ];
}

/**
 * Answers that arrived for this run, shown once, as a tool result reads them.
 * A grant that came with one is already placed on the run's row; the run's
 * ceiling rises by it here, in the run's own context.
 */
export async function takeArrivals(sessionId: string): Promise<string | null> {
  const replies = await takeLiveReplies(sessionId);
  const credit = replies.reduce((sum, r) => sum + Number(r.credit_micro_usd ?? 0), 0);
  if (credit > 0) creditRunBudget(credit);
  return renderResearchSessionArrivals(replies);
}

async function waiting(sessionId: string): Promise<number> {
  const [s] = await rawQuery<Pick<SessionRow, "awaiting" | "replies">>(
    `SELECT awaiting, replies FROM agent_sessions WHERE id = $1`,
    [sessionId]
  );
  return s ? outstanding(s).length : 0;
}

export async function executeSessionTool(name: string, _input: Record<string, unknown>): Promise<string | null> {
  if (name !== WAIT_FOR_ANSWERS) return null;
  const session = getUsageContext().session;
  if (!session) return JSON.stringify({ success: false, message: "This run has nothing it can wait on." });
  const seconds = loadConfig().sessionWaitForAnswersSeconds;
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const arrived = await takeArrivals(session.id);
    if (arrived) return JSON.stringify({ success: true, message: arrived });
    if ((await waiting(session.id)) === 0) {
      return JSON.stringify({ success: true, message: "Nothing is outstanding: every answer you waited for has arrived." });
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return JSON.stringify({
    success: true,
    message:
      `Nothing has arrived in ${seconds} seconds. If you have nothing else to do, record what you can ` +
      `conclude now and end your turn: your session pauses with this conversation intact and resumes when ` +
      `the answers arrive.`,
  });
}

/** A paused session's conversation to continue, handed to an agent on resumption. */
export interface SessionResume {
  sessionId: string;
  messages: Anthropic.MessageParam[];
}

/**
 * The session an agent's run belongs to: a new one, or the paused one it
 * resumes. The run is executed inside `run` with the session in its usage
 * context; `loop` holds the hooks its tool loop takes (answers arriving
 * mid-run, the transcript at the end); `close` pauses the session when the
 * run ended waiting on answers, keeping `input` to rebuild the agent on
 * resumption, or closes it.
 */
export function openSession(role: string, nodeId: string | null, input: unknown, resume?: SessionResume) {
  const session = { id: resume?.sessionId ?? randomUUID(), role, nodeId };
  let transcript: Anthropic.MessageParam[] | null = null;
  return {
    session,
    initialMessages: (fresh: Anthropic.MessageParam[]) => resume?.messages ?? fresh,
    run: <T>(fn: () => Promise<T>) => runWithUsageContext({ session }, fn),
    loop: {
      pendingInput: async () => takeArrivals(session.id).catch(() => null),
      onEnd: (t: Anthropic.MessageParam[]) => {
        transcript = t;
      },
    },
    close: async (model?: string) => {
      if (!transcript) return;
      await suspendSession({
        id: session.id,
        transcript,
        model: model ?? "",
        budgetLeftMicroUsd: runBudgetLeft() ?? 0,
        payer: await originalPayer().catch(() => null),
        context: { input },
      }).catch((err) =>
        console.warn(`[session] pausing ${session.id} failed:`, err instanceof Error ? err.message : err)
      );
    },
  };
}

export type AgentSession = ReturnType<typeof openSession>;
