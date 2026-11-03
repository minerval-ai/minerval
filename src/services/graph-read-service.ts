/**
 * The graph reads: one definition and one payload builder per read, shared
 * by the MCP server (src/mcp/server.ts, for outside callers) and the agents'
 * toolset (src/llm/tools/graph-read-tools.ts) (#726).
 *
 * The two used to be separate implementations. graph-read-tools.ts was
 * written because the agents' reads had drifted from MCP's, and the two
 * drifted again: callers lost `contestation`, which their instructions say
 * is reported, agents had none of MCP's filters, both dropped the Steward's
 * evaluation of each argument, and the assessment formatter existed in three
 * copies. Now a read is defined once. Where the audiences genuinely differ,
 * the difference is named here: a short description suffix (callers are
 * told what is free; agents what allocation turns on), and get_claim's
 * formalization, where agents read the full record (pending versions, history,
 * checks) that a Grantmaker valuing formal work needs and callers read the
 * published statement and its badge.
 *
 * Inputs are JSON schema, which agents take as is and MCP converts to zod
 * (so an MCP call is validated before it runs). The builders also clamp and
 * default every input themselves, because an agent's input is not validated
 * before it arrives.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { hybridSearch } from "./search-service.js";
import { getClaimById, getClaimInstances } from "./claim-service.js";
import { getCurrentAssessment } from "./assessment-service.js";
import { getArgumentsForClaim, getEvaluationStateForClaim } from "./argument-service.js";
import {
  getClaimTree,
  getSubclaimCount,
  getTransitiveDependents,
  listClaimDependents,
} from "./tree-service.js";
import { attachClaimTags, getTagsForSubject, resolveTagBySlug } from "./tag-service.js";
import {
  getClaimFormalizationRecord,
  getFormalizationSummary,
  getVerificationSummary,
  leanChecksByArgument,
  listLeanChecksForClaim,
} from "./formalization-service.js";
import { getQuantityDetail, getThresholdOf } from "./quantity-service.js";
import { getQuestionDetail } from "./question-service.js";
import { listRequests } from "./request-service.js";
import { getClaimSourceMap } from "./source-map-service.js";
import { claimTypeEnum } from "../schemas/common.js";
import { NODE_KINDS, type NodeKind } from "../schemas/kinds.js";

/** Who is reading: an outside caller over MCP, or one of the graph's agents. */
export type GraphReadAudience = "caller" | "agent";

export const GRAPH_READ_TOOL_NAMES = [
  "search_claims",
  "get_claim",
  "get_decomposition",
  "get_dependents",
] as const;
export type GraphReadToolName = (typeof GRAPH_READ_TOOL_NAMES)[number];

/** Shallow unless asked: a deep tree is context the reader pays for. */
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
/** A hub claim has hundreds of dependents; they come back a page at a time. */
const DEFAULT_DEPENDENTS_LIMIT = 25;
const MAX_DEPENDENTS_LIMIT = 100;
/**
 * The requests get_claim shows inline: a tool result is context the reader
 * carries for the rest of its run. The rest are a list_requests call away,
 * and requests_total says when there are more.
 */
export const GET_CLAIM_REQUESTS_LIMIT = 20;

/** z.guid()'s rule: any hex uuid, not only RFC versions. */
const ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const claimIdField = (description = "The node's id, exactly as a result gave it") => ({
  type: "string",
  pattern: ID_PATTERN,
  description,
});

export interface GraphReadDefinition {
  name: GraphReadToolName;
  title: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ---- formatting --------------------------------------------------------------

export function claimPageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

/**
 * A claim's current assessment as every surface reports it. The REST route
 * adds the row id and the subclaim summary (routes/claims.ts).
 */
export function formatAssessment(
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
    // Verdict confidence: how sure the Steward is of the status, not P(true).
    confidence: a.confidence,
    // Credence that the claim is true; null where one number would be false
    // precision (constitution §10).
    claim_credence: a.claimCredence ?? null,
    // Reader-facing body first; fall back to the trace for rows written
    // before the summary/reasoning split.
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    assessed_at: a.assessedAt.toISOString(),
    // The assessor behind the verdict (#294); null for legacy rows.
    model: a.model ?? null,
  };
}

/**
 * The named arguments on a claim with the Steward's current evaluation of
 * each (§7): `verdict` rates the inference (how far the conclusion follows
 * if the premises hold), `decisive` says whether it settles the claim as its
 * premises now stand, `evaluation` names the premises it lives or dies on.
 * An unnamed or not yet evaluated argument reads null on all three.
 */
export async function formatArguments(claimId: string) {
  const [args, evaluations, checks] = await Promise.all([
    getArgumentsForClaim(claimId),
    getEvaluationStateForClaim(claimId),
    // The checker record behind a machine-checked argument; its absence
    // loses the badge, never the arguments.
    leanChecksByArgument(claimId).catch(() => new Map<string, unknown>()),
  ]);
  const byArgument = new Map(evaluations.map((e) => [e.argument_id, e]));
  return args.map((a) => {
    const e = byArgument.get(a.id);
    return {
      id: a.id,
      name: a.name,
      stance: a.stance,
      content: a.content,
      evidence_urls: a.evidenceUrls,
      verdict: e?.verdict ?? null,
      decisive: e?.decisive ?? null,
      evaluation: e?.content ?? null,
      // What an argument about a quantity shows about its value (§7).
      shows: a.shows ?? null,
      lean_check: checks.get(a.id) ?? null,
    };
  });
}

// ---- definitions -------------------------------------------------------------

const FREE = " Free.";

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
        "`estimate` and `unit` on a quantity), `days_since_assessed`, its topic " +
        "tags and its page_url." +
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
            description:
              "Only claims with a live prize for a machine-checked proof or disproof " +
              "of their formal statement. Every result says the prize's amount " +
              "(`prize_micro_usd`) and whether such a check exists (`checked`: proof, " +
              "disproof, or null).",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_claim",
      title: "Get claim",
      description:
        "Open one node in full: its canonical form and current judgment, and, " +
        "via `include`, its provenance, the named arguments bearing on it, and " +
        "the nodes that depend on it. A node is a claim, a quantity or a " +
        "question (`claim.kind`). A claim's `assessment` is a verdict reached by " +
        "direct examination of the evidence, with the reasoning: a status " +
        "(verified, supported, inconclusive, doubtful, contradicted, or unknown), " +
        "a confidence that the status is the right reading of the evidence, and " +
        "a credence that the claim is true where one number is an honest summary " +
        "(null where it would be false precision). How actively a claim is " +
        "disputed is not a status: it is `contestation` (0..1, null until " +
        "judged). A quantity has no assessment but a `quantity` record (its " +
        "definition and the graph's estimate with its work), and a question a " +
        "`question` record (its standing and candidate answers). Each argument " +
        "carries the Steward's evaluation: `verdict` rates the inference, how " +
        "far the conclusion follows if the premises hold (certain, likely, " +
        "slight, none), not whether the conclusion is true; `decisive` is true " +
        "when the argument settles the claim as its premises now stand; " +
        "`evaluation` names the premises it lives or dies on. A claim that cuts " +
        "a quantity carries `threshold_of`. `requests` is the work that would " +
        `improve what the graph knows about the node (up to ${GET_CLAIM_REQUESTS_LIMIT}, ` +
        "with `requests_total`)." +
        (caller
          ? " A mathematical claim may carry `formalization` and `verification` " +
            '(Lean 4; `include: "proofs"` lists the check records).' +
            FREE
          : " A mathematical claim carries its formalization record: " +
            "`formalization`, `formalization_pending`, `formalization_history`, " +
            "`verification` and `lean_checks`."),
      input_schema: {
        type: "object",
        properties: {
          claim_id: claimIdField(),
          include: {
            type: "array",
            items: { type: "string", enum: ["provenance", "arguments", "dependents", "proofs"] },
            default: caller ? ["provenance"] : [],
            description:
              "Sections to add. provenance: the source instances, each with the " +
              "Steward's reading of its source, and the account of what the " +
              "support rests on. arguments: the named arguments with their " +
              "evaluations. dependents: the nodes resting on this one. proofs: " +
              "every Lean check run on the claim's statement.",
          },
          dependents_limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_DEPENDENTS_LIMIT,
            default: DEFAULT_DEPENDENTS_LIMIT,
            description:
              "Dependents come back the most important first, with " +
              "`dependents_total`; a hub claim has hundreds",
          },
          dependents_offset: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Page through dependents past the first",
          },
        },
        required: ["claim_id"],
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
        "where the disagreement lives. For what rests ON a claim, use " +
        "get_dependents." +
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

/**
 * The signals hybridSearch does not project, read in one follow-up query by
 * the hit ids, so retrieval and ranking stay in search-service.ts. A
 * quantity's estimate and a question's standing live in their own tables
 * (`assessments` holds verdicts on propositions only), so recency reads
 * whichever one the node's kind keeps.
 */
async function searchSignals(ids: string[]) {
  if (ids.length === 0) return new Map<string, SearchSignals>();
  const rows = await rawQuery<SearchSignals & { id: string }>(
    `SELECT c.id, c.contestation, c.steward_state,
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

interface SearchSignals {
  contestation: number | null;
  steward_state: string | null;
  days_since_assessed: number | null;
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

async function getClaim(
  input: Record<string, unknown>,
  audience: GraphReadAudience
): Promise<GraphReadResult> {
  const claimId = String(input.claim_id ?? "");
  const claim = await getClaimById(claimId);
  if (!claim) return NOT_FOUND;
  const include = new Set(
    Array.isArray(input.include)
      ? input.include.map(String)
      : audience === "caller"
        ? ["provenance"]
        : []
  );
  const kind: NodeKind = oneOf(claim.kind, NODE_KINDS) ?? "claim";

  const [assessment, formalization, quantity, thresholdOf, question, requests, tags, subclaimCount] =
    await Promise.all([
      getCurrentAssessment(claimId),
      audience === "agent"
        ? // The full record (#435): a Grantmaker valuing attempt_proof reads
          // the published statement for fidelity, and one valuing formalize
          // must see whether an earlier run left a draft or a retirement.
          getClaimFormalizationRecord(claimId)
        : Promise.all([getFormalizationSummary(claimId), getVerificationSummary(claimId)]).then(
            ([f, v]) => ({ formalization: f, verification: v })
          ),
      kind === "quantity" ? getQuantityDetail(claimId) : null,
      kind === "claim" ? getThresholdOf(claimId) : null,
      kind === "question" ? getQuestionDetail(claimId) : null,
      // Requests and tags degrade to none rather than failing the read.
      listRequests({ claimId, limit: GET_CLAIM_REQUESTS_LIMIT }).catch(() => ({ items: [], total: 0 })),
      getTagsForSubject("claim", claimId).catch(() => []),
      getSubclaimCount(claimId),
    ]);

  const payload: Record<string, unknown> = {
    claim: {
      id: claim.id,
      kind,
      canonical_form: claim.text,
      claim_type: claim.claimType,
      state: claim.state,
      decomposition_status: claim.decompositionStatus,
      importance: claim.importance,
      // How actively the claim is disputed or consulted (0..1), kept apart
      // from the status (#524). null = not yet judged.
      contestation: claim.contestation ?? null,
      domains: claim.domains,
      tags: tags.map((t) => ({ slug: t.slug, name: t.name })),
      created_at: claim.createdAt?.toISOString() ?? null,
      updated_at: claim.updatedAt?.toISOString() ?? null,
      page_url: claimPageUrl(claim.id),
    },
    // Verdicts are on propositions only: a quantity's judgment is its
    // estimate (in `quantity`), a question's its standing (in `question`).
    assessment: formatAssessment(assessment),
    ...formalization,
    quantity:
      quantity && audience === "agent"
        ? // The estimate and its basis, with the stated figures counted
          // rather than listed: an allocator values work on the quantity.
          {
            definition: quantity.definition,
            current_estimate: quantity.estimate,
            estimated: quantity.assessed,
            stated_estimates: quantity.estimates.length,
            readings: quantity.readings,
            cuts: quantity.cuts,
          }
        : quantity,
    threshold_of: thresholdOf,
    question,
    requests: requests.items,
    requests_total: requests.total,
    subclaim_count: subclaimCount,
  };

  if (include.has("provenance")) {
    // The instances, each with the reading recorded from opening its source
    // against the claim (#286), and the claim's source map where one has
    // been written: the account of what the support rests on.
    const [instances, sourceMap] = await Promise.all([
      getClaimInstances(claimId),
      getClaimSourceMap(claimId).catch(() => null),
    ]);
    payload.instances = instances.map((inst) => ({
      ...inst,
      reading: sourceMap?.readings[inst.id] ?? null,
    }));
    payload.source_map = sourceMap?.map ?? null;
    payload.provenance_edges = sourceMap?.edges ?? [];
    payload.source_relationships = sourceMap?.source_relationships ?? [];
  }
  if (include.has("arguments")) payload.arguments = await formatArguments(claimId);
  if (include.has("proofs")) {
    // Every check run on any version of the statement: verdict, mode, kind,
    // gate, pin and hash, never the source.
    payload.proofs = await listLeanChecksForClaim(claimId);
  }
  if (include.has("dependents")) {
    const { dependents, total } = await listClaimDependents(claimId, {
      limit: clampInt(input.dependents_limit, 1, MAX_DEPENDENTS_LIMIT, DEFAULT_DEPENDENTS_LIMIT),
      offset: clampInt(input.dependents_offset, 0, Number.MAX_SAFE_INTEGER, 0),
    });
    payload.dependents = dependents;
    payload.dependents_total = total;
  }
  return { ok: true, payload };
}

async function walk(
  input: Record<string, unknown>,
  direction: "down" | "up"
): Promise<GraphReadResult> {
  const claimId = String(input.claim_id ?? "");
  const claim = await getClaimById(claimId);
  if (!claim) return NOT_FOUND;
  const depth = clampInt(input.max_depth, 1, MAX_TREE_DEPTH, DEFAULT_TREE_DEPTH);
  const base = { claim_id: claimId, page_url: claimPageUrl(claimId) };
  return {
    ok: true,
    payload:
      direction === "down"
        ? { ...base, tree: await getClaimTree(claimId, depth) }
        : { ...base, ...(await getTransitiveDependents(claimId, depth)) },
  };
}

/**
 * Run one graph read for an audience. Returns null when `name` is not a
 * graph read, so a dispatcher can try these first and fall through.
 */
export async function runGraphRead(
  name: string,
  input: Record<string, unknown>,
  audience: GraphReadAudience
): Promise<GraphReadResult | null> {
  switch (name) {
    case "search_claims":
      return searchClaims(input);
    case "get_claim":
      return getClaim(input, audience);
    case "get_decomposition":
      return walk(input, "down");
    case "get_dependents":
      return walk(input, "up");
    default:
      return null;
  }
}
