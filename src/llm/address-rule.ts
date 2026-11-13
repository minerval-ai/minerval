/**
 * The tool loop's side of the rule on addresses
 * (services/given-addresses.ts): where a run reads material that is not
 * public, a tool takes an address only as it came from outside.
 *
 * Both loops (client.ts) pass their toolset and their executor through
 * underAddressRule once, before the first turn. Where the rule applies it
 * does three things, so that no agent's own code has to know:
 *
 *  - every tool call of a turn is held to it before anything is done with
 *    the turn (hold): each address in a call's input is replaced by the
 *    address as it was given, and a call with one that was not given is
 *    answered with the refusal and not run. That includes a call the
 *    agent's own code would take as its final one, whose input never goes
 *    through the executor: a plan that names documents to ingest is such a
 *    call, and its addresses are fetched later by workers no run watches;
 *  - resolve_identifier is offered beside any tool that takes an address,
 *    and run here (tools/identifier-tool.ts);
 *  - the addresses a search by the model's provider returned in a turn are
 *    recorded as given (afterTurn). A search the loop runs itself records
 *    its own (tools/web-search-tool.ts).
 *
 * A connection's tools are left out of all three (src/connections.ts).
 * Their arguments go to the organization's own system, which its
 * administrator offered tool by tool, and not to the open web; an address
 * inside that system is not one a search could have given.
 *
 * Where the rule does not apply, which is everywhere on the public graph,
 * the toolset and the executor come back as they were passed.
 */
import { isConnectionToolName } from "../connections.js";
import {
  fetchRuleApplies,
  inputAsGiven,
  noteGiven,
  RESOLVE_IDENTIFIER_TOOL_NAME,
  toolTakesAddress,
} from "../services/given-addresses.js";
import { executeResolveIdentifier, getResolveIdentifierToolDefinition } from "./tools/identifier-tool.js";

export interface AddressRule<T, E> {
  /** Whether the run is told of the rule: it applies and a tool here takes an address. */
  told: boolean;
  tools: T[];
  executeTool: E;
  /** Record what a turn's provider-run search returned. */
  afterTurn: (rawContent: readonly unknown[]) => Promise<void>;
  /**
   * Hold a turn's tool calls to the rule. Each call's input is changed in
   * place to carry its addresses as they were given, and the calls that
   * name one that was not given come back by id, each with its refusal.
   */
  hold: (
    calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    /** The turn's blocks: a call's own block is changed with it, for code that reads the call from there. */
    rawContent?: readonly unknown[]
  ) => Promise<Map<string, string>>;
}

/** Whether the rule applies to the run in progress and one of `tools` takes an address. */
export async function toldOfAddressRule(tools: readonly object[] | undefined): Promise<boolean> {
  if (!tools || !tools.some(heldToTheRule)) return false;
  return fetchRuleApplies();
}

/** Whether a tool takes an address and is one the rule holds: not a connection's. */
function heldToTheRule(tool: object): boolean {
  const name = (tool as { name?: unknown }).name;
  return toolTakesAddress(tool) && !(typeof name === "string" && isConnectionToolName(name));
}

/**
 * The addresses a provider-run web search returned in one assistant turn:
 * each result of a `web_search_tool_result` block, and each citation the
 * API attached to the text from one. Nothing else in a turn is read: its
 * text and the inputs of its tool calls are the model's own words.
 */
export function searchResultAddresses(rawContent: readonly unknown[]): string[] {
  const found: string[] = [];
  const results = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(results);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "web_search_result" && typeof record.url === "string") found.push(record.url);
    else if (record.content !== undefined) results(record.content);
  };
  for (const block of rawContent) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "web_search_tool_result") results(record.content);
    if (record.type === "text" && Array.isArray(record.citations)) {
      for (const citation of record.citations as Array<Record<string, unknown>>) {
        if (citation?.type === "web_search_result_location" && typeof citation.url === "string") {
          found.push(citation.url);
        }
      }
    }
  }
  return found;
}

export async function underAddressRule<T extends object, R>(
  tools: T[],
  executeTool: (name: string, input: Record<string, unknown>) => Promise<R>
): Promise<AddressRule<T, (name: string, input: Record<string, unknown>) => Promise<R | string>>> {
  if (!(await fetchRuleApplies())) {
    return { told: false, tools, executeTool, afterTurn: async () => undefined, hold: async () => new Map<string, string>() };
  }
  const takes = tools.some(heldToTheRule);
  const named = (tool: T) => (tool as { name?: unknown }).name === RESOLVE_IDENTIFIER_TOOL_NAME;
  return {
    told: takes,
    tools: takes && !tools.some(named) ? [...tools, getResolveIdentifierToolDefinition() as unknown as T] : tools,
    executeTool: async (name, input) => (await executeResolveIdentifier(name, input)) ?? executeTool(name, input),
    hold: async (calls, rawContent = []) => {
      const refused = new Map<string, string>();
      for (const call of calls) {
        // The identifier tool's `id` is checked by its own shapes.
        if (call.name === RESOLVE_IDENTIFIER_TOOL_NAME || !call.input || typeof call.input !== "object") continue;
        if (isConnectionToolName(call.name)) continue;
        const given = await inputAsGiven(call.input);
        if ("refusal" in given) refused.set(call.id, given.refusal);
        else {
          call.input = given.input;
          for (const block of rawContent) {
            const b = block as { type?: unknown; id?: unknown; input?: unknown } | null;
            if (b && b.type === "tool_use" && b.id === call.id) b.input = given.input;
          }
        }
      }
      return refused;
    },
    afterTurn: async (rawContent) => {
      await noteGiven(searchResultAddresses(rawContent), "search");
    },
  };
}
