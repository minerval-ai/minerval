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
  CLAIM_VIEW_LAYERS_DESCRIPTION,
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
import { describeIdShape, isMalformedIdError } from "../seen-ids.js";
import { repairRead, type IdTarget } from "./id-repair.js";
import { overlaid } from "../../services/overlay-service.js";

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
    description: CLAIM_VIEW_DESCRIPTION + (overlaid() ? CLAIM_VIEW_LAYERS_DESCRIPTION : "") + ID_REPAIR_NOTE,
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
    description: ARGUMENT_VIEW_DESCRIPTION + ID_REPAIR_NOTE,
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
 * text says what happened and what to do, and `code` lets the read repair
 * (id-repair.ts) and the run's record of ids (seen-ids.ts) tell a miss from
 * any other result without reading prose.
 */
export const CLAIM_READ_MISS_CODES = ["CLAIM_NOT_FOUND", "INVALID_CLAIM_ID"] as const;
export type ClaimReadMissCode = (typeof CLAIM_READ_MISS_CODES)[number];
const ARGUMENT_READ_MISS_CODES = ["ARGUMENT_NOT_FOUND", "INVALID_ARGUMENT_ID"] as const;
type ReadMissCode = ClaimReadMissCode | (typeof ARGUMENT_READ_MISS_CODES)[number];
const READ_MISS_CODES: readonly string[] = [...CLAIM_READ_MISS_CODES, ...ARGUMENT_READ_MISS_CODES];

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

function invalidClaimIdError(claimId: unknown): { code: ClaimReadMissCode; error: string } {
  const shape = describeIdShape(claimId);
  return {
    code: "INVALID_CLAIM_ID",
    error:
      `claim_id ${JSON.stringify(claimId ?? "")} is not a node's id: ${shape ?? "it is not a uuid"}. ` +
      `Nothing is missing from the graph: this is what a retyped id looks like. Copy the id exactly ` +
      `from a tool result and read again.`,
  };
}

function argumentMissError(argumentId: unknown, malformed: boolean): { code: ReadMissCode; error: string } {
  return malformed
    ? {
        code: "INVALID_ARGUMENT_ID",
        error:
          `argument_id ${JSON.stringify(argumentId ?? "")} is not an argument's id: ` +
          `${describeIdShape(argumentId) ?? "it is not a uuid"}. Copy it exactly from a get_claim ` +
          `result (include "arguments") and read again.`,
      }
    : {
        code: "ARGUMENT_NOT_FOUND",
        error:
          `No argument has the id ${JSON.stringify(argumentId ?? "")}. Copy it exactly from a get_claim ` +
          `result (include "arguments") and read again.`,
      };
}

/** The miss a read's JSON result carries, or null when it is anything else. */
function readMiss(result: string | null): ReadMissCode | null {
  if (!result) return null;
  try {
    const code = (JSON.parse(result) as { code?: unknown } | null)?.code;
    return typeof code === "string" && READ_MISS_CODES.includes(code) ? (code as ReadMissCode) : null;
  } catch {
    return null;
  }
}

/**
 * Said on every read that takes an id, in an agent's toolset only: an MCP
 * caller has no run record and gets no repair.
 */
export const ID_REPAIR_NOTE =
  " An id that names nothing is read against the ids this run's tool results " +
  "have shown you: when exactly one of them is one character away from it " +
  "(added, dropped or changed) or begins with the same first group, that one " +
  "is read instead and `id_corrected` names both ids, so check it is the one " +
  "you meant. Otherwise the miss lists `nearest_seen_ids` with their wording; " +
  "copy the one you meant exactly. A miss is a mistyped id, not a fault in " +
  "the graph. Writes are never corrected this way.";

function optionalNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return raw == null || !Number.isFinite(n) ? undefined : n;
}

export function getGraphReadToolDefinitions(): Tool[] {
  const [search, decomposition, dependents] = graphReadDefinitions("agent").map((d) => ({
    name: d.name,
    description: d.name === "search_claims" ? d.description : d.description + ID_REPAIR_NOTE,
    input_schema: d.input_schema,
  }));
  return [search!, getClaimToolDefinition(), decomposition!, dependents!, getArgumentToolDefinition()];
}

/** The id each read takes, and what it names. */
const READ_ID_FIELDS: Record<string, { field: "claim_id" | "argument_id"; target: IdTarget }> = {
  get_claim: { field: "claim_id", target: "node" },
  get_decomposition: { field: "claim_id", target: "node" },
  get_dependents: { field: "claim_id", target: "node" },
  get_argument: { field: "argument_id", target: "argument" },
};

/**
 * Run one graph read. Returns null when `name` is not one of these tools, so
 * an agent's dispatcher can delegate here first and fall through to its own
 * mandate-specific handlers.
 *
 * A read whose id names nothing is repaired against the ids the run has
 * been shown (id-repair.ts, #934): every agent that carries these reads
 * gets it through this one function, inside the tool loop's record of the
 * run. Outside a loop there is no record, and the miss says so.
 */
export async function executeGraphReadTool(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  const first = await executeGraphReadOnce(name, input);
  const idField = READ_ID_FIELDS[name];
  if (first === null || !idField || readMiss(first) === null) return first;
  const miss = JSON.parse(first) as { code: string; error: string };
  return repairRead({
    target: idField.target,
    requested: input[idField.field],
    miss,
    reread: async (id) => {
      const second = await executeGraphReadOnce(name, { ...input, [idField.field]: id });
      return second !== null && readMiss(second) === null ? second : null;
    },
  });
}

async function executeGraphReadOnce(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  try {
    return await executeGraphReadToolUnchecked(name, input);
  } catch (err) {
    // A model that cites a claim by a shortened or mangled id gets a tool
    // error it can recover from, not a query error that ends its run
    // (Postgres rejects the malformed uuid with 22P02).
    if (isMalformedIdError(err)) {
      return JSON.stringify(
        name === "get_argument"
          ? argumentMissError(input.argument_id, true)
          : invalidClaimIdError(input.claim_id)
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
    return JSON.stringify(view ?? argumentMissError(input.argument_id, false));
  }
  const result = await runGraphRead(name, input);
  if (!result) return null;
  return JSON.stringify(result.ok ? result.payload : claimNotFoundError(input.claim_id));
}
