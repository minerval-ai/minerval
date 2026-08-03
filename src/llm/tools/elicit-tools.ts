/**
 * Elicit domain-tool adapter (#299).
 *
 * Episteme is an agentic USER, not a builder, of scientific-literature
 * infrastructure: instead of wiring our own connections to journals, the
 * Claim Steward consumes Elicit's remote MCP server as a client — the mirror
 * image of the MCP server we expose in src/mcp/server.ts (#73).
 *
 * Scope is deliberately tight: only Elicit's quick search tools
 * (search_papers, search_trials) are exposed, renamed with an `elicit_`
 * prefix so they cannot collide with graph tools. The long-running,
 * expensive report/systematic-review tools are NOT offered — they run for
 * minutes and would burn the Steward's iteration budget polling; if that
 * tier is ever warranted it belongs to the researcher subagent (#298).
 *
 * Every call here costs real money, not just tokens (#300), so availability
 * is gated twice before this module is even consulted: an ELICIT_API_KEY
 * must be configured, and the claim being stewarded must clear the
 * stewardElicitMinImportance threshold (§19 — only the highest-importance
 * claims warrant it). Failures degrade gracefully (§20): a down or erroring
 * provider yields an error tool-result the agent routes around, never a
 * crashed stewardship run.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, type Config } from "../../config.js";

export const ELICIT_TOOL_PREFIX = "elicit_";

// The quick, synchronous search tools only — see the module comment for why
// reports/systematic reviews are excluded.
const ALLOWED_ELICIT_TOOLS = new Set(["search_papers", "search_trials"]);

/** Whether the Elicit connector is configured at all (deploy-level switch). */
export function elicitConfigured(config: Config = loadConfig()): boolean {
  return config.elicitApiKey.length > 0;
}

/**
 * Whether the Steward run for a claim of this importance should be offered
 * the Elicit tools. The gate is importance (§19): Elicit is overkill for
 * most claims, so only those at or above the configured threshold (default
 * 0.75 — between the Major ≈0.6 and Central ≈0.9 anchors) get the tools in
 * their toolset at all.
 */
export function elicitEnabledForImportance(
  importance: number,
  config: Config = loadConfig()
): boolean {
  return elicitConfigured(config) && importance >= config.stewardElicitMinImportance;
}

export function isElicitTool(name: string): boolean {
  return name.startsWith(ELICIT_TOOL_PREFIX);
}

// One lazily-connected client per process. A failed connect clears the slot
// so a later run can retry against a recovered provider.
let clientPromise: Promise<Client> | null = null;

async function getElicitClient(config: Config): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "minerval-steward", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(config.elicitMcpUrl),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${config.elicitApiKey}` },
          },
        }
      );
      await client.connect(transport);
      return client;
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/** Test hook: drop the cached connection so each test starts cold. */
export function resetElicitClientForTests(): void {
  clientPromise = null;
}

/**
 * Discover the allowed Elicit tools from the live server and return them as
 * Anthropic tool definitions, prefixed `elicit_`. The schemas come from the
 * provider (use, don't rebuild — we never hand-maintain a copy that can
 * drift). Returns [] when the connector is unconfigured or the provider is
 * unreachable — a missing domain tool is a degraded run, not a failed one
 * (§20).
 */
export async function getElicitToolDefinitions(
  config: Config = loadConfig()
): Promise<Tool[]> {
  if (!elicitConfigured(config)) return [];
  try {
    const client = await getElicitClient(config);
    const { tools } = await client.listTools();
    return tools
      .filter((t) => ALLOWED_ELICIT_TOOLS.has(t.name))
      .map((t) => ({
        name: `${ELICIT_TOOL_PREFIX}${t.name}`,
        description: t.description ?? "",
        input_schema: t.inputSchema as Tool["input_schema"],
      }));
  } catch (err) {
    console.warn(
      `[elicit] tool discovery failed, proceeding without Elicit tools: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Execute an `elicit_*` tool call by proxying it to the Elicit MCP server.
 * Always returns a string tool-result; provider failures come back as a
 * structured error the agent can read and route around (§20), never a throw
 * that would kill the stewardship run.
 */
export async function executeElicitTool(
  toolName: string,
  input: Record<string, unknown>,
  config: Config = loadConfig()
): Promise<string> {
  const providerTool = toolName.slice(ELICIT_TOOL_PREFIX.length);
  if (!isElicitTool(toolName) || !ALLOWED_ELICIT_TOOLS.has(providerTool)) {
    return JSON.stringify({
      success: false,
      message: `Unknown Elicit tool: ${toolName}`,
    });
  }
  try {
    const client = await getElicitClient(config);
    const result = await client.callTool({
      name: providerTool,
      arguments: input,
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (result.isError) {
      return JSON.stringify({
        success: false,
        message:
          `Elicit returned an error: ${text || "(no detail)"}. Do not retry ` +
          `blindly; proceed with web_search and the evidence you have (§20).`,
      });
    }
    return text || JSON.stringify({ success: true, message: "(empty result)" });
  } catch (err) {
    // A transport-level failure may mean the cached connection died; clear it
    // so the next call (or run) reconnects fresh.
    clientPromise = null;
    return JSON.stringify({
      success: false,
      message:
        `Elicit is unavailable (${err instanceof Error ? err.message : String(err)}). ` +
        `Proceed without it: assess with web_search and the evidence you have (§20).`,
    });
  }
}
