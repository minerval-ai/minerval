/**
 * Graph reads for agents — the shared free-read toolset.
 *
 * These are the reads any agent reasoning ABOUT the graph needs: find claims,
 * open one in full, walk down into what it rests on, walk up into what rests on
 * it. They cost no LLM tokens of their own and touch no money, so every agent
 * gets the same four regardless of what else it is allowed to do.
 *
 * Why this module exists: the mandate agents (grantmaker, mandate-review) each
 * hand-rolled their own `search_claims` as a bare tsvector match ordered by
 * `importance` — lexical recall, and a sort by importance rather than by
 * relevance — while the MCP surface and the REST route both went through
 * `hybridSearch` (keyword OR semantic, ranked by cosine similarity). An
 * external MCP client could therefore search the graph better than the agent
 * allocating the platform's escrow. Retrieval lives in ONE place now, and
 * search-service.ts's own header already named "agent graph tools" as one of
 * its paths.
 *
 * `get_claim` and `get_decomposition` were MCP-only for the same reason —
 * nobody wired them to the agents — which left an allocator able to see that a
 * claim was contested and stale but unable to open it and find out why, or to
 * see which argument was load-bearing.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { rawQuery } from "../../db/client.js";
import { hybridSearch } from "../../services/search-service.js";
import { getClaimById } from "../../services/claim-service.js";
import {
  getTransitiveDependents,
  getClaimTree,
} from "../../services/tree-service.js";
import {
  attachClaimTags,
  resolveTagBySlug,
} from "../../services/tag-service.js";
import {
  CLAIM_VIEW_DESCRIPTION,
  CLAIM_VIEW_INCLUDE_DESCRIPTION,
  CLAIM_VIEW_INCLUDES,
  DEFAULT_DEPENDENTS_PAGE,
  MAX_DEPENDENTS_PAGE,
  getClaimView,
} from "../../services/claim-view-service.js";
import type { NodeKind } from "../../schemas/kinds.js";

/** Depth defaults shared with the MCP/REST surfaces: shallow unless asked. */
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;

export const GRAPH_READ_TOOL_NAMES = [
  "search_claims",
  "get_claim",
  "get_decomposition",
  "get_dependents",
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

function optionalNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return raw == null || !Number.isFinite(n) ? undefined : n;
}

export function getGraphReadToolDefinitions(): Tool[] {
  return [
    {
      name: "search_claims",
      description:
        "Find nodes by meaning: claims, quantities and questions alike. " +
        "Combined semantic and keyword search over the graph, ranked by " +
        "similarity to your query, so a node worded differently from your " +
        "search still surfaces. Each hit carries its `kind` and the signals " +
        "allocation turns on: importance, contestation, assessment status, " +
        "and how many days since it was assessed, plus its topic tags. " +
        "`assessment_status` and `assessment_confidence` are verdicts on " +
        "claims and read null on a quantity or a question; " +
        "`days_since_assessed` covers every kind (a quantity's estimate, a " +
        "question's standing).",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What you are looking for." },
          limit: { type: "number", description: "Max results, default 15." },
          tag: {
            type: "string",
            description:
              "Only claims carrying this topic tag (a slug, as returned on " +
              "each hit's `tags`). Narrows a broad query to one area of the " +
              "graph; an unknown tag matches nothing.",
          },
        },
        required: ["query"],
      },
    },
    getClaimToolDefinition(),
    {
      name: "get_decomposition",
      description:
        "Walk DOWN: the tree of subclaims a claim rests on. Each edge is " +
        "typed (requires, supports, contradicts, …) and grouped into a named " +
        "argument where one exists, and each node carries its own assessment " +
        "status.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          max_depth: {
            type: "number",
            description: `Levels to walk, ${DEFAULT_TREE_DEPTH} by default, ${MAX_TREE_DEPTH} at most.`,
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_dependents",
      description:
        "Walk UP: everything that rests on this claim, directly or through a " +
        "chain, ranked by importance and tagged with how many edges away it " +
        "sits.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          max_depth: {
            type: "number",
            description: `Levels to walk upward, ${DEFAULT_TREE_DEPTH} by default, ${MAX_TREE_DEPTH} at most.`,
          },
        },
        required: ["claim_id"],
      },
    },
  ];
}

function clampDepth(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TREE_DEPTH;
  return Math.min(MAX_TREE_DEPTH, Math.max(1, Math.floor(n)));
}

/**
 * The allocation signals `hybridSearch` doesn't project. Fetched in one
 * follow-up query keyed by the hit ids, so retrieval and ranking stay in
 * search-service.ts and this module only decorates the result.
 */
async function allocationSignals(
  ids: string[]
): Promise<
  Map<
    string,
    { kind: NodeKind; contestation: number | null; steward_state: string | null; days_since_assessed: number | null }
  >
> {
  if (ids.length === 0) return new Map();
  // A quantity's estimate and a question's standing live in their own
  // tables (`assessments` holds verdicts on propositions only), so recency
  // reads whichever one the node's kind keeps.
  const rows = await rawQuery<{
    id: string;
    kind: NodeKind;
    contestation: number | null;
    steward_state: string | null;
    days_since_assessed: number | null;
  }>(
    `SELECT c.id, c.kind, c.contestation, c.steward_state,
            FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(a.assessed_at, qe.assessed_at, qa.assessed_at)))
                  / 86400)::int AS days_since_assessed
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
       LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true
       LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true
      WHERE c.id = ANY($1)`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
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
      return JSON.stringify({
        error: "claim_id must be a full claim id (a uuid) exactly as a tool result gave it",
      });
    }
    throw err;
  }
}

async function executeGraphReadToolUnchecked(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (name === "search_claims") {
    const limit = Math.min(30, Math.max(1, Number(input.limit ?? 15)));
    let tagId: string | undefined;
    if (typeof input.tag === "string" && input.tag.trim()) {
      const tag = await resolveTagBySlug(input.tag);
      if (!tag) return JSON.stringify({ count: 0, claims: [], note: `no tag "${input.tag}"` });
      tagId = tag.id;
    }
    const { results } = await hybridSearch(String(input.query ?? ""), {
      limit,
      ...(tagId ? { tagId } : {}),
    });
    const [signals, tagged] = await Promise.all([
      allocationSignals(results.map((r) => r.id)),
      attachClaimTags(results),
    ]);
    return JSON.stringify({
      count: results.length,
      claims: tagged.map((r) => ({
        ...r,
        tags: r.tags.map((t) => t.slug),
        ...(signals.get(r.id) ?? {}),
      })),
    });
  }

  if (name === "get_claim") {
    const view = await getClaimView(String(input.claim_id ?? ""), {
      include: Array.isArray(input.include) ? input.include.map(String) : [],
      dependentsLimit: optionalNumber(input.dependents_limit),
      dependentsOffset: optionalNumber(input.dependents_offset),
    });
    return JSON.stringify(view ?? { error: "claim not found" });
  }

  if (name === "get_decomposition") {
    const claimId = String(input.claim_id ?? "");
    const claim = await getClaimById(claimId);
    if (!claim) return JSON.stringify({ error: "claim not found" });
    return JSON.stringify({
      claim_id: claimId,
      tree: await getClaimTree(claimId, clampDepth(input.max_depth)),
    });
  }

  if (name === "get_dependents") {
    const claimId = String(input.claim_id ?? "");
    const claim = await getClaimById(claimId);
    if (!claim) return JSON.stringify({ error: "claim not found" });
    return JSON.stringify({
      claim_id: claimId,
      ...(await getTransitiveDependents(claimId, clampDepth(input.max_depth))),
    });
  }

  return null;
}
