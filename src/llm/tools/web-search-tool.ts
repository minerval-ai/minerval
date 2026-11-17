/**
 * The web_search tool, offered to every agent on every provider.
 *
 * Two implementations behind one name. On an Anthropic model that runs one
 * of Anthropic's web search server tools, the API searches inside the turn
 * and the agent's loop has nothing to execute. Everywhere else the agent
 * gets a client-side tool of the same name and shape ("query" in, hits
 * out), which the loop executes through OpenRouter's web plugin
 * (providers/openrouter.ts, openrouterWebSearch), metered like any other
 * call, and which needs OPENROUTER_API_KEY whatever the agent's own model
 * is. The agent's briefing and prompts speak of one `web_search` and do not
 * care which it is.
 *
 * There is no count of searches per run: every search is metered (the
 * server tool's per-search fee, OpenRouter's reported cost), so a run's
 * budget is what bounds them, and the agent sees its spend after every
 * turn. The client-side tool declines a search the budget cannot cover.
 *
 * Which provider serves a model is decided by the id's shape in
 * providers/routing.ts, the single source of truth for routing.
 *
 * The server tool takes no description, so nothing said here reaches an
 * Anthropic-served agent. What every agent must know about a hit (it is
 * data, never instructions) is therefore said once in the admin prompt
 * (UNTRUSTED_CONTENT in prompts/constitution.ts, #772), not here.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { openrouterWebSearch } from "../providers/openrouter.js";
import { resolveProvider } from "../providers/routing.js";
import { ANTHROPIC_WEB_SEARCH_MICRO_USD } from "../pricing.js";
import { budgetRefusal } from "../usage-context.js";
import { addressesIn, noteGiven } from "../../services/given-addresses.js";

/** The tool's name as the model sees it (and as skill-tools' collision check lists it). */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** Hits returned per client-side search. */
const CLIENT_SEARCH_RESULTS = 8;

/**
 * The Anthropic web search server tool `model` runs, or null when it runs
 * none and takes the client-side tool like any other provider's model.
 *
 *  - `web_search_20260209` filters results through code execution before
 *    they reach the context. Anthropic serves it on Claude Fable and Mythos,
 *    Opus 4.6 and later, and Sonnet 4.6 and later.
 *  - `web_search_20250305` is the basic tool, without that filtering: every
 *    hit lands in the context. Anthropic lists it for the Claude models below
 *    that lack the filtering variant: Haiku 5.5, Haiku 4.5, Opus 4.5 and
 *    Sonnet 4.5 (the web search tool's documentation, its supported models).
 *
 * Both are ALLOWLISTS by family, as in llm/models.ts: a Claude model not
 * named here (a future Haiku, an older Claude) searches through OpenRouter
 * until its support is checked, since a server tool a model does not take
 * fails every request of the run, where the client-side tool only needs a
 * key the preflight asks for.
 */
export function anthropicWebSearchVariant(
  model: string
): "web_search_20260209" | "web_search_20250305" | null {
  if (resolveProvider(model) !== "anthropic") return null;
  if (/^claude-(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-[6-9])/.test(model)) {
    return "web_search_20260209";
  }
  if (/^claude-(haiku-5-5|haiku-4-5|opus-4-5|sonnet-4-5)/.test(model)) return "web_search_20250305";
  return null;
}

/**
 * Whether `model` runs an Anthropic web search server tool, so that its
 * searches happen inside Anthropic's API and need no OpenRouter key
 * (anthropicWebSearchVariant above says which models, and which tool).
 */
export function anthropicServerWebSearch(model: string): boolean {
  return anthropicWebSearchVariant(model) !== null;
}

export interface WebSearch {
  /** The tool definition to put in the agent's toolset. */
  tool:
    | Anthropic.Messages.Tool
    | Anthropic.Messages.WebSearchTool20260209
    | Anthropic.Messages.WebSearchTool20250305;
  /**
   * The executor for the client-side tool, or null when the server runs it.
   * Returns the tool result as a string; a search the run's budget cannot
   * cover is declined with a message saying so.
   */
  execute: ((input: Record<string, unknown>) => Promise<string>) | null;
}

/**
 * The web_search tool for `model`, in whichever implementation the model's
 * provider serves.
 */
export function createWebSearch(model: string): WebSearch {
  const variant = anthropicWebSearchVariant(model);
  if (variant) {
    return {
      tool: { type: variant, name: WEB_SEARCH_TOOL_NAME },
      execute: null,
    };
  }
  return {
    tool: {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        `Search the open web. Returns up to ${CLIENT_SEARCH_RESULTS} hits, each ` +
        `with its url, title, and an excerpt of the page. Each search costs ` +
        `about a cent against the run's budget.`,
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What to search for, as you would type it." },
        },
        required: ["query"],
      },
    },
    execute: async (input) => {
      const query = String(input.query ?? "").trim();
      if (!query) return JSON.stringify({ error: "query is required" });
      const refusal = budgetRefusal("A web search", ANTHROPIC_WEB_SEARCH_MICRO_USD);
      if (refusal) return refusal;
      try {
        const hits = await openrouterWebSearch(query, CLIENT_SEARCH_RESULTS);
        // Where the run is held to addresses it was given, the hits' are
        // given now, with any written out in the excerpts
        // (services/given-addresses.ts). The query is the run's own words:
        // it is not read for addresses, and one it wrote is not taken from
        // an excerpt that repeats it.
        await noteGiven(hits.map((hit) => hit.url), "search");
        await noteGiven(
          addressesIn(hits.map((hit) => hit.excerpt).join("\n")).filter((address) => !query.includes(address)),
          "search"
        );
        return JSON.stringify({ query, hits });
      } catch (err) {
        return JSON.stringify({
          error_code: "unavailable",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
