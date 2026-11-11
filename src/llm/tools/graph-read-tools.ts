/**
 * Graph reads for agents: the shared free-read toolset.
 *
 * These are the reads any agent reasoning ABOUT the graph needs: find claims,
 * open one in full, walk down into what it rests on, walk up into what rests
 * on it, and open one of its arguments (#541). They cost no LLM tokens of
 * their own and touch no money, so every agent gets the same five
 * regardless of what else it is allowed to do.
 *
 * The reads themselves are defined once and served to outside callers over
 * MCP too: get_claim in services/claim-view-service.ts (#774), and
 * search_claims, get_decomposition and get_dependents in
 * services/graph-read-service.ts (#726). The mandate agents once hand-rolled
 * a weaker search than MCP's, and later the agents' search lacked MCP's
 * filters while MCP's lacked contestation, because the two were separate
 * code. This module only adapts them to an agent's tool loop.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  CLAIM_VIEW_DESCRIPTION,
  CLAIM_VIEW_INCLUDE_DESCRIPTION,
  CLAIM_VIEW_INCLUDES,
  DEFAULT_DEPENDENTS_PAGE,
  MAX_DEPENDENTS_PAGE,
  getClaimView,
} from "../../services/claim-view-service.js";
import { graphReadDefinitions, runGraphRead } from "../../services/graph-read-service.js";
import {
  ARGUMENT_VIEW_DESCRIPTION,
  ARGUMENT_VIEW_INCLUDE_DESCRIPTION,
  ARGUMENT_VIEW_INCLUDES,
  DEFAULT_INSTANCES_PAGE,
  MAX_INSTANCES_PAGE,
  getArgumentView,
} from "../../services/argument-view-service.js";

export const GRAPH_READ_TOOL_NAMES = [
  "search_claims",
  "get_claim",
  "get_decomposition",
  "get_dependents",
  "get_argument",
] as const;

/**
 * The one `get_claim` (#774). Every agent that reads a node carries this
 * definition, and MCP registers the same description and sections, so a
 * skill that says `get_claim` means the same payload to every reader.
 */
export function getClaimToolDefinition(): Tool {
  return {
    name: "get_claim",
    description: CLAIM_VIEW_DESCRIPTION,
    input_schema: {
      type: "object" as const,
      properties: {
        claim_id: { type: "string" },
        include: {
          type: "array",
          items: { type: "string", enum: [...CLAIM_VIEW_INCLUDES] },
          description: CLAIM_VIEW_INCLUDE_DESCRIPTION,
        },
        dependents_limit: {
          type: "number",
          description: `With include "dependents": how many, ${DEFAULT_DEPENDENTS_PAGE} by default, ${MAX_DEPENDENTS_PAGE} at most.`,
        },
        dependents_offset: {
          type: "number",
          description: `With include "dependents": how many to skip, for the next page.`,
        },
      },
      required: ["claim_id"],
    },
  };
}

/** The one `get_argument` (#541), shared with MCP as get_claim is. */
export function getArgumentToolDefinition(): Tool {
  return {
    name: "get_argument",
    description: ARGUMENT_VIEW_DESCRIPTION,
    input_schema: {
      type: "object" as const,
      properties: {
        argument_id: { type: "string" },
        include: {
          type: "array",
          items: { type: "string", enum: [...ARGUMENT_VIEW_INCLUDES] },
          description: ARGUMENT_VIEW_INCLUDE_DESCRIPTION,
        },
        instances_limit: {
          type: "number",
          description: `With include "instances": how many, ${DEFAULT_INSTANCES_PAGE} by default, ${MAX_INSTANCES_PAGE} at most.`,
        },
        instances_offset: { type: "number", description: `With include "instances": how many to skip.` },
      },
      required: ["argument_id"],
    },
  };
}

/**
 * What a read answers when no node has the id it was given (#884). A model
 * that retypes a uuid can splice two ids into one that names nothing; told
 * only "claim not found", it has filed the miss as a fault in the graph. The
 * text says what happened and what to do, and `code` lets a dispatcher (the
 * Matcher's read repair) tell a miss from any other error without reading
 * prose.
 */
export const CLAIM_READ_MISS_CODES = ["CLAIM_NOT_FOUND", "INVALID_CLAIM_ID"] as const;
export type ClaimReadMissCode = (typeof CLAIM_READ_MISS_CODES)[number];

export function claimNotFoundError(claimId: unknown): { code: ClaimReadMissCode; error: string } {
  return {
    code: "CLAIM_NOT_FOUND",
    error:
      `No node has the id ${JSON.stringify(claimId ?? "")}. Nothing is missing from the graph: ` +
      `this id names no claim, quantity or question, which is what a retyped or shortened id ` +
      `looks like. Copy the id exactly from a tool result (a search hit, another node's view) ` +
      `and read again.`,
  };
}

/** The miss a read's JSON result carries, or null when it is anything else. */
export function claimReadMiss(result: string | null): ClaimReadMissCode | null {
  if (!result) return null;
  try {
    const code = (JSON.parse(result) as { code?: unknown } | null)?.code;
    return (CLAIM_READ_MISS_CODES as readonly unknown[]).includes(code)
      ? (code as ClaimReadMissCode)
      : null;
  } catch {
    return null;
  }
}

function optionalNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return raw == null || !Number.isFinite(n) ? undefined : n;
}

export function getGraphReadToolDefinitions(): Tool[] {
  const [search, decomposition, dependents] = graphReadDefinitions("agent").map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.input_schema,
  }));
  return [search!, getClaimToolDefinition(), decomposition!, dependents!, getArgumentToolDefinition()];
}

/**
 * Run one graph read. Returns null when `name` is not one of these tools, so
 * an agent's dispatcher can delegate here first and fall through to its own
 * mandate-specific handlers.
 */
export async function executeGraphReadTool(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  try {
    return await executeGraphReadToolUnchecked(name, input);
  } catch (err) {
    // A model that cites a claim by a shortened or mangled id gets a tool
    // error it can recover from, not a query error that ends its run
    // (Postgres rejects the malformed uuid with 22P02).
    if ((err as { code?: string } | null)?.code === "22P02") {
      return JSON.stringify(
        name === "get_argument"
          ? { error: "argument_id must be a full argument id (a uuid) exactly as a tool result gave it" }
          : {
              code: "INVALID_CLAIM_ID" satisfies ClaimReadMissCode,
              error: "claim_id must be a full claim id (a uuid) exactly as a tool result gave it",
            }
      );
    }
    throw err;
  }
}

async function executeGraphReadToolUnchecked(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (name === "get_claim") {
    const view = await getClaimView(String(input.claim_id ?? ""), {
      include: Array.isArray(input.include) ? input.include.map(String) : [],
      dependentsLimit: optionalNumber(input.dependents_limit),
      dependentsOffset: optionalNumber(input.dependents_offset),
    });
    return JSON.stringify(view ?? claimNotFoundError(input.claim_id));
  }
  if (name === "get_argument") {
    const view = await getArgumentView(String(input.argument_id ?? ""), {
      include: Array.isArray(input.include) ? input.include.map(String) : [],
      instancesLimit: optionalNumber(input.instances_limit),
      instancesOffset: optionalNumber(input.instances_offset),
    });
    return JSON.stringify(view ?? { error: "argument not found" });
  }
  const result = await runGraphRead(name, input);
  if (!result) return null;
  return JSON.stringify(result.ok ? result.payload : claimNotFoundError(input.claim_id));
}
