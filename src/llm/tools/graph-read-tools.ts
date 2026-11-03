/**
 * Graph reads for agents: the shared free-read toolset.
 *
 * These are the reads any agent reasoning ABOUT the graph needs: find claims,
 * open one in full, walk down into what it rests on, walk up into what rests
 * on it. They cost no LLM tokens of their own and touch no money, so every
 * agent gets the same four regardless of what else it is allowed to do.
 *
 * The reads themselves (definitions and payloads) live in
 * services/graph-read-service.ts, which the MCP server serves to outside
 * callers too (#726): the mandate agents once hand-rolled a weaker search
 * than MCP's, and the agents' get_claim later lost the argument evaluations
 * MCP's also lacked, because the two were separate code. This module only
 * adapts them to an agent's tool loop.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  GRAPH_READ_TOOL_NAMES,
  graphReadDefinitions,
  runGraphRead,
} from "../../services/graph-read-service.js";

type Tool = Anthropic.Tool;

export { GRAPH_READ_TOOL_NAMES };

export function getGraphReadToolDefinitions(): Tool[] {
  return graphReadDefinitions("agent").map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.input_schema,
  }));
}

/**
 * Run one graph read. Returns null when `name` is not one of these tools, so
 * an agent's dispatcher can delegate here first and fall through to its own
 * handlers.
 */
export async function executeGraphReadTool(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  try {
    const result = await runGraphRead(name, input, "agent");
    if (!result) return null;
    return JSON.stringify(result.ok ? result.payload : { error: result.message });
  } catch (err) {
    // A model that cites a claim by a shortened or mangled id gets a tool
    // error it can recover from, not a query error that ends its run
    // (Postgres rejects the malformed uuid with 22P02).
    if ((err as { code?: string } | null)?.code === "22P02") {
      return JSON.stringify({
        error: "claim_id must be a full claim id (a uuid) exactly as a tool result gave it",
      });
    }
    throw err;
  }
}
