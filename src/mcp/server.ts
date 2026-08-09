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
 */
import { z } from "zod";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import type { RequestAuth } from "../server/plugins/auth.js";
import {
  checkAgenticQuota,
  withAgenticCharge,
  type QuotaDecision,
} from "../server/plugins/quota.js";
import type { PricedOp } from "../services/owl.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import { hybridSearch } from "../services/search-service.js";
import {
  getClaimById,
  getClaimInstances,
  listClaims,
} from "../services/claim-service.js";
import { getCurrentAssessment } from "../services/assessment-service.js";
import {
  getClaimTree,
  getSubclaimCount,
  getTransitiveDependents,
  listClaimDependents,
} from "../services/tree-service.js";
import { getArgumentsForClaim } from "../services/argument-service.js";
import { matchClaim } from "../llm/agents/matcher.js";
import { extractClaims } from "../llm/agents/extractor.js";
import {
  createContribution,
  getContributionById,
  getReviewForContribution,
} from "../services/contribution-service.js";
import { getOrCreateContributor } from "../services/contributor-service.js";
import { checkContributionRateLimit } from "../services/reputation-service.js";
import { enqueueContribution } from "../services/queue-service.js";
import { contributionTypeEnum } from "../schemas/common.js";

export interface McpRequestContext {
  auth: RequestAuth;
  requestId: string;
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
  };
}

/**
 * Gate + attribute an agentic (LLM-backed) tool call: enforce the shared
 * rate-limit/owl-price quota, charge the flat price as the work starts
 * (refunded if it throws — the user shouldn't pay for our failure), and run
 * the work inside a usage context so the metering chokepoint (llm/client.ts)
 * attributes every token to the calling account and key.
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
      fn
    )
  );
  if (!run.ok) return { ok: false, denied: toDenied(run.denied) };
  return { ok: true, value: run.value };
}

/** Match one assertion against the graph and shape the shared result. */
async function matchAssertion(assertion: string, context?: string) {
  const decision = await matchClaim({
    extractedText: context ? `${assertion}\n\nContext: ${context}` : assertion,
    proposedCanonical: assertion,
  });

  if (!decision.is_match || !decision.matched_claim_id) {
    return {
      matched: false as const,
      proposed_canonical_form: decision.new_canonical_form ?? assertion,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    };
  }

  const claim = await getClaimById(decision.matched_claim_id);
  const assessment = claim ? await getCurrentAssessment(claim.id) : null;
  return {
    matched: true as const,
    claim: claim
      ? {
          id: claim.id,
          canonical_form: claim.text,
          claim_type: claim.claimType,
          state: claim.state,
          importance: claim.importance,
          page_url: claimPageUrl(claim.id),
        }
      : { id: decision.matched_claim_id },
    // "affirms": the assertion states the canonical claim. "denies": it states
    // the negation, so the canonical assessment applies inverted.
    stance: decision.instance_stance,
    assessment: formatAssessment(assessment),
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  };
}

// ---- server -----------------------------------------------------------------

export function buildMcpServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer({
    name: "minerval",
    version: "0.1.0",
  });

  // ---- free read tools ----

  server.registerTool(
    "search_claims",
    {
      title: "Search claims",
      description:
        "Search Minerval's claim graph. A claim is a single reusable " +
        "proposition about the world that informed people could dispute with " +
        "evidence or reasons; each is stored once, under a neutral canonical " +
        "wording shared by the claim and its denial. Combined semantic and " +
        "keyword search, ranked by similarity; each result carries its " +
        "current assessment status and a link to its minerval.ai page. " +
        "Free.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Free-text search query"),
        limit: z.number().int().min(1).max(50).default(10),
        assessed: z
          .enum(["all", "assessed", "unassessed"])
          .default("all")
          .describe("Filter on whether a claim carries a current assessment"),
        min_importance: z.number().min(0).max(1).default(0),
      },
    },
    async ({ query, limit, assessed, min_importance }) => {
      const { results } = await hybridSearch(query, {
        limit,
        assessed,
        minImportance: min_importance,
      });
      return jsonResult({
        results: results.map((r) => ({
          id: r.id,
          canonical_form: r.text,
          claim_type: r.claim_type,
          state: r.state,
          similarity_score: r.similarity_score,
          importance: r.importance,
          assessment_status: r.assessment_status,
          assessment_confidence: r.assessment_confidence,
          page_url: claimPageUrl(r.id),
        })),
      });
    }
  );

  server.registerTool(
    "get_claim",
    {
      title: "Get claim",
      description:
        "Fetch one claim in full: canonical form, current assessment, and, " +
        "via `include`, its source instances (provenance), the named " +
        "arguments bearing on it, and the claims that depend on it. An " +
        "assessment is a verdict reached by direct examination of the " +
        "evidence, with the reasoning included: a status (verified, " +
        "supported, contested, unsupported, contradicted, or unknown), a " +
        "confidence that the status is the right reading of the evidence, " +
        "and a credence that the claim is true where a single number is an " +
        "honest summary (null where it would be false precision). " +
        "Dependents come back as the most load-bearing page by importance " +
        "with `dependents_total` beside them, since a hub claim has " +
        "hundreds; page through the rest with `dependents_offset`. Free.",
      inputSchema: {
        claim_id: z.string().uuid(),
        include: z
          .array(z.enum(["provenance", "arguments", "dependents"]))
          .default(["provenance"])
          .describe("Optional detail sections to include"),
        dependents_limit: z.number().int().min(1).max(100).default(25),
        dependents_offset: z.number().int().min(0).default(0),
      },
    },
    async ({ claim_id, include, dependents_limit, dependents_offset }) => {
      const claim = await getClaimById(claim_id);
      if (!claim) return errorResult("NOT_FOUND", "Claim not found");

      const assessment = await getCurrentAssessment(claim_id);
      const payload: Record<string, unknown> = {
        claim: {
          id: claim.id,
          canonical_form: claim.text,
          claim_type: claim.claimType,
          state: claim.state,
          decomposition_status: claim.decompositionStatus,
          importance: claim.importance,
          created_at: claim.createdAt.toISOString(),
          updated_at: claim.updatedAt.toISOString(),
          page_url: claimPageUrl(claim.id),
        },
        assessment: formatAssessment(assessment),
        subclaim_count: await getSubclaimCount(claim_id),
      };
      if (include.includes("provenance")) {
        payload.instances = await getClaimInstances(claim_id);
      }
      if (include.includes("arguments")) {
        const args = await getArgumentsForClaim(claim_id);
        payload.arguments = args.map((a) => ({
          id: a.id,
          name: a.name,
          stance: a.stance,
          content: a.content,
          evidence_urls: a.evidenceUrls,
        }));
      }
      if (include.includes("dependents")) {
        // Paginated: an unbounded list let one hub claim push hundreds of rows
        // at a client. `dependents` stays an array so existing callers keep
        // iterating it; the count they were previously deriving from its
        // length now lives in `dependents_total`.
        const { dependents, total } = await listClaimDependents(claim_id, {
          limit: dependents_limit,
          offset: dependents_offset,
        });
        payload.dependents = dependents;
        payload.dependents_total = total;
      }
      return jsonResult(payload);
    }
  );

  server.registerTool(
    "get_decomposition",
    {
      title: "Get decomposition",
      description:
        "Fetch the tree of subclaims a claim rests on. Each edge is typed " +
        "(requires, supports, contradicts, and so on) and grouped into a " +
        "named argument where one exists; each node carries its own " +
        "assessment status, so a disputed subclaim under a well-supported " +
        "parent marks exactly where the disagreement lives. Descends only: " +
        "for what rests ON this claim, use get_dependents. Free.",
      inputSchema: {
        claim_id: z.string().uuid(),
        max_depth: z.number().int().min(1).max(8).default(3),
      },
    },
    async ({ claim_id, max_depth }) => {
      const claim = await getClaimById(claim_id);
      if (!claim) return errorResult("NOT_FOUND", "Claim not found");
      const tree = await getClaimTree(claim_id, max_depth);
      return jsonResult({
        claim_id,
        page_url: claimPageUrl(claim_id),
        tree,
      });
    }
  );

  server.registerTool(
    "get_dependents",
    {
      title: "Get dependents",
      description:
        "Walk UP from a claim: everything that rests on it, directly or " +
        "through a chain, ranked by importance and tagged with how many " +
        "edges away it sits. This is what shows whether a claim is " +
        "LOAD-BEARING, which is not readable off the claim itself — a modest " +
        "lemma carrying six high-importance dependents matters more than an " +
        "isolated claim that scores higher alone. The mirror of " +
        "get_decomposition, and the question 'what would move if this " +
        "verdict changed'. Free.",
      inputSchema: {
        claim_id: z.string().uuid(),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(8)
          .default(3)
          .describe("Edges to walk upward; 1 is direct dependents only."),
      },
    },
    async ({ claim_id, max_depth }) => {
      const claim = await getClaimById(claim_id);
      if (!claim) return errorResult("NOT_FOUND", "Claim not found");
      const walk = await getTransitiveDependents(claim_id, max_depth);
      return jsonResult({
        claim_id,
        page_url: claimPageUrl(claim_id),
        ...walk,
      });
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
        "whether the assertion affirms or denies it, and its current " +
        "assessment; otherwise, a proposed canonical form. Runs a model: " +
        "metered to your account and quota-gated.",
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
      },
    },
    async ({ assertion, context }) => {
      const run = await agentic(ctx, "text_analysis", () =>
        matchAssertion(assertion, context)
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
        "asserts or relies on: single reusable propositions that informed " +
        "people could dispute, each with a proposed canonical form, claim " +
        "type, and provisional importance. Claims are scarce relative to " +
        "text, so most sentences yield none. Runs a model: metered to your " +
        "account and quota-gated.",
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
    async ({ text, source_type, max_claims }) => {
      const run = await agentic(ctx, "text_analysis", () =>
        extractClaims({
          content: text,
          sourceType: source_type,
          maxClaims: max_claims,
        })
      );
      if (!run.ok) return run.denied;
      return jsonResult({ claims: run.value });
    }
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
        "'unknown' means the graph holds no such claim; 'unassessed' means " +
        "it exists but has no assessment yet. Runs a model: metered to your " +
        "account and quota-gated.",
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
    async ({ text, max_claims }) => {
      const run = await agentic(ctx, "text_analysis", async () => {
        const extracted = await extractClaims({
          content: text,
          sourceType: "assess_text",
          maxClaims: max_claims,
        });
        const judgments = [];
        // Sequential on purpose: each match is its own tool-use loop, and a
        // passage's claims often overlap — bursting them in parallel just
        // races the same vector searches while multiplying peak LLM load.
        for (const c of extracted) {
          const match = await matchAssertion(
            c.original_text,
            c.context ?? undefined
          );
          judgments.push({
            original_text: c.original_text,
            proposed_canonical_form: c.proposed_canonical_form,
            claim_type: c.claim_type,
            // "unknown": the graph has no canonical claim for this assertion.
            // "unassessed": it exists but has no current assessment yet.
            verdict: !match.matched
              ? "unknown"
              : (match.assessment?.status ?? "unassessed"),
            ...match,
          });
        }
        return judgments;
      });
      if (!run.ok) return run.denied;
      return jsonResult({ judgments: run.value });
    }
  );

  // ---- writes ----

  server.registerTool(
    "submit_contribution",
    {
      title: "Submit a contribution",
      description:
        "Contribute to an existing claim: a challenge, supporting evidence, " +
        "a new source appearance, a proposed merge, split, or edit, or an " +
        "argument for or against it. A contribution gets a hearing, not " +
        "automatic admission: a reviewer evaluates it on its merits, the " +
        "exchange is recorded on the claim, and the graph changes only if " +
        "the contribution succeeds. Attributed to your account; returns a " +
        "contribution id for checking the outcome.",
      inputSchema: {
        claim_id: z.string().uuid(),
        contribution_type: contributionTypeEnum,
        content: z.string().min(1).max(10_000),
        evidence_urls: z.array(z.string().url()).max(20).default([]),
        merge_target_claim_id: z.string().uuid().optional(),
        proposed_canonical_form: z.string().max(2000).optional(),
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

      const claim = await getClaimById(input.claim_id);
      if (!claim) return errorResult("NOT_FOUND", "Claim not found");

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
            "the flag can be appealed via POST /appeals."
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
        claimId: input.claim_id,
        contributorId: contributor.id,
        contributionType: input.contribution_type,
        content: input.content,
        evidenceUrls: input.evidence_urls,
        mergeTargetClaimId: input.merge_target_claim_id,
        proposedCanonicalForm: input.proposed_canonical_form,
      });
      await enqueueContribution({ contributionId: contribution.id });

      return jsonResult({
        contribution: {
          id: contribution.id,
          claim_id: contribution.claimId,
          contribution_type: contribution.contributionType,
          review_status: contribution.reviewStatus,
          submitted_at: contribution.submittedAt.toISOString(),
        },
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
        "reviewer's reasoning and policy citations. Free.",
      inputSchema: { contribution_id: z.string().uuid() },
    },
    async ({ contribution_id }) => {
      const contribution = await getContributionById(contribution_id);
      if (!contribution) {
        return errorResult("NOT_FOUND", "Contribution not found");
      }
      const review = await getReviewForContribution(contribution_id);
      return jsonResult({
        contribution: {
          id: contribution.id,
          claim_id: contribution.claimId,
          contribution_type: contribution.contributionType,
          review_status: contribution.reviewStatus,
          submitted_at: contribution.submittedAt.toISOString(),
        },
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
      const id = String(claim_id);
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
              "Use the `assess_text` tool on the document, chunking it if it is " +
              "long. For each judged claim, report the verdict the graph " +
              "returned, not your own recollection. A verdict of `unknown` " +
              "means the graph holds no canonical claim for that assertion; " +
              "`unassessed` means the claim exists but has no assessment yet. " +
              "Watch the `stance` field: `denies` means the document asserts " +
              "the negation of the canonical claim, so invert the assessment " +
              "when judging the document's sentence. Cite each claim's " +
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

  return server;
}
