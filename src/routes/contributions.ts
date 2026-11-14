import { publicContributionRefusal } from "../services/mirrored-node-service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mergedAliasRefusal } from "../services/claim-alias-service.js";
import {
  createContributionBody,
  listContributionsParams,
  CONTRIBUTION_REVIEW_STATUSES,
} from "../schemas/governance.js";
import { anyContributionTypeEnum } from "../schemas/common.js";
import { presentsCredentials } from "../server/plugins/auth.js";
import { optionalAuthHook } from "../server/optional-auth.js";
import {
  createContribution,
  getContributionById,
  listContributions,
  getReviewForContribution,
  formatContribution,
  withAnsweredRequest,
  checkAboutPublishedPage,
  checkArgumentTarget,
} from "../services/contribution-service.js";
import { getClaimById } from "../services/claim-service.js";
import { enqueueContribution } from "../services/queue-service.js";
import { gateContributor } from "../server/contributor-gate.js";
import { STATED_VIEW_CONTRIBUTION_TYPE } from "../schemas/common.js";
import { statedViewForContribution } from "../services/stated-view-service.js";

export async function contributionRoutes(app: FastifyInstance): Promise<void> {
  // POST /contributions
  app.post("/", {
    schema: {
      tags: ["contributions"],
      summary: "Submit a contribution for review",
      body: {
        type: "object",
        required: ["contribution_type", "content"],
        properties: {
          claim_id: {
            type: "string",
            format: "uuid",
            description:
              "The node the contribution is about. Required for every type but " +
              "propose_request, whose bearing (several nodes, sources, or something " +
              "the graph does not hold yet) the content describes and the review settles.",
          },
          contributor_display_name: { type: "string" },
          contribution_type: { type: "string" },
          content: { type: "string" },
          evidence_urls: { type: "array", items: { type: "string" } },
          merge_target_claim_id: { type: "string", format: "uuid" },
          argument_id: {
            type: "string",
            format: "uuid",
            description:
              "One of the node's arguments, when the contribution is about it: with add_instance (a source that makes, attacks or mentions the argument), propose_split, or propose_merge (with merge_target_argument_id).",
          },
          merge_target_argument_id: {
            type: "string",
            format: "uuid",
            description: "propose_merge of two arguments on the node: the other argument.",
          },
          proposed_canonical_form: { type: "string" },
          request_id: {
            type: "string",
            format: "uuid",
            description:
              "Required with answer_request, and only with it: the request the material is offered for. It must bear on claim_id and be open.",
          },
          about_published_page_id: {
            type: "string",
            format: "uuid",
            description:
              "A published page on this node (get_published_page, or the second tab of the node's page), when the contribution is made through it: a challenge to what the page says or to how it was made, or a proposal about what the node rests on. It is reviewed as any contribution on the node is, and the graph that published the page learns of it from the public record.",
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
        // The node, or the merge target, was merged into another (#884):
        // `merged_into` is the survivor to address instead.
        409: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                merged_into: { type: "string", format: "uuid" },
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

      // Verify the claim exists, when one is named (a propose_request may
      // name none, #724).
      if (body.claim_id) {
        const claim = await getClaimById(body.claim_id);
        if (!claim) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Claim not found" },
          });
        }
      }
      // A contribution addressed to a merged node is refused and told the
      // survivor (#884): the row exists, so the check above passed it and
      // the contribution landed where no Steward would read it.
      for (const id of [body.claim_id, body.merge_target_claim_id]) {
        const merged = await mergedAliasRefusal(id);
        if (merged) {
          return reply.code(409).send({
            error: { code: "CLAIM_MERGED", message: merged.message, merged_into: merged.survivorId },
          });
        }
      }

      // A mirrored node at its own label takes no contribution here
      // (mirrored-node-service.ts); said before anything is counted.
      const notTaken = await publicContributionRefusal(body.claim_id);
      if (notTaken) {
        return reply.code(409).send({ error: { code: "PUBLIC_GRAPH_NODE", message: notTaken } });
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

      const argumentTarget = await checkArgumentTarget({
        type: body.contribution_type,
        claimId: body.claim_id ?? null,
        argumentId: body.argument_id,
        mergeTargetArgumentId: body.merge_target_argument_id,
        mergeTargetClaimId: body.merge_target_claim_id,
      });
      if (!argumentTarget.ok) {
        return reply.code(422).send({
          error: { code: "ARGUMENT_TARGET", message: argumentTarget.message },
        });
      }

      const aboutPage = await checkAboutPublishedPage(body.claim_id ?? null, body.about_published_page_id);
      if (!aboutPage.ok) {
        return reply.code(422).send({ error: { code: "PUBLISHED_PAGE", message: aboutPage.message } });
      }

      // Shared gate (#71/#157): identity, suspension, standing, rate limit.
      const contributor = await gateContributor(request, reply, {
        displayName: body.contributor_display_name,
      });
      if (!contributor) return;

      // Create contribution
      const contribution = await createContribution({
        aboutPublishedPageId: aboutPage.publishedPageId,
        claimId: body.claim_id ?? null,
        contributorId: contributor.id,
        contributionType: body.contribution_type,
        content: answered.content,
        evidenceUrls: body.evidence_urls,
        mergeTargetClaimId: body.merge_target_claim_id,
        argumentId: argumentTarget.argumentId,
        mergeTargetArgumentId: argumentTarget.mergeTargetArgumentId,
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
    preHandler: optionalAuthHook(async (request: FastifyRequest, reply: FastifyReply) => {
      if (presentsCredentials(request)) await app.authenticate(request, reply);
    }),
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
            stated_view: { type: "object", additionalProperties: true },
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
      // A view stated to the graph (§4) carries more than its text: how the
      // speaker stands, its stake, and what became of its reasons.
      const statedView =
        contribution.contributionType === STATED_VIEW_CONTRIBUTION_TYPE
          ? await statedViewForContribution(contribution.id)
          : null;

      // Where it was made through a published page: what the graph that published the page has said became of it (publisher-record-service.ts).
      const through = contribution.aboutPublishedPageId
        ? await (await import("../services/publisher-record-service.js")).answerToContribution(contribution.id)
        : null;

      return reply.send({
        contribution: { ...formatContribution(contribution), ...(through ? { through_published_page: through } : {}) },
        ...(statedView ? { stated_view: statedView } : {}),
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
