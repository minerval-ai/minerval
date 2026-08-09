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
import { getClaimById, getClaimInstances } from "../../services/claim-service.js";
import { getCurrentAssessment } from "../../services/assessment-service.js";
import { getArgumentsForClaim } from "../../services/argument-service.js";
import {
  getTransitiveDependents,
  getClaimTree,
  getSubclaimCount,
  listClaimDependents,
} from "../../services/tree-service.js";

/** Depth defaults shared with the MCP/REST surfaces: shallow unless asked. */
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
/** A hub claim must not dump hundreds of dependents into an agent's context. */
const DEFAULT_DEPENDENTS_LIMIT = 25;

export const GRAPH_READ_TOOL_NAMES = [
  "search_claims",
  "get_claim",
  "get_decomposition",
  "get_dependents",
] as const;

export function getGraphReadToolDefinitions(): Tool[] {
  return [
    {
      name: "search_claims",
      description:
        "Find claims by meaning. Combined semantic and keyword search over " +
        "the graph, ranked by similarity to your query — so a claim worded " +
        "differently from your search still surfaces. Each hit carries the " +
        "signals allocation turns on: importance, contestation, assessment " +
        "status, and how many days since it was assessed. A search aid, not " +
        "your scope: your scope is your mandate's words, and you judge what " +
        "falls under them.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What you are looking for." },
          limit: { type: "number", description: "Max results, default 15." },
        },
        required: ["query"],
      },
    },
    {
      name: "get_claim",
      description:
        "Open one claim in full: its canonical wording and its current " +
        "assessment WITH the reasoning behind the verdict, plus — via " +
        "`include` — the named arguments bearing on it, where it was seen in " +
        "the wild (provenance), and the claims that directly depend on it. " +
        "Use this when a scalar is not enough and you need to know why a " +
        "claim landed where it did.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: ["arguments", "provenance", "dependents"],
            },
            description:
              "Extra sections. Dependents are paginated and ranked by " +
              "importance; for the transitive picture use get_dependents.",
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_decomposition",
      description:
        "Walk DOWN: the tree of subclaims a claim rests on. Each edge is " +
        "typed (requires, supports, contradicts, …) and grouped into a named " +
        "argument where one exists, and each node carries its own assessment " +
        "status — so a disputed subclaim under a well-supported parent marks " +
        `exactly where the disagreement lives. Depth defaults to ${DEFAULT_TREE_DEPTH}; ` +
        "ask for more only when drilling into one claim, since every level " +
        "you request is context you pay for.",
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
        "sits. This is how you find what is LOAD-BEARING, which is not a " +
        "property of a claim on its own: a modest lemma carrying six " +
        "high-importance dependents deserves more attention than an isolated " +
        "claim that scores higher by itself. Answers 'what moves if this " +
        "verdict changes'.",
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

function formatAssessment(
  a: {
    status: string;
    confidence: number;
    claimCredence: number | null;
    summary: string | null;
    reasoningTrace: string;
    assessedAt: Date;
    model?: string | null;
  } | null
) {
  if (!a) return null;
  return {
    status: a.status,
    // Verdict confidence — how sure the Steward is of the status, not P(true).
    confidence: a.confidence,
    // Credence the claim is true; null where one number would be false
    // precision (constitution §10).
    claim_credence: a.claimCredence ?? null,
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    assessed_at: a.assessedAt.toISOString(),
    model: a.model ?? null,
  };
}

/**
 * The allocation signals `hybridSearch` doesn't project. Fetched in one
 * follow-up query keyed by the hit ids, so retrieval and ranking stay in
 * search-service.ts and this module only decorates the result.
 */
async function allocationSignals(
  ids: string[]
): Promise<
  Map<string, { contestation: number | null; steward_state: string | null; days_since_assessed: number | null }>
> {
  if (ids.length === 0) return new Map();
  const rows = await rawQuery<{
    id: string;
    contestation: number | null;
    steward_state: string | null;
    days_since_assessed: number | null;
  }>(
    `SELECT c.id, c.contestation, c.steward_state,
            CASE WHEN a.assessed_at IS NULL THEN NULL
                 ELSE FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at))
                            / 86400)::int END AS days_since_assessed
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
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
  if (name === "search_claims") {
    const limit = Math.min(30, Math.max(1, Number(input.limit ?? 15)));
    const { results } = await hybridSearch(String(input.query ?? ""), { limit });
    const signals = await allocationSignals(results.map((r) => r.id));
    return JSON.stringify({
      count: results.length,
      claims: results.map((r) => ({ ...r, ...(signals.get(r.id) ?? {}) })),
    });
  }

  if (name === "get_claim") {
    const claimId = String(input.claim_id ?? "");
    const claim = await getClaimById(claimId);
    if (!claim) return JSON.stringify({ error: "claim not found" });
    const include = Array.isArray(input.include) ? input.include.map(String) : [];
    const payload: Record<string, unknown> = {
      claim: {
        id: claim.id,
        canonical_form: claim.text,
        claim_type: claim.claimType,
        state: claim.state,
        decomposition_status: claim.decompositionStatus,
        importance: claim.importance,
      },
      assessment: formatAssessment(await getCurrentAssessment(claimId)),
      subclaim_count: await getSubclaimCount(claimId),
    };
    if (include.includes("arguments")) {
      payload.arguments = (await getArgumentsForClaim(claimId)).map((a) => ({
        id: a.id,
        name: a.name,
        stance: a.stance,
        content: a.content,
        evidence_urls: a.evidenceUrls,
      }));
    }
    if (include.includes("provenance")) {
      payload.instances = await getClaimInstances(claimId);
    }
    if (include.includes("dependents")) {
      // The paginated variant deliberately: a hub claim has hundreds.
      payload.dependents = await listClaimDependents(claimId, {
        limit: DEFAULT_DEPENDENTS_LIMIT,
      });
    }
    return JSON.stringify(payload);
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
