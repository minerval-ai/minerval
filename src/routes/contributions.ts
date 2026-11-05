import type { FastifyInstance } from "fastify";
import {
  createContributionBody,
  listContributionsParams,
  CONTRIBUTION_REVIEW_STATUSES,
} from "../schemas/governance.js";
import { anyContributionTypeEnum } from "../schemas/common.js";
import { presentsCredentials } from "../server/plugins/auth.js";
import {
  createContribution,
  getContributionById,
  listContributions,
  getReviewForContribution,
  formatContribution,
  withAnsweredRequest,
} from "../services/contribution-service.js";
import { getClaimById } from "../services/claim-service.js";
import { enqueueContribution } from "../services/queue-service.js";
import { gateContributor } from "../server/contributor-gate.js";

export async function contributionRoutes(app: FastifyInstance): Promise<void> {
  // POST /contributions
  app.post("/", {
    schema: {
      tags: ["contributions"],
      summary: "Submit a contribution for review",
      body: {
        type: "object",
        required: ["claim_id", "contribution_type", "content"],
        properties: {
          claim_id: { type: "string", format: "uuid" },
          contributor_display_name: { type: "string" },
          contribution_type: { type: "string" },
          content: { type: "string" },
          evidence_urls: { type: "array", items: { type: "string" } },
          merge_target_claim_id: { type: "string", format: "uuid" },
          proposed_canonical_form: { type: "string" },
          request_id: {
            type: "string",
            format: "uuid",
            description:
              "Required with answer_request, and only with it: the request the material is offered for. It must bear on claim_id and be open.",
          },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            contribution: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                claim_id: { type: "string", format: "uuid", nullable: true },
                contributor_id: { type: "string", format: "uuid", nullable: true },
                contribution_type: { type: "string" },
                content: { type: "string" },
                evidence_urls: { type: "array", items: { type: "string" } },
                submitted_at: { type: "string", format: "date-time" },
                review_status: { type: "string" },
                page_url: { type: "string", nullable: true },
                became_claim_id: { type: "string", format: "uuid", nullable: true },
              },
            },
          },
        },
        402: {
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
        },
        403: {
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
        },
        404: {
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
        },
        // An answer_request whose request_id is missing, unknown, closed,
        // or on another node (#723).
        422: {
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
        },
        429: {
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
        },
      },
    },
    preHandler: app.authenticate,
    handler: async (request, reply) => {
      const body = createContributionBody.parse(request.body);

      // Verify claim exists
      const claim = await getClaimById(body.claim_id);
      if (!claim) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Claim not found" },
        });
      }

      const answered = await withAnsweredRequest({
        contributionType: body.contribution_type,
        claimId: body.claim_id,
        requestId: body.request_id,
        content: body.content,
      });
      if (!answered.ok) {
        return reply.code(422).send({
          error: { code: answered.code, message: answered.message },
        });
      }

      // Shared gate (#71/#157): identity, suspension, standing, rate limit.
      const contributor = await gateContributor(request, reply, {
        displayName: body.contributor_display_name,
      });
      if (!contributor) return;

      // Create contribution
      const contribution = await createContribution({
        claimId: body.claim_id,
        contributorId: contributor.id,
        contributionType: body.contribution_type,
        content: answered.content,
        evidenceUrls: body.evidence_urls,
        mergeTargetClaimId: body.merge_target_claim_id,
        proposedCanonicalForm: body.proposed_canonical_form,
      });

      // Enqueue for review
      await enqueueContribution({ contributionId: contribution.id });

      return reply.code(201).send({
        contribution: formatContribution(contribution),
      });
    },
  });

  // GET /contributions
  app.get<{ Querystring: Record<string, string> }>("/", {
    schema: {
      tags: ["contributions"],
      summary: "List contributions",
      querystring: {
        type: "object",
        properties: {
          claim_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: [...CONTRIBUTION_REVIEW_STATUSES] },
          type: { type: "string", enum: [...anyContributionTypeEnum.options] },
          mine: {
            type: "boolean",
            description:
              "Only your own contributions, newest first: how to find one whose id you no longer have. Needs your credentials.",
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            contributions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  claim_id: { type: "string", format: "uuid", nullable: true },
                  contributor_id: { type: "string", format: "uuid", nullable: true },
                  contribution_type: { type: "string" },
                  content: { type: "string" },
                  evidence_urls: { type: "array", items: { type: "string" } },
                  submitted_at: { type: "string", format: "date-time" },
                  review_status: { type: "string" },
                  page_url: { type: "string", nullable: true },
                  became_claim_id: { type: "string", format: "uuid", nullable: true },
                },
              },
            },
          },
        },
      },
    },
    // Reads stay open; credentials are read when presented, for `mine`.
    preHandler: async (request, reply) => {
      if (presentsCredentials(request)) await app.authenticate(request, reply);
    },
    handler: async (request, reply) => {
      const params = listContributionsParams.parse(request.query);
      const mine = params.mine === true;
      if (mine && !request.auth?.userId) {
        return reply.code(401).send({
          error: { code: "UNAUTHENTICATED", message: "mine=true needs credentials bound to an account" },
        });
      }

      const rows = await listContributions({
        ...(mine ? { contributorId: request.auth!.userId! } : {}),
        claimId: params.claim_id,
        status: params.status,
        contributionType: params.type,
        limit: params.limit,
        offset: params.offset,
      });

      return reply.send({
        contributions: rows.map(formatContribution),
      });
    },
  });

  // GET /contributions/:id
  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["contributions"],
      summary: "Get contribution details",
      params: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            // additionalProperties is load-bearing, not decoration:
            // fast-json-stringify serializes a bare `type: "object"` with no
            // declared properties as `{}`, silently dropping every key. This
            // endpoint shipped the whole contribution as an empty object.
            contribution: { type: "object", additionalProperties: true },
            review: { type: "object", nullable: true, additionalProperties: true },
          },
        },
        404: {
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
        },
      },
    },
    handler: async (request, reply) => {
      const contribution = await getContributionById(request.params.id);
      if (!contribution) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Contribution not found" },
        });
      }

      const review = await getReviewForContribution(contribution.id);

      return reply.send({
        contribution: formatContribution(contribution),
        review: review
          ? {
              id: review.id,
              decision: review.decision,
              reasoning: review.reasoning,
              confidence: review.confidence,
              policy_citations: review.policyCitations,
              reviewed_at: review.reviewedAt.toISOString(),
              reviewed_by: review.reviewedBy,
            }
          : null,
      });
    },
  });
}
