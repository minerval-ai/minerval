/**
 * The graph walks and search: one definition and one payload builder per
 * read, shared by the MCP server (src/mcp/server.ts, for outside callers) and
 * the agents' toolset (src/llm/tools/graph-read-tools.ts) (#726).
 *
 * get_claim was unified first, in claim-view-service.ts (#774). search_claims,
 * get_decomposition and get_dependents were still two implementations, and
 * they had drifted: callers lost `contestation` and `days_since_assessed`,
 * which their instructions say is reported, agents had none of MCP's filters,
 * and the two payloads named the same fields differently. Now each is defined
 * once. Where the audiences genuinely differ, the difference is named here: a
 * short description suffix (callers are told the read is free; agents what
 * allocation turns on).
 *
 * Inputs are JSON schema, which agents take as is and MCP converts to zod
 * (so an MCP call is validated before it runs). The builders also clamp and
 * default every input themselves, because an agent's input is not validated
 * before it arrives.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { hybridSearch } from "./search-service.js";
import { resolveClaimId } from "./claim-alias-service.js";
import { getClaimTree, getTransitiveDependents } from "./tree-service.js";
import { STEWARD_PARKED_DESCRIPTION } from "./steward-park-reason.js";
import { attachClaimTags, resolveTagBySlug } from "./tag-service.js";
import { claimTypeEnum } from "../schemas/common.js";
import { NODE_KINDS } from "../schemas/kinds.js";

/** Who is reading: an outside caller over MCP, or one of the graph's agents. */
export type GraphReadAudience = "caller" | "agent";

/** The reads defined here; get_claim is claim-view-service.ts's. */
export const SHARED_GRAPH_READ_NAMES = [
  "search_claims",
  "get_decomposition",
  "get_dependents",
] as const;
export type SharedGraphReadName = (typeof SHARED_GRAPH_READ_NAMES)[number];

/** Shallow unless asked: a deep tree is context the reader pays for. */
export const DEFAULT_TREE_DEPTH = 3;
export const MAX_TREE_DEPTH = 8;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/** z.guid()'s rule: any hex uuid, not only RFC versions. */
const ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const claimIdField = () => ({
  type: "string",
  pattern: ID_PATTERN,
  description: "The node's id, exactly as a result gave it",
});

export interface GraphReadDefinition {
  name: SharedGraphReadName;
  title: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

function claimPageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

// ---- definitions -------------------------------------------------------------

const FREE = " Free.";
/** The walks resolve a merged id as get_claim does (#884), which says in full what that means. */
const MERGED_ID_NOTE =
  " An id that was merged into another node walks from the survivor, and " +
  "`resolved_from` says so: where its `stance_relation` is `opposed`, the " +
  "survivor states the opposite of what your id stated (see get_claim).";

export function graphReadDefinitions(audience: GraphReadAudience): GraphReadDefinition[] {
  const caller = audience === "caller";
  return [
    {
      name: "search_claims",
      title: "Search claims",
      description:
        "Find nodes by meaning: claims, quantities and questions. A claim is " +
        "a single reusable proposition, stored once under a neutral canonical " +
        "wording shared by the claim and its denial; a quantity is a value the " +
        "graph estimates, and a question one it answers. Ranked by meaning and " +
        "keyword, so a node worded differently from your query still surfaces. " +
        "Each result carries its `kind`, importance, `contestation` (how " +
        "actively it is disputed, 0..1, kept apart from the status; null until " +
        "judged), its current judgment (`assessment_status` and " +
        "`assessment_confidence` on a claim, `standing` on a question, " +
        "`estimate` and `unit` on a quantity), `days_since_assessed`, the " +
        "amount of any live prize for a machine-checked proof or disproof of " +
        "its formal statement (`prize_micro_usd`) and whether such a check " +
        "exists (`checked`), its topic tags and its page_url." +
        (caller
          ? FREE
          : " Importance, contestation and how long since a node was judged " +
            "are the signals allocation turns on."),
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500, description: "What you are looking for" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
            description: `Most results to return, ${DEFAULT_SEARCH_LIMIT} by default`,
          },
          kind: { type: "string", enum: [...NODE_KINDS], description: "Only nodes of this kind" },
          tag: {
            type: "string",
            maxLength: 100,
            description:
              "Only nodes carrying this topic tag: a slug, as each result's tags give it" +
              (caller ? " or list_tags finds it" : "") +
              ". An unknown tag matches nothing.",
          },
          assessed: {
            type: "string",
            enum: ["all", "assessed", "unassessed"],
            default: "all",
            description: "Only nodes with (or without) a current judgment, each kind by its own",
          },
          min_importance: { type: "number", minimum: 0, maximum: 1, default: 0 },
          claim_type: {
            type: "string",
            enum: [...claimTypeEnum.options],
            description: "Only claims of this type; `mathematical` for propositions of mathematics",
          },
          with_prizes: {
            type: "boolean",
            default: false,
            description: "Only claims with a live prize on their formal statement",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_decomposition",
      title: "Get decomposition",
      description:
        "Walk DOWN: the tree of subclaims a claim rests on. Each edge is typed " +
        "(requires, supports, contradicts, and so on) and grouped into a named " +
        "argument where one exists, and each node carries its own assessment " +
        "status, so a disputed subclaim under a well-supported parent marks " +
        "where the disagreement lives. " +
        STEWARD_PARKED_DESCRIPTION +
        " For what rests ON a claim, use get_dependents." +
        MERGED_ID_NOTE +
        (caller ? FREE : ""),
      input_schema: {
        type: "object",
        properties: {
          claim_id: claimIdField(),
          max_depth: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TREE_DEPTH,
            default: DEFAULT_TREE_DEPTH,
            description: `Levels to walk down, ${DEFAULT_TREE_DEPTH} by default`,
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_dependents",
      title: "Get dependents",
      description:
        "Walk UP: everything that rests on a claim, directly or through a " +
        "chain, ranked by importance, with how many edges away each sits. It " +
        "answers 'what would move if this verdict changed'. Being load-bearing " +
        "is not the same as being important: a settled claim can carry much " +
        "and still need little attention (constitution §19). The mirror of " +
        "get_decomposition." +
        MERGED_ID_NOTE +
        (caller ? FREE : ""),
      input_schema: {
        type: "object",
        properties: {
          claim_id: claimIdField(),
          max_depth: {
            type: "integer",
            minimum: 1,
            maximum: MAX_TREE_DEPTH,
            default: DEFAULT_TREE_DEPTH,
            description: `Edges to walk upward, ${DEFAULT_TREE_DEPTH} by default; 1 is direct dependents only`,
          },
        },
        required: ["claim_id"],
      },
    },
  ];
}

// ---- builders ----------------------------------------------------------------

export type GraphReadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: "NOT_FOUND"; message: string };

const NOT_FOUND: GraphReadResult = { ok: false, code: "NOT_FOUND", message: "Claim not found" };

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

interface SearchSignals {
  contestation: number | null;
  steward_state: string | null;
  days_since_assessed: number | null;
}

/**
 * The signals hybridSearch does not project, read in one follow-up query by
 * the hit ids, so retrieval and ranking stay in search-service.ts. A
 * quantity's estimate and a question's standing live in their own tables
 * (`assessments` holds verdicts on propositions only), so recency reads
 * whichever one the node's kind keeps.
 */
async function searchSignals(ids: string[]): Promise<Map<string, SearchSignals>> {
  if (ids.length === 0) return new Map();
  const rows = await rawQuery<SearchSignals & { id: string }>(
    `SELECT c.id, c.contestation, c.steward_state,
            FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(a.assessed_at, qe.assessed_at, qa.assessed_at)))
                  / 86400)::int AS days_since_assessed
       FROM claims c
       LEFT JOIN assessments_in_force a ON a.claim_id = c.id
       LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = c.id
       LEFT JOIN question_assessments_in_force qa ON qa.claim_id = c.id
      WHERE c.id = ANY($1)`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function searchClaims(input: Record<string, unknown>): Promise<GraphReadResult> {
  const query = String(input.query ?? "");
  const tag = typeof input.tag === "string" ? input.tag.trim() : "";
  let tagId: string | undefined;
  if (tag) {
    const resolved = await resolveTagBySlug(tag);
    if (!resolved) return { ok: true, payload: { count: 0, results: [], note: `no tag "${tag}"` } };
    tagId = resolved.id;
  }
  const { results } = await hybridSearch(query, {
    limit: clampInt(input.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
    assessed: oneOf(input.assessed, ["all", "assessed", "unassessed"] as const) ?? "all",
    minImportance: Math.min(1, Math.max(0, Number(input.min_importance) || 0)),
    withPrizes: input.with_prizes === true,
    claimType: oneOf(input.claim_type, claimTypeEnum.options),
    tagId,
    kind: oneOf(input.kind, NODE_KINDS),
  });
  const [signals, tagged] = await Promise.all([
    // The signals decorate the hits, as tags do: their failure costs the
    // signals, never the search.
    searchSignals(results.map((r) => r.id)).catch((err) => {
      console.error(`[graph-read] search signals failed: ${err instanceof Error ? err.message : err}`);
      return new Map<string, SearchSignals>();
    }),
    attachClaimTags(results),
  ]);
  return {
    ok: true,
    payload: {
      count: results.length,
      results: tagged.map((r) => {
        const s = signals.get(r.id);
        return {
          id: r.id,
          kind: r.kind,
          canonical_form: r.text,
          claim_type: r.claim_type,
          state: r.state,
          similarity_score: r.similarity_score,
          importance: r.importance,
          contestation: s?.contestation ?? null,
          assessment_status: r.assessment_status,
          assessment_confidence: r.assessment_confidence,
          days_since_assessed: s?.days_since_assessed ?? null,
          steward_state: s?.steward_state ?? null,
          prize_micro_usd: r.prize_micro_usd ?? null,
          checked: r.checked ?? null,
          ...(r.kind === "question" ? { standing: r.standing ?? null } : {}),
          ...(r.kind === "quantity" ? { estimate: r.estimate ?? null, unit: r.unit ?? null } : {}),
          tags: r.tags.map((t) => ({ slug: t.slug, name: t.name })),
          page_url: claimPageUrl(r.id),
        };
      }),
    },
  };
}

async function walk(
  input: Record<string, unknown>,
  direction: "down" | "up"
): Promise<GraphReadResult> {
  // A merged id walks from its survivor (#884), as get_claim reads it.
  const resolution = await resolveClaimId(String(input.claim_id ?? ""));
  if (!resolution) return NOT_FOUND;
  const claimId = resolution.id;
  const depth = clampInt(input.max_depth, 1, MAX_TREE_DEPTH, DEFAULT_TREE_DEPTH);
  const base = {
    ...(resolution.resolvedFrom ? { resolved_from: resolution.resolvedFrom } : {}),
    claim_id: claimId,
    page_url: claimPageUrl(claimId),
  };
  return {
    ok: true,
    payload:
      direction === "down"
        ? { ...base, tree: await getClaimTree(claimId, depth) }
        : { ...base, ...(await getTransitiveDependents(claimId, depth)) },
  };
}

/**
 * Run one of these reads. Returns null when `name` is not one of them, so a
 * dispatcher can try these first and fall through.
 */
export async function runGraphRead(
  name: string,
  input: Record<string, unknown>
): Promise<GraphReadResult | null> {
  switch (name) {
    case "search_claims":
      return searchClaims(input);
    case "get_decomposition":
      return walk(input, "down");
    case "get_dependents":
      return walk(input, "up");
    default:
      return null;
  }
}
