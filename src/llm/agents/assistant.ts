/**
 * The Assistant (#646, #619, #312): an agent that works for one user.
 *
 * One turn of a conversation is one run: the visible transcript in, a reply
 * out, with the account's own tools in between (tools/assistant-tools.ts).
 * The run is traced and private, like a granting conversation's.
 *
 * It has no budget. Every other agent's run is given one by a payer who is
 * not present; the Assistant's payer is in the conversation, sees the bill
 * as it grows, and can stop the run. So the run is charged to the user's
 * balance as it goes (the `charge` hook, before each model turn and once at
 * the end), and what bounds it is that balance, the stop button, and the
 * turn guard. The agent is told the balance and the running cost after every
 * tool result in place of a budget line.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { toolUseLoop } from "../client.js";
import { getUsageContext, runWithUsageContext, withAgent } from "../usage-context.js";
import { RUN_TURN_GUARD } from "../prompts/turn-budget.js";
import {
  assistantSpendLine,
  DELEGATE_SECTION,
  getAssistantSystemPromptBlocks,
} from "../prompts/assistant.js";
import { permissionsNote } from "../permissions-note.js";
import {
  createAssistantTools,
  type AccountTools,
  type AccountToolResult,
  type HeldKind,
} from "../tools/assistant-tools.js";

type MessageParam = Anthropic.MessageParam;

export interface AssistantTranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

/** Why a run ended before the Assistant finished its reply. */
export type AssistantStop = "user" | "balance";

class AssistantStopped extends Error {
  constructor(readonly reason: AssistantStop) {
    super(`assistant run stopped: ${reason}`);
  }
}

export interface AssistantTurnInput {
  transcript: AssistantTranscriptMessage[];
  /** The context message for this reply (prompts/assistant.ts). */
  context: string;
  /** The surface sections to append to the role. */
  sections: string[];
  model: string;
  account: AccountTools;
  /** What the conversation had cost before this reply. */
  conversationMicroUsd: number;
  /**
   * Charge what the run has cost since the last call, and say what the
   * balance is now and whether the user has asked the run to stop.
   */
  charge: (replyMicroUsd: number) => Promise<{ balanceMicroUsd: number; stop: boolean }>;
  hold: (
    tool: string,
    kind: HeldKind,
    input: Record<string, unknown>
  ) => Promise<AccountToolResult | null>;
  onText?: (delta: string, turn: number) => void;
  onNote?: (text: string) => void;
  /** A tool is about to run: its name and what it was called with. */
  onTool?: (tool: string, input: Record<string, unknown>) => void;
}

export interface AssistantToolUse {
  tool: string;
  ok: boolean;
  /** A granting conversation the call opened or wrote to, when it did. */
  grantConversationId?: string;
  /** A page the call saved, when it did. */
  pageId?: string;
}

export interface AssistantTurnResult {
  reply: string;
  /** Set when the run ended early; the reply is what had been written. */
  stopped: AssistantStop | null;
  toolUses: AssistantToolUse[];
  runId: string | null;
}

const GRANT_TOOLS = new Set([
  "start_grant_conversation",
  "send_grant_message",
  "get_grant_conversation",
]);

/** The id of the granting conversation a grant tool's result names. */
function grantConversationIn(tool: string, text: string): string | undefined {
  if (!GRANT_TOOLS.has(tool)) return undefined;
  try {
    const id = (JSON.parse(text) as { conversation?: { id?: unknown } }).conversation?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The id of the page a save_page result names. */
function pageIn(tool: string, text: string): string | undefined {
  if (tool !== "save_page") return undefined;
  try {
    const id = (JSON.parse(text) as { page?: { id?: unknown } }).page?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  return withAgent("assistant", () => runAssistantTurnImpl(input));
}

async function runAssistantTurnImpl(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const meter = { billedMicroUsd: 0 };
  return runWithUsageContext({ meter }, async () => {
    const runId = getUsageContext().runId ?? null;
    const toolUses: AssistantToolUse[] = [];
    let balanceMicroUsd = 0;
    let costAtLastTurn = 0;
    let lastTurnMicroUsd = 0;

    // The hook every loop of this run calls before a model turn, the
    // delegated copies' loops included: settle what the run has cost so far,
    // and end the run when the balance is gone or the user pressed stop.
    const beforeTurn = async () => {
      lastTurnMicroUsd = meter.billedMicroUsd - costAtLastTurn;
      costAtLastTurn = meter.billedMicroUsd;
      const state = await input.charge(meter.billedMicroUsd);
      balanceMicroUsd = state.balanceMicroUsd;
      if (state.stop) throw new AssistantStopped("user");
      if (state.balanceMicroUsd <= 0) throw new AssistantStopped("balance");
    };
    const turnNote = (used: number, max: number) =>
      assistantSpendLine({
        replyMicroUsd: meter.billedMicroUsd,
        conversationMicroUsd: input.conversationMicroUsd + meter.billedMicroUsd,
        balanceMicroUsd: Math.max(0, balanceMicroUsd - (meter.billedMicroUsd - costAtLastTurn)),
        lastTurnMicroUsd: meter.billedMicroUsd - costAtLastTurn || lastTurnMicroUsd,
        used,
        max,
      });

    const used = (tool: string, result: { text: string; isError: boolean }) => {
      toolUses.push({
        tool,
        ok: !result.isError,
        ...(result.isError
          ? {}
          : {
              grantConversationId: grantConversationIn(tool, result.text),
              pageId: pageIn(tool, result.text),
            }),
      });
    };

    // Say what is about to run before it runs, so the user watching a long
    // reply sees the work and not a still page.
    const announced =
      (execute: (name: string, toolInput: Record<string, unknown>) => Promise<string>) =>
      (name: string, toolInput: Record<string, unknown>) => {
        input.onTool?.(name, toolInput);
        return execute(name, toolInput);
      };

    const system = getAssistantSystemPromptBlocks();
    const blocks = (extra: string[]) => [system[0]! + extra.join("")];

    // In a members-only deployment, the tools this user's permissions leave
    // out, and why (permissions-note.ts). Empty everywhere else. The reply's
    // run and each delegated copy are told at the head of their own first
    // message, since a copy sees nothing of this conversation.
    const permissions = permissionsNote(input.account.withheld ?? []);

    // A delegated copy: the same tools without delegate, a fresh
    // conversation holding only the task, on the same meter.
    const delegate = async (task: string): Promise<string> => {
      const copy = createAssistantTools(input.account, {
        hold: input.hold,
        note: (text) => input.onNote?.(text),
        used,
      });
      const result = await toolUseLoop({
        initialMessages: [
          { role: "user", content: permissions ? `${permissions}\n\n---\n\n${task}` : task },
        ],
        tools: copy.definitions,
        system: blocks([DELEGATE_SECTION]),
        model: input.model,
        maxIterations: RUN_TURN_GUARD,
        stream: true,
        executeTool: announced(copy.execute),
        beforeTurn,
        turnNote,
      });
      return result.content || "(The copy ended without a report.)";
    };

    const tools = createAssistantTools(input.account, {
      hold: input.hold,
      note: (text) => input.onNote?.(text),
      delegate,
      used,
    });

    const messages: MessageParam[] = input.transcript.map((m, i) => ({
      role: m.role,
      content:
        i === input.transcript.length - 1 && m.role === "user"
          ? `${input.context}${permissions ? `\n\n${permissions}` : ""}\n\n---\n\n${m.content}`
          : m.content,
    }));

    // The reply as it stands, for a run that ends early: the text of the
    // model turn in progress, which is what the user was watching form.
    let partial = "";
    let partialTurn = -1;
    const onText = (delta: string, turn: number) => {
      if (turn !== partialTurn) {
        partialTurn = turn;
        partial = "";
      }
      partial += delta;
      input.onText?.(delta, turn);
    };

    let reply = "";
    let stopped: AssistantStop | null = null;
    try {
      const result = await toolUseLoop({
        initialMessages: messages,
        tools: tools.definitions,
        system: blocks(input.sections),
        model: input.model,
        // A halting guard only: what bounds the run is its user's balance
        // and their stop button (see the module comment).
        maxIterations: RUN_TURN_GUARD,
        stream: true,
        executeTool: announced(tools.execute),
        beforeTurn,
        turnNote,
        onText,
      });
      reply = result.content;
    } catch (err) {
      if (!(err instanceof AssistantStopped)) throw err;
      stopped = err.reason;
      reply = partial;
    } finally {
      // Whatever the last model turn cost is settled here; an error leaves
      // the user charged for the work that ran, as a stop does.
      await input.charge(meter.billedMicroUsd).catch(() => undefined);
    }
    return { reply, stopped, toolUses, runId };
  });
}
