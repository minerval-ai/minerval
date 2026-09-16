/**
 * The web_search server tool, offered to an agent only where its provider
 * serves it.
 *
 * `web_search_20260209` is an Anthropic server tool: the API runs the search
 * itself and returns results inside the turn. No other provider has it, and
 * the OpenAI-dialect adapters refuse a request that carries one (see
 * assertAnthropicOnlyCapabilitiesUnused) — so an agent that put the tool in
 * its toolset unconditionally could not run on any "vendor/model" id at all.
 * Every agent that wants web search asks here instead of spelling the tool
 * out, and gets `null` where it would break; the agent's briefing should say
 * so, and the agent falls back to the graph, its recorded sources, and
 * read_page-style client tools.
 *
 * Which provider serves a model is decided by the id's shape in
 * providers/routing.ts, the single source of truth for routing.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { resolveProvider } from "../providers/routing.js";

/** The tool's name as the model sees it (and as skill-tools' collision check lists it). */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** Whether `model` is served by a provider that runs web_search server-side. */
export function webSearchAvailable(model: string): boolean {
  return resolveProvider(model) === "anthropic";
}

/**
 * The web_search tool for `model`, capped at `maxUses` searches per turn
 * budget, or `null` where the model's provider cannot serve it.
 */
export function webSearchTool(
  model: string,
  maxUses: number
): Anthropic.Messages.WebSearchTool20260209 | null {
  if (!webSearchAvailable(model)) return null;
  return {
    type: "web_search_20260209",
    name: WEB_SEARCH_TOOL_NAME,
    max_uses: maxUses,
  };
}

/**
 * The one-line briefing note an agent appends when web search is absent, so
 * the model neither looks for a tool it does not have nor pretends to have
 * searched. Empty when the tool is present.
 */
export function webSearchUnavailableNote(model: string): string {
  if (webSearchAvailable(model)) return "";
  return (
    "web_search is unavailable this run (the model is not served by a provider " +
    "that offers it). Assess on the sources already recorded, the graph, and " +
    "your own knowledge, and say in your reasoning that no web search was possible."
  );
}
