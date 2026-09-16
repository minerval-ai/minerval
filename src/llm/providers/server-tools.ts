/**
 * Which server tools belong to which provider. A server tool runs inside
 * the provider's request: the model calls it, the provider executes it, and
 * the loop has nothing to execute. Two vendors serve them:
 *
 *  - Anthropic's carry a versioned `type` ("web_search_20260209",
 *    "web_fetch_20260318", …) and no `input_schema`;
 *  - OpenRouter's carry a `type` under the "openrouter:" prefix
 *    ("openrouter:web_fetch") and a `parameters` object.
 *
 * Each is rejected on the other's adapter with a message naming the
 * capability, rather than sent to an API that will reject it on its own
 * terms. Dependency-free so the dialects and the adapters can all import it.
 */
import type { LlmTool } from "./types.js";

export const OPENROUTER_SERVER_TOOL_PREFIX = "openrouter:";

/** An OpenRouter server tool: `{ type: "openrouter:…", parameters?: {…} }`. */
export function isOpenRouterServerTool(tool: LlmTool): boolean {
  const type = (tool as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith(OPENROUTER_SERVER_TOOL_PREFIX);
}

/**
 * An Anthropic server tool (web_search, web_fetch, code execution, …):
 * a versioned `type` and no `input_schema`. Client tools always carry
 * `input_schema`.
 */
export function isAnthropicServerTool(tool: LlmTool): boolean {
  return !("input_schema" in tool) && !isOpenRouterServerTool(tool);
}

/** The name the failure message shows for a server tool. */
export function serverToolLabel(tool: LlmTool): string {
  const t = tool as { name?: string; type?: string };
  return t.name ?? t.type ?? "unknown";
}

/**
 * Fail with a message naming the capability when a request for `provider`
 * carries OpenRouter's server tools.
 */
export function assertOpenRouterServerToolsUnused(
  provider: string,
  model: string,
  opts: { tools?: LlmTool[] }
): void {
  const tools = (opts.tools ?? []).filter(isOpenRouterServerTool);
  if (tools.length === 0) return;
  throw new Error(
    `OpenRouter server tools (${tools.map(serverToolLabel).join(", ")}) are not ` +
      `supported on ${provider} (model "${model}"). They run only on an ` +
      `OpenRouter "vendor/model" id.`
  );
}
