import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  assessments,
  claimInstances,
  sources,
} from "../db/schema.js";
import { claimSearchParams, claimListParams, claimGetParams, claimDependentsParams, claimProposeBody, claimPatchBody, assessmentHistoryParams, claimEventsParams } from "../schemas/claim.js";
import { getAssessmentHistory, getAssessmentTrajectory } from "../services/assessment-service.js";
import { getClaimEvents } from "../services/claim-events-service.js";
import { hybridSearch } from "../services/search-service.js";
import { getClaimTree, getSubclaimCount, getClaimDependents, listClaimDependents } from "../services/tree-service.js";
import { getClaimById, listClaims, proposeClaim } from "../services/claim-service.js";
import { getContributionRecordForClaim } from "../services/contribution-service.js";
import {
  addArgument,
  getArgumentsForClaim,
  getEvaluationStateForClaim,
} from "../services/argument-service.js";
import { createClaimProposal } from "../services/intake-service.js";
import { assembleClaimCitation } from "../services/citation-service.js";
import { assembleClaimNanopub } from "../services/nanopub-service.js";
import { gateContributor } from "../server/contributor-gate.js";
import { isDirectService } from "../server/plugins/auth.js";

// Contributor-gate errors ({error: {code, message}}), shared with
// POST /contributions.
const errorEnvelopeSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export const claimSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    text: { type: "string" },
    claim_type: { type: "string" },
    state: { type: "string" },
    decomposition_status: { type: "string" },
    importance: { type: "number" },
    steward_state: { type: "string" },
    created_by: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
} as const;

export const assessmentSchema = {
  type: "object",
  nullable: true,
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string" },
    // Verdict confidence — how sure the Steward is of the status, not P(true).
    confidence: { type: "number" },
    // Credence that the claim is true; null where one number would be false
    // precision (constitution §7).
    claim_credence: { type: "number", nullable: true },
    summary: { type: "string" },
    reasoning_trace: { type: "string" },
    subclaim_summary: { type: "object", additionalProperties: true },
    assessed_at: { type: "string", format: "date-time" },
    // Raw API id of the model that produced the assessment (#294); null for
    // rows written before the column existed.
    model: { type: "string", nullable: true },
  },
} as const;

const errorEnvelope = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string" },
      },
    },
  },
} as const;

export async function claimRoutes(app: FastifyInstance): Promise<void> {
  // GET /claims — list claims for browsing, most-recently-updated first
  app.get<{ Querystring: Record<string, string> }>(
    "/",
    {
      schema: {
        tags: ["claims"],
        summary: "List claims (browse), most-recently-updated first",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
            cursor: { type: "string" },
            state: { type: "string" },
            assessed: { type: "string", enum: ["all", "assessed", "unassessed"], default: "all" },
            min_importance: { type: "number", minimum: 0, maximum: 1, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    text: { type: "string" },
                    claim_type: { type: "string" },
                    state: { type: "string" },
                    importance: { type: "number", nullable: true },
                    assessment_status: { type: "string", nullable: true },
                    assessment_confidence: { type: "number", nullable: true },
                  },
                },
              },
              next_cursor: { type: "string", nullable: true },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const params = claimListParams.parse(request.query);
        const { results, next_cursor } = await listClaims({
          limit: params.limit,
          cursor: params.cursor,
          state: params.state,
          assessed: params.assessed,
          minImportance: params.min_importance,
        });
        return reply.send({ results, next_cursor });
      },
    }
  );

  // GET /claims/search/:query
  app.get<{ Params: { query: string }; Querystring: Record<string, string> }>(
    "/search/:query",
    {
      schema: {
        tags: ["claims"],
        summary: "Search claims by text query",
        params: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            min_similarity: { type: "number", minimum: 0, maximum: 1, default: 0.3 },
            assessed: { type: "string", enum: ["all", "assessed", "unassessed"], default: "all" },
            min_importance: { type: "number", minimum: 0, maximum: 1, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    text: { type: "string" },
                    claim_type: { type: "string" },
                    state: { type: "string" },
                    similarity_score: { type: "number" },
                    importance: { type: "number", nullable: true },
                    assessment_status: { type: "string", nullable: true },
                    assessment_confidence: { type: "number", nullable: true },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
        },
      },
      handler: async (request, reply) => {
        const { query } = request.params;
        const params = claimSearchParams.parse(request.query);

        const { results, total } = await hybridSearch(query, {
          limit: params.limit,
          minSimilarity: params.min_similarity,
          assessed: params.assessed,
          minImportance: params.min_importance,
        });

        return reply.send({ results, total });
      },
    }
  );

  // GET /claims/:claim_id
  app.get<{ Params: { claim_id: string }; Querystring: Record<string, string> }>(
    "/:claim_id",
    {
      schema: {
        tags: ["claims"],
        summary: "Get claim details",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            information_depth: { type: "string", enum: ["cursory", "standard", "deep"], default: "standard" },
            depth: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Cap the decomposition tree depth (default 10). The node cap, not depth, bounds cost." },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              claim: claimSchema,
              assessment: assessmentSchema,
              subclaim_count: { type: "integer" },
              // Steward-seeded prior (#285): the parent claim's Steward's
              // preliminary credence/note, served only while this claim has
              // no current assessment — the claim still reads as unassessed.
              seed: {
                type: "object",
                nullable: true,
                properties: {
                  credence: { type: "number", nullable: true },
                  note: { type: "string", nullable: true },
                  seeded_by: {
                    type: "object",
                    nullable: true,
                    properties: {
                      id: { type: "string", format: "uuid" },
                      text: { type: "string" },
                    },
                  },
                },
              },
              tree: { type: "object", nullable: true, additionalProperties: true },
              arguments: { type: "array", nullable: true },
              instances: { type: "array", nullable: true },
              dependents: { type: "array", nullable: true },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const params = claimGetParams.parse(request.query);

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        // Always: assessment + subclaim count
        const db = getDb();
        const [assessment] = await db
          .select()
          .from(assessments)
          .where(and(eq(assessments.claimId, claim_id), eq(assessments.isCurrent, true)))
          .limit(1);

        const subclaimCount = await getSubclaimCount(claim_id);

        const response: Record<string, unknown> = {
          claim: formatClaim(claim),
          assessment: assessment ? formatAssessment(assessment) : null,
          subclaim_count: subclaimCount,
        };

        // Steward-seeded prior (#285): surfaced only while the claim has no
        // current assessment. Once its own Steward has judged, the seed is
        // history — it must never sit beside the verdict as a second opinion.
        if (!assessment && (claim.seedCredence != null || claim.seedNote != null)) {
          let seededBy: { id: string; text: string } | null = null;
          if (claim.seedSourceClaimId) {
            const source = await getClaimById(claim.seedSourceClaimId);
            if (source) seededBy = { id: source.id, text: source.text };
          }
          response.seed = {
            credence: claim.seedCredence,
            note: claim.seedNote,
            seeded_by: seededBy,
          };
        }

        // Standard: + full tree (depth-capped on request — the claim map
        // renders three rings per view and shouldn't pay for five)
        if (
          params.information_depth === "standard" ||
          params.information_depth === "deep"
        ) {
          response.tree = await getClaimTree(claim_id, params.depth ?? 10);
        }

        // Deep: + arguments + source instances
        if (params.information_depth === "deep") {
          const args = await getArgumentsForClaim(claim_id);
          // Current steward evaluations (issue #173); only named arguments
          // carry one, so unnamed rows simply map to null.
          const evalStates = await getEvaluationStateForClaim(claim_id);
          const evalByArgument = new Map(
            evalStates.map((s) => [s.argument_id, s])
          );
          response.arguments = args.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            stance: a.stance,
            content: a.content,
            evidence_urls: a.evidenceUrls,
            created_by: a.createdBy,
            created_at: a.createdAt.toISOString(),
            verdict: evalByArgument.get(a.id)?.verdict ?? null,
            evaluation: evalByArgument.get(a.id)?.content ?? null,
          }));

          const instances = await db
            .select({
              id: claimInstances.id,
              source_id: claimInstances.sourceId,
              original_text: claimInstances.originalText,
              context: claimInstances.context,
              confidence: claimInstances.confidence,
              source_title: sources.title,
              source_url: sources.url,
            })
            .from(claimInstances)
            .innerJoin(sources, eq(claimInstances.sourceId, sources.id))
            .where(eq(claimInstances.claimId, claim_id));

          response.instances = instances;

          // Reverse decomposition edges: the claims that depend on this one.
          response.dependents = await getClaimDependents(claim_id);
        }

        return reply.send(response);
      },
    }
  );

  // GET /claims/:claim_id/citation — "Cite this claim" (#290): a conventional
  // scholarly citation (author = Minerval, pinned to the current assessment
  // version) plus the grounded evidence record — assessment + reasoning,
  // arguments with their basis subclaims, source instances with verbatim
  // quotes, and live disagreement. Read-only: renders existing state.
  //
  // format=json is the full envelope; bibtex and csl serve just that rendering
  // with its conventional content type, so `curl .../citation?format=bibtex`
  // drops straight into a .bib file. No response schema on purpose: the
  // payload is format-dependent (BibTeX is plain text), so fastify's
  // fixed-schema serializer can't cover it.
  app.get<{ Params: { claim_id: string }; Querystring: { format?: string } }>(
    "/:claim_id/citation",
    {
      schema: {
        tags: ["claims"],
        summary:
          "Cite this claim: a formal citation plus the grounded evidence record",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["json", "bibtex", "csl"],
              default: "json",
            },
          },
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const format = request.query.format ?? "json";

        const result = await assembleClaimCitation(claim_id);
        if (!result) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        if (format === "bibtex") {
          return reply
            .type("application/x-bibtex; charset=utf-8")
            .send(result.citation.bibtex);
        }
        if (format === "csl") {
          return reply
            .type("application/vnd.citationstyles.csl+json; charset=utf-8")
            .send(JSON.stringify(result.citation.csl));
        }
        return reply.send(result);
      },
    }
  );

  // GET /claims/:claim_id/nanopub — the nanopublication export (#292): the
  // same evidence record as /citation, serialized as RDF in the nanopub shape
  // (assertion / provenance / publication-info) for scholarly-web and
  // linked-data consumers. TriG by default, JSON-LD on request. Read-only;
  // credence is omitted exactly where the graph omits it (§10), and exported
  // prose resolves [[claim:...]] machinery to canonical text (§12). No
  // response schema: both formats are opaque serializations, not
  // field-mapped JSON.
  app.get<{ Params: { claim_id: string }; Querystring: { format?: string } }>(
    "/:claim_id/nanopub",
    {
      schema: {
        tags: ["claims"],
        summary:
          "Export the claim + assessment + evidence as a nanopublication (RDF)",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["trig", "jsonld"],
              default: "trig",
            },
          },
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const format = request.query.format === "jsonld" ? "jsonld" : "trig";

        const result = await assembleClaimNanopub(claim_id, format);
        if (!result) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        return reply.type(result.contentType).send(result.body);
      },
    }
  );

  // GET /claims/:claim_id/dependents — the reverse decomposition edges (issue
  // #102). Standalone so the claim map can recentre without dragging the full
  // deep payload along; importance-ranked so truncating consumers surface the
  // most load-bearing dependents first.
  app.get<{ Params: { claim_id: string }; Querystring: Record<string, string> }>(
    "/:claim_id/dependents",
    {
      schema: {
        tags: ["claims"],
        summary: "List the claims that depend on this claim",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              dependents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    text: { type: "string" },
                    claim_type: { type: "string" },
                    relation_type: { type: "string" },
                    reasoning: { type: "string" },
                    importance: { type: "number" },
                    assessment_status: { type: "string", nullable: true },
                    assessment_confidence: { type: "number", nullable: true },
                    assessment_credence: { type: "number", nullable: true },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const params = claimDependentsParams.parse(request.query);

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        const { dependents, total } = await listClaimDependents(claim_id, {
          limit: params.limit,
          offset: params.offset,
        });

        return reply.send({ dependents, total });
      },
    }
  );

  // GET /claims/:claim_id/record — the public contribution record (issue
  // #171). Each entry is one exchange: contribution → review decision +
  // reasoning → any appeal → arbitration outcome. The constitution's Burden
  // of Engagement makes these exchanges part of the claim's public record;
  // this endpoint assembles them so the claim page can render the record
  // without stitching together the single-record endpoints. Standalone rather
  // than folded into the deep payload so the record can load (and fail)
  // independently of the reading column.
  //
  // The response schema doubles as the public-field filter: internal review
  // fields (suspected_bad_faith, bad_faith_category) and arbitration
  // model_votes are absent here and therefore never serialized.
  app.get<{ Params: { claim_id: string } }>(
    "/:claim_id/record",
    {
      schema: {
        tags: ["claims"],
        summary: "The public contribution record for a claim",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              record: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    contribution: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        contributor: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            display_name: { type: "string" },
                          },
                        },
                        contribution_type: { type: "string" },
                        content: { type: "string" },
                        evidence_urls: { type: "array", items: { type: "string" } },
                        submitted_at: { type: "string", format: "date-time" },
                        review_status: { type: "string" },
                      },
                    },
                    review: {
                      type: "object",
                      nullable: true,
                      properties: {
                        id: { type: "string", format: "uuid" },
                        decision: { type: "string" },
                        reasoning: { type: "string" },
                        confidence: { type: "number", nullable: true },
                        policy_citations: { type: "array", items: { type: "string" } },
                        reviewed_at: { type: "string", format: "date-time" },
                        reviewed_by: { type: "string" },
                      },
                    },
                    appeal: {
                      type: "object",
                      nullable: true,
                      properties: {
                        id: { type: "string", format: "uuid" },
                        appellant: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            display_name: { type: "string" },
                          },
                        },
                        appeal_reasoning: { type: "string" },
                        submitted_at: { type: "string", format: "date-time" },
                        status: { type: "string" },
                      },
                    },
                    arbitration: {
                      type: "object",
                      nullable: true,
                      properties: {
                        id: { type: "string", format: "uuid" },
                        outcome: { type: "string" },
                        decision: { type: "string" },
                        reasoning: { type: "string" },
                        consensus_achieved: { type: "boolean", nullable: true },
                        human_review_recommended: { type: "boolean" },
                        arbitrated_at: { type: "string", format: "date-time" },
                        arbitrated_by: { type: "string" },
                      },
                    },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        const record = await getContributionRecordForClaim(claim_id);

        return reply.send({
          record: record.map((entry) => ({
            contribution: {
              id: entry.contribution.id,
              contributor: {
                id: entry.contribution.contributorId,
                display_name: entry.contributorDisplayName,
              },
              contribution_type: entry.contribution.contributionType,
              content: entry.contribution.content,
              evidence_urls: entry.contribution.evidenceUrls,
              submitted_at: entry.contribution.submittedAt.toISOString(),
              review_status: entry.contribution.reviewStatus,
            },
            review: entry.review
              ? {
                  id: entry.review.id,
                  decision: entry.review.decision,
                  reasoning: entry.review.reasoning,
                  confidence: entry.review.confidence,
                  policy_citations: entry.review.policyCitations,
                  reviewed_at: entry.review.reviewedAt.toISOString(),
                  reviewed_by: entry.review.reviewedBy,
                }
              : null,
            appeal: entry.appeal
              ? {
                  id: entry.appeal.id,
                  appellant: {
                    id: entry.appeal.appellantId,
                    display_name: entry.appeal.appellantDisplayName,
                  },
                  appeal_reasoning: entry.appeal.appealReasoning,
                  submitted_at: entry.appeal.submittedAt.toISOString(),
                  status: entry.appeal.status,
                }
              : null,
            arbitration: entry.arbitration
              ? {
                  id: entry.arbitration.id,
                  outcome: entry.arbitration.outcome,
                  decision: entry.arbitration.decision,
                  reasoning: entry.arbitration.reasoning,
                  consensus_achieved: entry.arbitration.consensusAchieved,
                  human_review_recommended: entry.arbitration.humanReviewRecommended,
                  arbitrated_at: entry.arbitration.arbitratedAt.toISOString(),
                  arbitrated_by: entry.arbitration.arbitratedBy,
                }
              : null,
          })),
          total: record.length,
        });
      },
    }
  );

  // POST /claims/propose
  app.post("/propose", {
    schema: {
      tags: ["claims"],
      summary:
        "Propose a new claim with an initial argument (user proposals enter the review queue)",
      body: {
        type: "object",
        required: ["claim", "argument"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 2000 },
          argument: { type: "string", minLength: 1, maxLength: 5000 },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            claim: claimSchema,
            argument: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                stance: { type: "string" },
                content: { type: "string" },
                created_by: { type: "string" },
                created_at: { type: "string", format: "date-time" },
              },
            },
            job_id: { type: "string", format: "uuid" },
          },
        },
        202: {
          type: "object",
          properties: {
            contribution: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                contribution_type: { type: "string" },
                review_status: { type: "string" },
                submitted_at: { type: "string", format: "date-time" },
              },
            },
            message: { type: "string" },
          },
        },
        402: errorEnvelopeSchema,
        403: errorEnvelopeSchema,
        429: errorEnvelopeSchema,
      },
    },
    // Proposing a claim triggers LLM work (review or matching + stewarding),
    // so it is a metered agentic surface (#70).
    preHandler: [app.authenticate, app.requireAgenticQuota],
    handler: async (request, reply) => {
      const body = claimProposeBody.parse(request.body);
      const auth = request.auth;

      // Internal seeding fast path (#157): a direct service caller (corpus,
      // FLF case studies) writes live and enqueues the Steward immediately.
      // Everything else — including the web BFF acting for a signed-in user —
      // takes the intake path below.
      if (isDirectService(auth)) {
        const result = await proposeClaim({
          claim: body.claim,
          argument: body.argument,
          // Provenance: after #157, created_by='user' means "user-proposed,
          // review-approved" — the unreviewed fast path is service seeding
          // and says so.
          createdBy: "service",
          attribution: {
            userId: auth.userId ?? null,
            apiKeyId: auth.apiKeyId ?? null,
          },
        });

        return reply.code(201).send({
          claim: formatClaim(result.claim),
          argument: {
            id: result.argument.id,
            stance: result.argument.stance,
            content: result.argument.content,
            created_by: result.argument.createdBy,
            created_at: result.argument.createdAt.toISOString(),
          },
          job_id: result.jobId,
        });
      }

      // Governed intake (#157): the proposal is a suggestion, not a write. It
      // is stored as a pending contribution — nothing enters the claims table
      // — and the Contribution Reviewer decides; acceptance canonicalizes
      // through the Matcher and only then materializes a live claim.
      const contributor = await gateContributor(request, reply);
      if (!contributor) return;

      const contribution = await createClaimProposal({
        claimText: body.claim,
        argumentText: body.argument,
        contributorId: contributor.id,
      });

      return reply.code(202).send({
        contribution: {
          id: contribution.id,
          contribution_type: contribution.contributionType,
          review_status: contribution.reviewStatus,
          submitted_at: contribution.submittedAt.toISOString(),
        },
        message:
          "Proposal queued for review. If accepted, it will be matched " +
          "against existing claims and materialized into the graph; track it " +
          "via GET /contributions/" +
          contribution.id,
      });
    },
  });

  // GET /claims/:claim_id/assessments
  app.get<{ Params: { claim_id: string }; Querystring: Record<string, string> }>(
    "/:claim_id/assessments",
    {
      schema: {
        tags: ["claims"],
        summary: "Get paginated assessment history for a claim",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
            since: { type: "string", format: "date-time" },
            until: { type: "string", format: "date-time" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              assessments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    claim_id: { type: "string", format: "uuid" },
                    status: { type: "string" },
                    confidence: { type: "number" },
                    claim_credence: { type: "number", nullable: true },
                    summary: { type: "string" },
                    reasoning_trace: { type: "string" },
                    is_current: { type: "boolean" },
                    subclaim_summary: { type: "object", additionalProperties: true },
                    trigger: { type: "string", nullable: true },
                    trigger_context: { type: "string", nullable: true },
                    assessed_at: { type: "string", format: "date-time" },
                    model: { type: "string", nullable: true },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const params = assessmentHistoryParams.parse(request.query);

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        const result = await getAssessmentHistory(claim_id, {
          limit: params.limit,
          offset: params.offset,
          since: params.since,
          until: params.until,
        });

        return reply.send({
          assessments: result.assessments.map(formatAssessmentHistory),
          total: result.total,
        });
      },
    }
  );

  // GET /claims/:claim_id/assessments/trajectory
  app.get<{ Params: { claim_id: string } }>(
    "/:claim_id/assessments/trajectory",
    {
      schema: {
        tags: ["claims"],
        summary: "Get assessment trajectory summary for a claim",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              current: {
                type: "object",
                nullable: true,
                properties: {
                  status: { type: "string" },
                  confidence: { type: "number" },
                  assessed_at: { type: "string", format: "date-time" },
                  is_current: { type: "boolean" },
                  trigger: { type: "string", nullable: true },
                },
              },
              history: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    confidence: { type: "number" },
                    assessed_at: { type: "string", format: "date-time" },
                    is_current: { type: "boolean" },
                    trigger: { type: "string", nullable: true },
                  },
                },
              },
              total_assessments: { type: "integer" },
              status_transitions: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        const trajectory = await getAssessmentTrajectory(claim_id);

        return reply.send({
          current: trajectory.current ? formatTrajectoryPoint(trajectory.current) : null,
          history: trajectory.history.map(formatTrajectoryPoint),
          total_assessments: trajectory.totalAssessments,
          status_transitions: trajectory.statusTransitions,
        });
      },
    }
  );

  // GET /claims/:claim_id/events — the unified per-claim history (issue #175):
  // assessments, contributions and the decisions on them (reviews, appeals,
  // arbitration), and Steward audit-log entries, merged newest-first. One flat
  // typed list so a claim with one assessment and a claim with dozens of
  // exchanges from several parties serialize identically.
  app.get<{ Params: { claim_id: string }; Querystring: Record<string, string> }>(
    "/:claim_id/events",
    {
      schema: {
        tags: ["claims"],
        summary: "Get the unified event history for a claim",
        params: {
          type: "object",
          properties: {
            claim_id: { type: "string", format: "uuid" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              events: {
                type: "array",
                items: {
                  // A discriminated union on `kind`; serialized as one loose
                  // object because fastify's serializer strips fields a strict
                  // per-kind schema wouldn't enumerate.
                  type: "object",
                  required: ["kind", "id", "at", "actor"],
                  additionalProperties: true,
                  properties: {
                    kind: {
                      type: "string",
                      enum: [
                        "created",
                        "assessment",
                        "contribution",
                        "review",
                        "appeal",
                        "arbitration",
                        "steward_note",
                      ],
                    },
                    id: { type: "string" },
                    at: { type: "string", format: "date-time" },
                    actor: { type: "string" },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
          404: errorEnvelope,
        },
      },
      handler: async (request, reply) => {
        const { claim_id } = request.params;
        const params = claimEventsParams.parse(request.query);

        const claim = await getClaimById(claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Claim not found",
              request_id: request.id,
            },
          });
        }

        const result = await getClaimEvents(claim, {
          limit: params.limit,
          offset: params.offset,
        });

        return reply.send(result);
      },
    }
  );

  // PATCH /claims/:claim_id
  app.patch<{ Params: { claim_id: string } }>("/:claim_id", {
    schema: {
      tags: ["claims"],
      summary: "Add an argument to a claim",
      params: {
        type: "object",
        properties: {
          claim_id: { type: "string", format: "uuid" },
        },
      },
      body: {
        type: "object",
        required: ["argument"],
        properties: {
          argument: {
            type: "object",
            required: ["stance", "content"],
            properties: {
              stance: { type: "string", enum: ["for", "against"] },
              content: { type: "string", minLength: 1, maxLength: 5000 },
              evidence_urls: { type: "array", items: { type: "string", format: "uri" } },
            },
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            argument: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                claim_id: { type: "string", format: "uuid" },
                stance: { type: "string" },
                content: { type: "string" },
                evidence_urls: { type: "array", items: { type: "string" } },
                created_by: { type: "string" },
                created_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
        404: errorEnvelope,
      },
    },
    preHandler: app.authenticate,
    handler: async (request, reply) => {
      const { claim_id } = request.params;
      const body = claimPatchBody.parse(request.body);

      const claim = await getClaimById(claim_id);
      if (!claim) {
        return reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Claim not found",
            request_id: request.id,
          },
        });
      }

      const argument = await addArgument({
        claimId: claim_id,
        stance: body.argument.stance,
        content: body.argument.content,
        evidenceUrls: body.argument.evidence_urls,
      });

      return reply.send({
        argument: {
          id: argument.id,
          claim_id: argument.claimId,
          stance: argument.stance,
          content: argument.content,
          evidence_urls: argument.evidenceUrls,
          created_by: argument.createdBy,
          created_at: argument.createdAt.toISOString(),
        },
      });
    },
  });
}

function formatClaim(claim: { id: string; text: string; claimType: string; state: string; decompositionStatus: string; importance: number; stewardState: string; createdBy: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: claim.id,
    text: claim.text,
    claim_type: claim.claimType,
    state: claim.state,
    decomposition_status: claim.decompositionStatus,
    importance: claim.importance,
    // The Steward work-queue lifecycle (pending → running → done | error). Lets the
    // UI distinguish a not-yet-stewarded stub from a claim found genuinely atomic.
    steward_state: claim.stewardState,
    created_by: claim.createdBy,
    created_at: claim.createdAt.toISOString(),
    updated_at: claim.updatedAt.toISOString(),
  };
}

export function formatAssessment(a: { id: string; status: string; confidence: number; claimCredence: number | null; summary: string | null; reasoningTrace: string; subclaimSummary: unknown; assessedAt: Date; model?: string | null }) {
  return {
    id: a.id,
    status: a.status,
    // Verdict confidence — how sure the Steward is of the status, not P(true).
    confidence: a.confidence,
    // Credence that the claim is true; null where one number would be false
    // precision (constitution §7).
    claim_credence: a.claimCredence ?? null,
    // Reader-facing body; fall back to the reasoning trace for assessments
    // written before the summary/reasoning split (nullable column).
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    // Guarantee a non-null object so clients can safely Object.entries() it (issue #17).
    subclaim_summary: a.subclaimSummary ?? {},
    assessed_at: a.assessedAt.toISOString(),
    // The assessor behind the verdict (#294); null for legacy rows.
    model: a.model ?? null,
  };
}

function formatAssessmentHistory(a: {
  id: string;
  claimId: string;
  status: string;
  confidence: number;
  claimCredence: number | null;
  summary: string | null;
  reasoningTrace: string;
  isCurrent: boolean;
  subclaimSummary: unknown;
  trigger: string | null;
  triggerContext: string | null;
  assessedAt: Date;
  model?: string | null;
}) {
  return {
    id: a.id,
    claim_id: a.claimId,
    status: a.status,
    confidence: a.confidence,
    claim_credence: a.claimCredence ?? null,
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    is_current: a.isCurrent,
    subclaim_summary: a.subclaimSummary ?? {},
    trigger: a.trigger,
    trigger_context: a.triggerContext,
    assessed_at: a.assessedAt.toISOString(),
    model: a.model ?? null,
  };
}

function formatTrajectoryPoint(p: {
  status: string;
  confidence: number;
  assessedAt: Date;
  isCurrent: boolean;
  trigger: string | null;
}) {
  return {
    status: p.status,
    confidence: p.confidence,
    assessed_at: p.assessedAt.toISOString(),
    is_current: p.isCurrent,
    trigger: p.trigger,
  };
}
