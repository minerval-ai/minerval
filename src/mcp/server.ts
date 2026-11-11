/**
 * Remote MCP server: the claim graph for MCP clients (#73).
 *
 * One McpServer instance is built per HTTP request (stateless streamable-HTTP
 * transport — see routes/mcp.ts) and closed when the response finishes. The
 * caller's resolved identity (RequestAuth, from the shared auth plugin) is
 * baked into the instance, so every tool call is attributed to a user.
 *
 * Tool tiers mirror the REST API's metering split (#70):
 *   - Free reads: search_claims, get_claim, get_decomposition, get_dependents
 *     — no LLM work.
 *   - Agentic (metered + quota-gated): match_claim, extract_claims,
 *     assess_text — these run the Matcher/Extractor, so each call passes the
 *     same rate-limit + monthly-grant gate as the REST agentic endpoints, and
 *     runs inside a usage context so the per-token meter attributes the spend.
 *   - Writes: submit_contribution — routes through the existing contribution
 *     pipeline (Contribution Reviewer + reputation rules, #71).
 *   - Feedback: raise_issue (#366) — the external agent's channel for
 *     reporting a failure or gap in THIS server's tools. Free, attributed,
 *     rate-limited; lands in agent_reports beside our own agents' reports.
 *   - Route tools: every other REST route an account can call, generated
 *     from the route and dispatched into it in-process (route-tools.ts),
 *     so MCP keeps parity with the REST API.
 */
import { z } from "zod";
import { mergedAliasRefusal, resolveClaimId } from "../services/claim-alias-service.js";
import type { FastifyInstance } from "fastify";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { getConstitution } from "../llm/prompts/constitution.js";
import {
  getCallerSkill,
  listCallerSkills,
  MCP_INSTRUCTIONS,
} from "./caller-skills.js";
import type { RequestAuth } from "../server/plugins/auth.js";
import {
  checkAgenticQuota,
  withAgenticCharge,
  type QuotaDecision,
} from "../server/plugins/quota.js";
import type { PricedOp } from "../services/owl.js";
import { runWithUsageContext, untraced } from "../llm/usage-context.js";
import { listTags, searchTags } from "../services/tag-service.js";
import { graphReadDefinitions, runGraphRead } from "../services/graph-read-service.js";
import { graphChangeDefinition, runGraphChanges } from "../services/graph-change-service.js";
import {
  getClaimById,
  listClaims,
} from "../services/claim-service.js";
import { getCurrentAssessment } from "../services/assessment-service.js";
import { getClaimTree } from "../services/tree-service.js";
import {
  getBountyTerms,
} from "../services/formalization-service.js";
import { matchClaim } from "../llm/agents/matcher.js";
import { extractClaims } from "../llm/agents/extractor.js";
import { inferDomainPrior } from "../llm/agents/domain-prior.js";
import { sanitizeDomains } from "../llm/agents/skill-selection.js";
import {
  createContribution,
  formatContribution,
  checkArgumentTarget,
  getContributionById,
  getReviewForContribution,
  withAnsweredRequest,
} from "../services/contribution-service.js";
import { getOrCreateContributor } from "../services/contributor-service.js";
import { checkContributionRateLimit } from "../services/reputation-service.js";
import { enqueueContribution } from "../services/queue-service.js";
import {
  CLAIM_ID_REQUIRED_MESSAGE,
  contributionMayOmitClaim,
  contributionTypeEnum,
  reportKindEnum,
  reportSeverityEnum,
} from "../schemas/common.js";
import {
  checkReportRateLimit,
  raiseIssue,
  REPORT_BODY_MAX_CHARS,
  REPORT_TITLE_MAX_CHARS,
} from "../services/report-service.js";
import { registerRouteTools } from "./route-tools.js";
import { normalizePageUrl, pageUrlHash } from "../services/page-url.js";
import { getRecordedPage } from "../services/recorded-page-service.js";
import { getSharedAnalysis } from "../services/shared-analysis-service.js";
import { REPORT_FIELD_GUIDANCE } from "../llm/tools/report-tools.js";
import {
  CLAIM_VIEW_DESCRIPTION,
  CLAIM_VIEW_INCLUDE_DESCRIPTION,
  CLAIM_VIEW_INCLUDES,
  DEFAULT_DEPENDENTS_PAGE,
  MAX_DEPENDENTS_PAGE,
  getClaimView,
} from "../services/claim-view-service.js";
import {
  ARGUMENT_VIEW_DESCRIPTION,
  ARGUMENT_VIEW_INCLUDE_DESCRIPTION,
  ARGUMENT_VIEW_INCLUDES,
  DEFAULT_INSTANCES_PAGE,
  MAX_INSTANCES_PAGE,
  getArgumentView,
} from "../services/argument-view-service.js";
import {
  getTextAnalysis,
  startTextAnalysis,
  type ReportProgress,
  type TextAnalysisType,
} from "../services/text-analysis-service.js";
import { nodeKindEnum, type NodeKind } from "../schemas/kinds.js";
import { getCurrentEstimate } from "../services/quantity-service.js";
import { getCurrentStanding } from "../services/question-service.js";

export interface McpRequestContext {
  auth: RequestAuth;
  requestId: string;
  /** The app whose REST routes become route tools; omitted, there are none. */
  app?: FastifyInstance;
}

// ---- helpers ----------------------------------------------------------------

function claimPageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(code: string, message: string, extra?: object): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: { code, message, ...extra } }) },
    ],
  };
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
    runId?: string | null;
  } | null
) {
  if (!a) return null;
  return {
    status: a.status,
    // Verdict confidence — how sure the Steward is of the status, not P(true).
    confidence: a.confidence,
    // Credence that the claim is true; null where one number would be false
    // precision (constitution §10).
    claim_credence: a.claimCredence ?? null,
    // Reader-facing body first; fall back to the trace for pre-split rows.
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    assessed_at: a.assessedAt.toISOString(),
    // The assessor behind the verdict (#294); null for legacy rows.
    model: a.model ?? null,
    // The run that wrote this verdict (GET /runs/:id); null when written
    // outside a traced run or before runs were linked.
    run_id: a.runId ?? null,
  };
}

/**
 * Gate + attribute an agentic (LLM-backed) tool call: enforce the shared
 * rate-limit/owl-price quota, charge the flat price as the work starts
 * (refunded if it throws — the user shouldn't pay for our failure), and run
 * the work inside a usage context so the metering chokepoint (llm/client.ts)
 * attributes every token to the calling account and key.
 *
 * The work runs untraced (#356): these tools analyze text the caller hands
 * over on demand — a draft, a memo, a passage from wherever they are reading
 * — which is theirs, not the graph's. Metering keeps counts and cost; no
 * transcript of the text is kept. Text meant to become provenance goes
 * through source submission, where the fetched document is public by
 * construction and its transcript is part of the record.
 */
async function agentic<T>(
  ctx: McpRequestContext,
  op: PricedOp,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; denied: CallToolResult }> {
  const toDenied = (decision: QuotaDecision): CallToolResult =>
    errorResult(
      decision.code!,
      decision.message!,
      decision.entitlement ? { entitlement: decision.entitlement } : undefined
    );

  const decision = await checkAgenticQuota(ctx.auth, op);
  if (!decision.allowed) return { ok: false, denied: toDenied(decision) };

  const run = await withAgenticCharge(ctx.auth, op, {}, () =>
    runWithUsageContext(
      {
        userId: ctx.auth.userId,
        apiKeyId: ctx.auth.apiKeyId,
        requestId: ctx.requestId,
      },
      () => untraced(fn)
    )
  );
  if (!run.ok) return { ok: false, denied: toDenied(run.denied) };
  return { ok: true, value: run.value };
}

/**
 * Start an agentic analysis in the background and answer at once with its
 * job id. The quota is checked before anything starts, so a denial is the
 * tool's answer; the charge is taken when the work starts, and settled to
 * the metered cost when it ends, as for a synchronous call.
 */
async function startAgentic(
  ctx: McpRequestContext,
  op: PricedOp,
  type: TextAnalysisType,
  params: Record<string, unknown>,
  work: (progress: ReportProgress) => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  const decision = await checkAgenticQuota(ctx.auth, op);
  if (!decision.allowed) {
    return errorResult(
      decision.code!,
      decision.message!,
      decision.entitlement ? { entitlement: decision.entitlement } : undefined
    );
  }
  const job = await startTextAnalysis(
    type,
    params,
    { userId: ctx.auth.userId ?? null, apiKeyId: ctx.auth.apiKeyId ?? null },
    async (progress) => {
      const run = await withAgenticCharge(ctx.auth, op, {}, () =>
        runWithUsageContext(
          {
            userId: ctx.auth.userId,
            apiKeyId: ctx.auth.apiKeyId,
            requestId: ctx.requestId,
          },
          () => untraced(() => work(progress))
        )
      );
      if (!run.ok) throw new Error(run.denied.message ?? "The charge for this analysis was refused");
      return run.value;
    }
  );
  return jsonResult({
    job_id: job.id,
    status: "processing",
    next:
      "The analysis runs in the background. Call get_text_analysis with this " +
      "job_id every 20-30 seconds until status is \"complete\" (the result is " +
      "there) or \"failed\" (error says why). Partial results appear as they " +
      "are ready.",
  });
}

/** Said in each background tool's description: how to get the result. */
const RUNS_IN_BACKGROUND =
  " Runs in the background: returns a job_id at once; read the result with " +
  "get_text_analysis (it takes from under a minute to several minutes, " +
  "growing with the text).";

/**
 * Match one assertion against the graph and shape the shared result.
 * `domains` are the Extractor's prior when the assertion came out of an
 * extraction; a bare assertion gets its prior made here, so the Matcher
 * carries the domain skills the claim calls for (#469).
 */
async function matchAssertion(
  assertion: string,
  context?: string,
  domains?: readonly string[],
  kind?: NodeKind,
  /**
   * The Extractor's proposed canonical form, when the assertion came out of
   * an extraction (#721): the Matcher's best search query. A bare assertion
   * is its own proposal.
   */
  proposedCanonical?: string
) {
  const decision = await matchClaim({
    extractedText: assertion,
    proposedCanonical: proposedCanonical?.trim() || assertion,
    context: context ?? null,
    // The kind of node proposed (§2, §7a): a figure is matched to the
    // quantity it is a value of, a question to the question it asks.
    kind,
    domains:
      domains ?? (await inferDomainPrior({ text: assertion, context: context ?? null })),
  });

  // No verdict (#419): `matched: null`, distinct from `false`. The Matcher
  // ran out of search budget; this says nothing about whether the claim
  // exists, so no canonical form is proposed.
  if (decision.outcome === "undecided") {
    return {
      matched: null,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    };
  }

  if (!decision.is_match || !decision.matched_claim_id) {
    return {
      matched: false as const,
      proposed_canonical_form: decision.new_canonical_form ?? assertion,
      // The Matcher may re-kind a new node (a question asking how much is a
      // quantity); otherwise it keeps the kind proposed.
      proposed_kind: decision.kind ?? kind ?? "claim",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    };
  }

  const claim = await getClaimById(decision.matched_claim_id);
  const nodeKind: NodeKind = nodeKindEnum.safeParse(claim?.kind).data ?? "claim";
  // Each kind has its own judgment: a proposition's assessment, a
  // quantity's estimate, a question's standing (§7a). Only the matched
  // kind's is read; the others are null.
  const [assessment, estimate, standing] = await Promise.all([
    claim && nodeKind === "claim" ? getCurrentAssessment(claim.id) : null,
    claim && nodeKind === "quantity" ? getCurrentEstimate(claim.id) : null,
    claim && nodeKind === "question" ? getCurrentStanding(claim.id) : null,
  ]);
  return {
    matched: true as const,
    claim: claim
      ? {
          id: claim.id,
          kind: nodeKind,
          canonical_form: claim.text,
          claim_type: claim.claimType,
          state: claim.state,
          importance: claim.importance,
          page_url: claimPageUrl(claim.id),
        }
      : { id: decision.matched_claim_id },
    // "affirms": the assertion states the canonical claim. "denies": it states
    // the negation, so the canonical assessment applies inverted. "poses": it
    // states the proposition as an open question and takes no side (#445).
    stance: decision.instance_stance,
    assessment: formatAssessment(assessment),
    estimate: estimate
      ? { ...estimate.estimate, assessed_at: estimate.assessed.assessed_at.toISOString() }
      : null,
    standing,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  };
}

// ---- server -----------------------------------------------------------------

export function buildMcpServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer(
    {
      name: "minerval",
      version: "0.1.0",
    },
    // The principles for callers, for clients that load no skills (#620).
    { instructions: MCP_INSTRUCTIONS }
  );

  // ---- free read tools ----

  // search_claims, get_decomposition and get_dependents, defined once with
  // the agents' (graph-read-service.ts, #726): the same inputs and payloads
  // on both sides, with a caller-facing description suffix. get_claim is
  // claim-view-service.ts's, below.
  for (const def of graphReadDefinitions("caller")) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.fromJSONSchema(
          def.input_schema as Parameters<typeof z.fromJSONSchema>[0]
        ) as z.ZodObject,
        annotations: { readOnlyHint: true },
      },
      async (args: Record<string, unknown>) => {
        const result = await runGraphRead(def.name, args);
        if (!result) return errorResult("NOT_FOUND", `No read named ${def.name}`);
        return result.ok ? jsonResult(result.payload) : errorResult(result.code, result.message);
      }
    );
  }

  // The change stream (#562, #563): the same definition and function the
  // graph's own Correspondents read, so one built outside Minerval sees
  // exactly what ours do.
  {
    const def = graphChangeDefinition("caller");
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: z.fromJSONSchema(
          def.input_schema as Parameters<typeof z.fromJSONSchema>[0]
        ) as z.ZodObject,
        annotations: { readOnlyHint: true },
      },
      async (args: Record<string, unknown>) => {
        const result = await runGraphChanges(args);
        return result.ok ? jsonResult(result.payload) : errorResult(result.code, result.message);
      }
    );
  }

  server.registerTool(
    "list_tags",
    {
      title: "List topic tags",
      description:
        "The graph's topic vocabulary: the tags claims carry, with how many " +
        "claims carry each. Tags say what a claim is ABOUT (a field, a " +
        "subject, an entity) — never whether it is true. With `query`, " +
        "ranks tags by meaning instead of by use, which is how to find the " +
        "slug for a topic before passing it to search_claims. Free.",
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("A topic to look for; omit for the most-used tags"),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      if (query?.trim()) {
        const hits = await searchTags(query, { limit: Math.min(50, limit) });
        return jsonResult({
          tags: hits.map((h) => ({
            slug: h.slug,
            name: h.name,
            description: h.description,
            claim_count: h.claim_count,
            similarity: h.similarity,
          })),
        });
      }
      const rows = await listTags({ limit });
      return jsonResult({
        tags: rows.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          claim_count: t.claim_count,
        })),
      });
    }
  );

  server.registerTool(
    "get_claim",
    {
      title: "Get claim",
      // One description and one view for MCP and the graph's own agents
      // (#774): src/services/claim-view-service.ts.
      description: CLAIM_VIEW_DESCRIPTION,
      inputSchema: {
        claim_id: z.guid(),
        include: z
          .array(z.enum(CLAIM_VIEW_INCLUDES))
          .default([])
          .describe(CLAIM_VIEW_INCLUDE_DESCRIPTION),
        dependents_limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPENDENTS_PAGE)
          .default(DEFAULT_DEPENDENTS_PAGE),
        dependents_offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ claim_id, include, dependents_limit, dependents_offset }) => {
      const view = await getClaimView(claim_id, {
        include,
        dependentsLimit: dependents_limit,
        dependentsOffset: dependents_offset,
      });
      if (!view) return errorResult("NOT_FOUND", "Claim not found");
      return jsonResult(view);
    }
  );

  server.registerTool(
    "get_argument",
    {
      title: "Get argument",
      // One description and one view for MCP and the graph's own agents
      // (#541): src/services/argument-view-service.ts.
      description: ARGUMENT_VIEW_DESCRIPTION,
      inputSchema: {
        argument_id: z.guid(),
        include: z
          .array(z.enum(ARGUMENT_VIEW_INCLUDES))
          .default([])
          .describe(ARGUMENT_VIEW_INCLUDE_DESCRIPTION),
        instances_limit: z.number().int().min(1).max(MAX_INSTANCES_PAGE).default(DEFAULT_INSTANCES_PAGE),
        instances_offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ argument_id, include, instances_limit, instances_offset }) => {
      const view = await getArgumentView(argument_id, {
        include,
        instancesLimit: instances_limit,
        instancesOffset: instances_offset,
      });
      if (!view) return errorResult("NOT_FOUND", "Argument not found");
      return jsonResult(view);
    }
  );

  server.registerTool(
    "get_bounty_terms",
    {
      title: "Get the terms of a claim's prize",
      description:
        "The machine-readable terms of the live prize on a claim, for an " +
        "outside solver: the amount and status, the formal statement it is " +
        "pinned to (id, namespace, source and expression hashes, the Lean " +
        "toolchain and Mathlib revision, and the URL of the statement file), " +
        "the axioms a proof may use, the static policy the checker applies, " +
        "the rules version in force, and whether claims are being accepted " +
        "now (the statement's review period must have ended). Offering a " +
        "prize does not change how the claim is assessed. Free.",
      inputSchema: { claim_id: z.guid() },
      annotations: { readOnlyHint: true },
    },
    async ({ claim_id }) => {
      const claim = await getClaimById(claim_id);
      if (!claim) return errorResult("NOT_FOUND", "Claim not found");
      const terms = await getBountyTerms(claim_id);
      if (!terms) {
        return errorResult("NO_BOUNTY", "No live prize is offered on this claim", {
          page_url: claimPageUrl(claim_id),
        });
      }
      return jsonResult({ ...terms, page_url: claimPageUrl(claim_id) });
    }
  );

  server.registerTool(
    "get_page_analysis",
    {
      title: "Get what the graph holds about a web page",
      description:
        "What the graph holds about a web page, by its URL (normalized and " +
        "hashed on the server). Two things, either or both: the analysis a " +
        "reader of the Minerval browser extension chose to share (the " +
        "claims the page makes, each matched into the graph with its stance " +
        "and a verdict on how the page words it), and `recorded`, the " +
        "passages the graph itself took from the page when it read it as a " +
        "source, each with its claim, quantity or question and no verdict " +
        "on the page. Statuses are read now. A page with neither is " +
        "NOT_SHARED, and assess_text on the page's text is the way to check " +
        "it. Free.",
      inputSchema: {
        url: z.string().url().max(4000).describe("The page's address"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      const normalized = normalizePageUrl(url);
      if (!normalized) return errorResult("NOT_A_PAGE", "Only an http or https page has a shared analysis");
      const hash = pageUrlHash(normalized);
      const [analysis, recorded] = await Promise.all([
        getSharedAnalysis(hash),
        getRecordedPage(hash),
      ]);
      if (!analysis && !recorded) {
        return errorResult(
          "NOT_SHARED",
          "No shared analysis of this page, and the graph has not read it as a source; assess_text on its text checks it"
        );
      }
      // A page only the graph read has no analysis, which is not the same
      // as an analysis that found nothing: it gets no annotations at all.
      return jsonResult({ ...(analysis ?? { url: normalized, shared: false }), recorded });
    }
  );

  // ---- agentic (metered) tools ----

  server.registerTool(
    "match_claim",
    {
      title: "Match an assertion to a canonical claim",
      description:
        "Ask Minerval's Matcher whether an assertion is already a claim in " +
        "the graph, under any wording or as its negation (a claim and its " +
        "denial are one node). On a match, returns the canonical claim, " +
        "its `stance` (affirms: the assertion states the claim; denies: it " +
        "states the negation, so read the assessment inverted; poses: it asks " +
        "the question and takes no side, so it makes no claim to check), and " +
        "its current assessment; otherwise, a proposed canonical form. A node is a " +
        "claim, a quantity, or a question (`kind`): pass `kind: \"quantity\"` " +
        "for a figure, matched to the quantity it is a value of, or " +
        "`\"question\"` for a question. A matched quantity carries its " +
        "`estimate` and a matched question its `standing` in place of an " +
        "assessment. Runs a model: metered to your account and quota-gated.",
      inputSchema: {
        assertion: z
          .string()
          .min(1)
          .max(2000)
          .describe("The assertion to check, as a single claim"),
        context: z
          .string()
          .max(2000)
          .optional()
          .describe("Optional surrounding text for disambiguation"),
        kind: nodeKindEnum
          .default("claim")
          .describe("The kind of node the assertion is: claim, quantity, or question"),
      },
    },
    async ({ assertion, context, kind }) => {
      const run = await agentic(ctx, "text_analysis", () =>
        matchAssertion(assertion, context, undefined, kind)
      );
      if (!run.ok) return run.denied;
      return jsonResult(run.value);
    }
  );

  server.registerTool(
    "extract_claims",
    {
      title: "Extract claims from text",
      description:
        "Run a passage through Minerval's Extractor to surface the claims it " +
        "asserts or relies on: single reusable propositions assessable with " +
        "evidence and reasons, each with a proposed canonical form, claim " +
        "type, kind (claim, quantity, or question; a quantity's canonical " +
        "form is its definition with its unit), and provisional importance. " +
        "Claims worth minting are scarce " +
        "relative to text, so most sentences yield none. Runs a model: metered to your " +
        "account and quota-gated. At most 100,000 characters and 50 claims per " +
        "call, so one call stays within the text_analysis charge; split longer text." +
        RUNS_IN_BACKGROUND +
        " While it runs, the result holds the claims recorded so far.",
      inputSchema: {
        text: z.string().min(1).max(100_000).describe("The text to extract from"),
        source_type: z
          .string()
          .max(100)
          .optional()
          .describe('Kind of text, e.g. "news_article", "documentation"'),
        max_claims: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ text, source_type, max_claims }) =>
      startAgentic(
        ctx,
        "text_analysis",
        "extract_claims",
        { text_chars: text.length, source_type: source_type ?? null, max_claims },
        async (progress) => ({
          claims: await extractClaims({
            content: text,
            sourceType: source_type,
            maxClaims: max_claims,
            // Each claim is readable as soon as the Extractor records it.
            onClaims: (claims) => {
              void progress({ claims }).catch(() => {
                // Progress is a view of the work; a missed write loses nothing.
              });
            },
          }),
        })
      )
  );

  server.registerTool(
    "assess_text",
    {
      title: "Assess a passage against the claim graph",
      description:
        "Fact-check a passage: extract its claims, match each to a canonical " +
        "claim, and report the graph's current assessment of each. Verdicts " +
        "come from assessments reached by direct examination of evidence, " +
        "with the reasoning included, never from a model's recollection. " +
        "Statuses run verified, supported, inconclusive, doubtful, " +
        "contradicted, unknown; 'unknown' is an assessed finding (the " +
        "evidence is insufficient to assess). 'not_in_graph' means the graph " +
        "holds no such claim, 'unassessed' that it exists but has no " +
        "assessment yet, and 'undecided' that the Matcher reached no verdict. " +
        "Each judgment's `stance` says whether the passage affirms, denies " +
        "(read the assessment inverted) or poses (asks, asserting nothing) " +
        "the claim. A figure is matched to the " +
        "quantity it is a value of ('estimated', with the graph's " +
        "`estimate`) and a question to the question it asks (its standing: " +
        "answered, leaning, open, ill_posed, or unknown). Runs a model: " +
        "metered to your account and quota-gated. At most 50,000 characters " +
        "and 20 judged claims per call, because each claim is a Matcher run " +
        "and one call must stay within the text_analysis charge; split a " +
        "longer document into passages." +
        RUNS_IN_BACKGROUND +
        " While it runs, the result holds the judgments made so far.",
      inputSchema: {
        text: z.string().min(1).max(50_000).describe("The passage to assess"),
        max_claims: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Cap on how many extracted claims to judge"),
      },
    },
    async ({ text, max_claims }) =>
      startAgentic(
        ctx,
        "text_analysis",
        "assess_text",
        { text_chars: text.length, max_claims },
        async (progress) => {
          const extracted = await extractClaims({
            content: text,
            sourceType: "assess_text",
            maxClaims: max_claims,
            // Each recorded claim is matched below from the same budget.
            matchMicroUsd: Math.round(loadConfig().matcherBudgetUsd * 1_000_000),
          });
          await progress({ claims_extracted: extracted.length, judgments: [] });
          const judgments = [];
          // Sequential on purpose: each match is its own tool-use loop, and a
          // passage's claims often overlap — bursting them in parallel just
          // races the same vector searches while multiplying peak LLM load.
          for (const c of extracted) {
            const kind = nodeKindEnum.safeParse(c.kind).data ?? "claim";
            const match = await matchAssertion(
              c.verbatim_text,
              c.context ?? undefined,
              sanitizeDomains(c.domains),
              kind,
              c.proposed_canonical_form
            );
            judgments.push({
              verbatim_text: c.verbatim_text,
              proposed_canonical_form: c.proposed_canonical_form,
              claim_type: c.claim_type,
              kind,
              // "not_in_graph": the graph has no canonical claim for this
              // assertion. Its own value, not "unknown", which is an assessed
              // status (insufficient evidence) and meant both until #752.
              // "undecided": the Matcher reached no verdict (#419).
              // "unassessed": it exists but has no current judgment yet.
              // A matched quantity is "estimated" (its `estimate` beside it),
              // a matched question its standing.
              verdict:
                match.matched === null
                  ? "undecided"
                  : !match.matched
                    ? "not_in_graph"
                    : match.claim.kind === "quantity"
                      ? match.estimate
                        ? "estimated"
                        : "unassessed"
                      : match.claim.kind === "question"
                        ? (match.standing ?? "unassessed")
                        : (match.assessment?.status ?? "unassessed"),
              ...match,
            });
            // Each judgment is readable as soon as it is made.
            await progress({ claims_extracted: extracted.length, judgments });
          }
          return { claims_extracted: extracted.length, judgments };
        }
      )
  );

  server.registerTool(
    "get_text_analysis",
    {
      title: "Get a text analysis's result",
      description:
        "Read an analysis started by extract_claims or assess_text. status is " +
        "\"processing\" while it runs (result holds what is ready so far: " +
        "for assess_text, the judgments made so far), \"complete\" with the " +
        "full result, or \"failed\" with an error. Only the account that " +
        "started an analysis can read it. Free.",
      inputSchema: {
        job_id: z.string().uuid().describe("The job_id the analysis tool returned"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => {
      const view = await getTextAnalysis(job_id, {
        userId: ctx.auth.userId ?? null,
        apiKeyId: ctx.auth.apiKeyId ?? null,
      });
      if (!view) return errorResult("NOT_FOUND", "No analysis of yours has that job_id");
      return jsonResult(view);
    }
  );

  // ---- writes ----

  server.registerTool(
    "submit_contribution",
    {
      title: "Submit a contribution",
      description:
        "Contribute to an existing node; contribution_type says what kind of " +
        "contribution it is. A request (propose_request) may bear on several " +
        "nodes, on sources, or on something the graph does not hold yet: omit " +
        "claim_id and say in content what it bears on. " +
        "A contribution gets a hearing, not " +
        "automatic admission: a reviewer evaluates it on its merits, the " +
        "exchange is recorded on the claim, and the graph changes only if " +
        "the contribution succeeds. Attributed to your account; returns a " +
        "contribution id for checking the outcome. Free, and so capped at " +
        `${loadConfig().contributionRateLimitPerHour} contributions per hour ` +
        `(${loadConfig().newContributorRateLimitPerHour} for accounts under a ` +
        "day old or below 50 reputation), because each one commands a " +
        "review nobody pays for; past it you get CONTRIBUTION_RATE_LIMITED. " +
        "Priced proposals (propose_claim, submit_source) do not count toward it.",
      inputSchema: {
        claim_id: z
          .guid()
          .optional()
          .describe("The node the contribution is about. Required for every type but propose_request."),
        contribution_type: contributionTypeEnum.describe(
          "challenge: dispute the claim or its assessment. support: evidence " +
            "or reasoning for it. add_instance: a source where it appears. " +
            "propose_argument: a named argument for or against it. " +
            "propose_merge (with merge_target_claim_id), propose_split, " +
            "propose_edit (usually with proposed_canonical_form). About one " +
            "of the node's arguments, with argument_id: add_instance (a " +
            "source that makes, attacks or mentions it), propose_split (it " +
            "carries several lines of reasoning), propose_merge (with " +
            "merge_target_argument_id: two arguments on the node are one). On a " +
            "quantity, add_estimate: a source's figure for it. On a question, " +
            "propose_answer: a candidate answer. On any node, propose_request: " +
            "work that would improve what the graph knows; answer_request: " +
            "material offered to meet one of its requests (with request_id)."
        ),
        content: z
          .string()
          .min(1)
          .max(10_000)
          .describe("The contribution itself, engaging what the node already records; cite ids, not pasted text"),
        evidence_urls: z.array(z.string().url()).max(20).default([]),
        merge_target_claim_id: z.guid().optional(),
        argument_id: z
          .guid()
          .optional()
          .describe(
            "One of the node's arguments (get_claim with include arguments lists them; get_argument opens one), " +
              "when the contribution is about it rather than the node."
          ),
        merge_target_argument_id: z
          .guid()
          .optional()
          .describe("propose_merge of two arguments on the node: the other argument."),
        proposed_canonical_form: z.string().max(2000).optional(),
        request_id: z
          .guid()
          .optional()
          .describe(
            "Required with answer_request, and only with it: the request the " +
              "material is offered for. It must bear on claim_id and be open " +
              "(get_claim lists the node's requests)."
          ),
      },
    },
    async (input) => {
      // Contributing requires a real contributor identity (#71): a key bound
      // to an account, or a session acting user — never anonymous.
      const externalId = ctx.auth.contributorExternalId;
      if (!externalId) {
        return errorResult(
          "NO_CONTRIBUTOR_IDENTITY",
          "This API key is not bound to a contributor identity; contributions must be attributable"
        );
      }

      // A propose_request may name no node (#724); every other type is
      // about one.
      if (!input.claim_id && !contributionMayOmitClaim(input.contribution_type)) {
        return errorResult("VALIDATION_ERROR", CLAIM_ID_REQUIRED_MESSAGE);
      }
      if (input.claim_id) {
        const claim = await getClaimById(input.claim_id);
        if (!claim) return errorResult("NOT_FOUND", "Claim not found");
      }
      // A contribution addressed to a merged node is refused and told the
      // survivor (#884), as POST /contributions refuses it.
      for (const id of [input.claim_id, input.merge_target_claim_id]) {
        const merged = await mergedAliasRefusal(id);
        if (merged) {
          return errorResult("CLAIM_MERGED", merged.message, { merged_into: merged.survivorId });
        }
      }

      const answered = await withAnsweredRequest({
        contributionType: input.contribution_type,
        claimId: input.claim_id,
        requestId: input.request_id,
        content: input.content,
      });
      if (!answered.ok) return errorResult(answered.code, answered.message);

      const argumentTarget = await checkArgumentTarget({
        type: input.contribution_type,
        claimId: input.claim_id ?? null,
        argumentId: input.argument_id,
        mergeTargetArgumentId: input.merge_target_argument_id,
        mergeTargetClaimId: input.merge_target_claim_id,
      });
      if (!argumentTarget.ok) return errorResult("ARGUMENT_TARGET", argumentTarget.message);

      const contributor = await getOrCreateContributor({
        externalId,
        displayName: externalId,
      });
      if (contributor.isSuspended) {
        return errorResult(
          "CONTRIBUTOR_SUSPENDED",
          `Contributor is suspended: ${contributor.suspensionReason ?? "No reason provided"}`
        );
      }

      // Good-faith-free / bad-faith-pay (#71), same gate as POST
      // /contributions: a suspected-bad-faith flag put this contributor in
      // must-pay standing, and the deposit rail doesn't exist yet.
      if (contributor.contributionStanding === "must_pay") {
        return errorResult(
          "DEPOSIT_REQUIRED",
          "A suspected bad-faith contribution moved this account to " +
            "pay-to-contribute standing. Deposits are not yet available; " +
            "the flag can be appealed with submit_appeal (REST: POST /appeals)."
        );
      }

      // Sybil / flood sandbox (#71): low-reputation and brand-new accounts
      // get a tighter hourly cap.
      const rate = checkContributionRateLimit(contributor);
      if (rate.limited) {
        return errorResult(
          "CONTRIBUTION_RATE_LIMITED",
          rate.sandboxed
            ? `New and low-reputation accounts are limited to ${rate.limitPerHour} contributions per hour; retry later`
            : `Contribution rate limit (${rate.limitPerHour}/hour) exceeded; retry later`
        );
      }

      const contribution = await createContribution({
        claimId: input.claim_id ?? null,
        contributorId: contributor.id,
        contributionType: input.contribution_type,
        content: answered.content,
        evidenceUrls: input.evidence_urls,
        mergeTargetClaimId: input.merge_target_claim_id,
        argumentId: argumentTarget.argumentId,
        mergeTargetArgumentId: argumentTarget.mergeTargetArgumentId,
        proposedCanonicalForm: input.proposed_canonical_form,
      });
      await enqueueContribution({ contributionId: contribution.id });

      return jsonResult({ contribution: formatContribution(contribution) });
    }
  );

  // ---- feedback ----

  server.registerTool(
    "raise_issue",
    {
      title: "Raise an issue about this server",
      description:
        "Report a problem with THIS SERVER or its tools, or a concrete idea " +
        "for improving it — never a judgment about a claim (that is what " +
        "submit_contribution is for). Use it when a tool errored or returned " +
        "something the docs say is impossible (system_failure); when the tool " +
        "you need does not exist, is misdescribed, or cannot express what you " +
        "need to say (tool_gap); or when working here showed you a specific, " +
        "actionable improvement to the graph or its machinery (improvement). " +
        "Reports go to the people who maintain the graph; they never affect a " +
        "claim, a contribution, or its review. Cite ids, never paste content. " +
        "Free and attributed to your account, and so limited to " +
        `${loadConfig().reportRateLimitPerHour} reports an hour, because each ` +
        "one takes maintainer attention nothing prices; past it you get " +
        "REPORT_RATE_LIMITED. Joining an existing report counts as one.",
      inputSchema: {
        // The agents' raise_issue explains each field (report-tools.ts);
        // callers get the same guidance, since repeats collapse by title.
        kind: reportKindEnum.describe(REPORT_FIELD_GUIDANCE.kind),
        severity: reportSeverityEnum.describe(REPORT_FIELD_GUIDANCE.severity),
        title: z.string().min(1).max(REPORT_TITLE_MAX_CHARS).describe(REPORT_FIELD_GUIDANCE.title),
        body: z.string().min(1).max(REPORT_BODY_MAX_CHARS).describe(REPORT_FIELD_GUIDANCE.body),
        surface: z.string().max(200).optional(),
        context_refs: z
          .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
          .optional(),
        joins: z
          .guid()
          .optional()
          .describe(
            "The id of a report on record that yours repeats (a related " +
              "report from an earlier raise): your body is added to it as a " +
              "sighting and nothing new is filed."
          ),
      },
    },
    async (input) => {
      // Same attribution rule as contributions: a report is cheap to file
      // and "the reviewer's tool is broken" is a convenient thing for a
      // rejected contributor's agent to claim, so every one names its filer.
      const externalId = ctx.auth.contributorExternalId;
      if (!externalId) {
        return errorResult(
          "NO_CONTRIBUTOR_IDENTITY",
          "This API key is not bound to a contributor identity; reports must be attributable"
        );
      }
      const contributor = await getOrCreateContributor({
        externalId,
        displayName: externalId,
      });
      if (contributor.isSuspended) {
        return errorResult(
          "CONTRIBUTOR_SUSPENDED",
          `Contributor is suspended: ${contributor.suspensionReason ?? "No reason provided"}`
        );
      }
      const rate = checkReportRateLimit(contributor.id);
      if (rate.limited) {
        return errorResult(
          "REPORT_RATE_LIMITED",
          `Report rate limit (${rate.limitPerHour}/hour) exceeded; retry later`
        );
      }

      const result = await raiseIssue({
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        surface: input.surface ?? null,
        contextRefs: input.context_refs ?? null,
        origin: "external",
        agent: "mcp",
        reporterContributorId: contributor.id,
        joins: input.joins ?? null,
      });
      if (!result.reportId) {
        return errorResult(
          "REPORT_NOT_RECORDED",
          result.problem ?? "The report could not be recorded; retry later"
        );
      }
      return jsonResult({
        report: {
          id: result.reportId,
          status: result.existing?.status ?? "new",
          occurrence_count: result.occurrenceCount,
          deduplicated: result.deduplicated,
        },
        // Reports on record that read like this one, as advice: if yours is
        // one of them, raise again with joins set to its id.
        related: (result.related ?? []).map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          occurrence_count: m.occurrence_count,
          last_seen_at: m.last_seen_at,
        })),
      });
    }
  );

  server.registerTool(
    "get_contribution_status",
    {
      title: "Get contribution review status",
      description:
        "Check the outcome of a submitted contribution: pending until " +
        "reviewed, then the decision (accept, reject, or escalate) with the " +
        "reviewer's reasoning and policy citations. An accepted proposal " +
        "carries became_claim_id and page_url, the node it became. Lost the " +
        "id? list_contributions with mine: true lists yours. Free.",
      inputSchema: { contribution_id: z.guid() },
      annotations: { readOnlyHint: true },
    },
    async ({ contribution_id }) => {
      const contribution = await getContributionById(contribution_id);
      if (!contribution) {
        return errorResult("NOT_FOUND", "Contribution not found");
      }
      const review = await getReviewForContribution(contribution_id);
      return jsonResult({
        // The same shape GET /contributions/:id serves (#723).
        contribution: formatContribution(contribution),
        review: review
          ? {
              decision: review.decision,
              reasoning: review.reasoning,
              confidence: review.confidence,
              policy_citations: review.policyCitations,
              reviewed_at: review.reviewedAt.toISOString(),
            }
          : null,
      });
    }
  );

  // ---- resources ----

  server.registerResource(
    "claim",
    new ResourceTemplate("claim://{claim_id}", { list: undefined }),
    {
      title: "Canonical claim",
      description:
        "One claim with its current assessment and decomposition tree, " +
        "suitable to attach as context.",
      mimeType: "application/json",
    },
    async (uri, { claim_id }) => {
      // A merged id resolves to its survivor (#884), as get_claim reads it.
      const resolution = await resolveClaimId(String(claim_id));
      if (!resolution) throw new Error(`Claim not found: ${String(claim_id)}`);
      const id = resolution.id;
      const claim = await getClaimById(id);
      if (!claim) throw new Error(`Claim not found: ${id}`);
      const [assessment, tree] = [
        await getCurrentAssessment(id),
        await getClaimTree(id),
      ];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                ...(resolution.resolvedFrom ? { resolved_from: resolution.resolvedFrom } : {}),
                claim: {
                  id: claim.id,
                  canonical_form: claim.text,
                  claim_type: claim.claimType,
                  state: claim.state,
                  importance: claim.importance,
                  page_url: claimPageUrl(claim.id),
                },
                assessment: formatAssessment(assessment),
                tree,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerResource(
    "recent-claims",
    "claims://recent",
    {
      title: "Recently updated claims",
      description:
        "The most recently updated claims: a live view of where the graph " +
        "is changing.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { results } = await listClaims({ limit: 30, assessed: "all" });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                results: results.map((r) => ({
                  ...r,
                  page_url: claimPageUrl(r.id),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // The constitution and the caller skills (#620): the same files the plugin
  // ships, for clients that load resources but not skills.
  server.registerResource(
    "constitution",
    "minerval://constitution",
    {
      title: "The Minerval constitution",
      description:
        "The constitution every Minerval administrator works under, " +
        "verbatim: what a claim is, how claims are assessed, what each " +
        "status means, how contributions are judged, and what funding can " +
        "and cannot buy. Read it before contributing or funding work.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: getConstitution() },
      ],
    })
  );

  server.registerResource(
    "caller-skill",
    new ResourceTemplate("minerval://skills/{name}", {
      list: async () => ({
        resources: listCallerSkills().map((s) => ({
          uri: `minerval://skills/${s.name}`,
          name: s.name,
          description: s.description,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Skills for using Minerval",
      description:
        "Agent Skills for callers of this server: checking and citing " +
        "claims, commissioning research in good faith, and a reader's " +
        "guide to the constitution (whose full text is " +
        "minerval://constitution).",
      mimeType: "text/markdown",
    },
    async (uri, { name }) => {
      const skill = getCallerSkill(String(name));
      if (!skill) throw new Error(`Skill not found: ${String(name)}`);
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: skill.text },
        ],
      };
    }
  );

  // ---- prompts ----

  server.registerPrompt(
    "fact_check_document",
    {
      title: "Fact-check a document against Minerval",
      description:
        "Check every disputable claim a document makes against the Minerval " +
        "claim graph and report what the graph's assessments establish.",
      argsSchema: {
        document: z.string().describe("The document text to fact-check"),
      },
    },
    ({ document }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Fact-check the following document against the Minerval claim graph.\n\n" +
              "Use the `assess_text` tool on the document. For each judged " +
              "claim, report the verdict the graph " +
              "returned, not your own recollection. `not_in_graph` means the " +
              "graph holds no canonical claim for that assertion; `unknown` " +
              "is an assessed status (the evidence is insufficient to " +
              "assess), a finding to report as such; " +
              "`undecided` means the Matcher reached no verdict (say so, do " +
              "not read it as unknown); " +
              "`unassessed` means the claim exists but has no assessment yet. " +
              "Watch the `stance` field: `denies` means the document asserts " +
              "the negation of the canonical claim, so invert the assessment " +
              "when judging the document's sentence, and `poses` means the " +
              "document asks the question without asserting either side. " +
              "assess_text takes at most 50,000 characters a call, so " +
              "split a longer document on section boundaries. Cite each claim's " +
              "`page_url`.\n\n" +
              "Document:\n\n" +
              document,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "check_assertion",
    {
      title: "Check a single assertion",
      description:
        "Check one assertion against the graph and explain its standing.",
      argsSchema: {
        assertion: z.string().describe("The assertion to check"),
      },
    },
    ({ assertion }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Check this assertion against the Minerval claim graph using the " +
              "`match_claim` tool, then explain its standing: the canonical " +
              "claim it maps to, if any, and the current assessment with its " +
              "confidence. Call `get_decomposition` if you need to show where " +
              "agreement ends and dispute begins. Report the graph's judgment, " +
              "not your own recollection, and link the claim's `page_url`.\n\n" +
              `Assertion: ${assertion}`,
          },
        },
      ],
    })
  );

  if (ctx.app) registerRouteTools(server, ctx.app, ctx.auth);

  return server;
}
