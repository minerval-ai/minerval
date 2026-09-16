import type Anthropic from "@anthropic-ai/sdk";
type MessageParam = Anthropic.MessageParam;
import { toolUseLoop } from "../client.js";
import {
  getGraphChatSystemPrompt,
  getGraphChatContextPrompt,
  type GraphChatContext,
} from "../prompts/graph-chat.js";
import {
  getGraphReadToolDefinitions,
  executeGraphReadTool,
} from "../tools/graph-read-tools.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

/**
 * The graph chat, "Ask the graph" (issue #312): a tool-use loop over the
 * shared read-only graph tools, answering a reader's questions grounded in
 * the graph with claim references. It began life as the chat half of the
 * Extension Agent (#72) and still serves the extension's popup in page mode;
 * claim mode and graph mode serve the website. It never edits the graph.
 *
 * Every mode runs untraced at the service layer: the questions are the
 * reader's own and no transcript is kept (#356). What persists is metering.
 */

/** Meter tag for every LLM call in this agent (#70). */
export const GRAPH_CHAT_AGENT = "graph_chat";

/** How many model turns one exchange may take; the reply is due by the last. */
export const GRAPH_CHAT_MAX_ITERATIONS = 8;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GraphChatResult {
  reply: string;
  /** The model that produced the reply, so a surface can name it. */
  model: string | null;
}

export function graphChat(
  input: Parameters<typeof graphChatImpl>[0]
): ReturnType<typeof graphChatImpl> {
  return withAgent(GRAPH_CHAT_AGENT, () => graphChatImpl(input));
}

/**
 * Claim mode's head start: the claim's record with its arguments, and its
 * decomposition, fetched through the same tools the loop would otherwise
 * spend its first turn on. A lookup failure degrades to a bare id in the
 * context block; the loop can still open the claim itself.
 */
async function prefetchClaim(
  claimId: string
): Promise<{ claim: string; decomposition: string | null } | undefined> {
  try {
    const [claim, decomposition] = await Promise.all([
      executeGraphReadTool("get_claim", { claim_id: claimId, include: ["arguments"] }),
      executeGraphReadTool("get_decomposition", { claim_id: claimId, max_depth: 2 }),
    ]);
    if (!claim) return undefined;
    return { claim, decomposition };
  } catch {
    return undefined;
  }
}

async function graphChatImpl(input: {
  messages: ChatTurn[];
  context: GraphChatContext;
  model?: string;
}): Promise<GraphChatResult> {
  const prefetched =
    input.context.kind === "claim"
      ? await prefetchClaim(input.context.claimId)
      : undefined;
  const contextBlock = getGraphChatContextPrompt(input.context, prefetched);

  // Prepend the context to the first user turn so the conversation history
  // stays a clean alternation of roles.
  const history = input.messages.slice();
  const first = history.findIndex((m) => m.role === "user");
  const initialMessages: MessageParam[] = history.map((m, i) => ({
    role: m.role,
    content: i === first ? `${contextBlock}\n\n---\n\n${m.content}` : m.content,
  }));

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model: input.model });

  const result = await toolUseLoop({
    initialMessages,
    tools: [...getGraphReadToolDefinitions(), ...reportTools.definitions],
    system: getGraphChatSystemPrompt(),
    maxTokens: 4096,
    maxIterations: GRAPH_CHAT_MAX_ITERATIONS,
    model: input.model,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const read = await executeGraphReadTool(name, toolInput);
      if (read !== null) return read;
      return `Error: Unknown tool: ${name}`;
    },
  });

  return { reply: result.content, model: result.servedModel ?? input.model ?? null };
}
