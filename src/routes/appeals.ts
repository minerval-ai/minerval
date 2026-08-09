import type { FastifyInstance } from "fastify";
import { createAppealBody } from "../schemas/governance.js";
import {
  getContributionById,
  getReviewForContribution,
  createAppeal,
  getAppealById,
  getArbitrationForContribution,
} from "../services/contribution-service.js";
import { getOrCreateContributor } from "../services/contributor-service.js";
import { enqueueArbitration } from "../services/queue-service.js";

export async function appealRoutes(app: FastifyInstance): Promise<void> {
  // POST /appeals
  app.post("/", {
    schema: {
      tags: ["appeals"],
      summary: "Appeal a rejected contribution",
      body: {
        type: "object",
        required: ["contribution_id", "appeal_reasoning"],
        properties: {
          contribution_id: { type: "string", format: "uuid" },
          contributor_display_name: { type: "string" },
          appeal_reasoning: { type: "string" },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            appeal: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                contribution_id: { type: "string", format: "uuid" },
                original_review_id: { type: "string", format: "uuid" },
                appellant_id: { type: "string", format: "uuid" },
                appeal_reasoning: { type: "string" },
                submitted_at: { type: "string", format: "date-time" },
                status: { type: "string" },
              },
            },
          },
        },
        400: {
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
      },
    },
    preHandler: app.authenticate,
    handler: async (request, reply) => {
      const body = createAppealBody.parse(request.body);

      // Verify contribution exists and was rejected
      const contribution = await getContributionById(body.contribution_id);
      if (!contribution) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Contribution not found" },
        });
      }

      if (contribution.reviewStatus !== "rejected") {
        return reply.code(400).send({
          error: {
            code: "INVALID_STATE",
            message: "Only rejected contributions can be appealed",
          },
        });
      }

      // Get the review that rejected it
      const review = await getReviewForContribution(contribution.id);
      if (!review) {
        return reply.code(400).send({
          error: {
            code: "INVALID_STATE",
            message: "No review found for this contribution",
          },
        });
      }

      // The acting contributor comes from the authenticated API key (issue
      // #10) — never from the request body, which would let any caller act as
      // any contributor.
      const externalId = request.contributorExternalId;
      if (!externalId) {
        return reply.code(403).send({
          error: {
            code: "NO_CONTRIBUTOR_IDENTITY",
            message: "API key is not bound to a contributor identity",
          },
        });
      }

      const contributor = await getOrCreateContributor({
        externalId,
        displayName: body.contributor_display_name ?? externalId,
      });

      // Suspended contributors may still appeal their OWN contributions —
      // appeals are the safety valve for bad-faith flags and auto-suspensions
      // (#71), so suspension must not close the door on contesting it. They
      // just can't appeal on behalf of others.
      if (
        contributor.isSuspended &&
        contribution.contributorId !== contributor.id
      ) {
        return reply.code(403).send({
          error: {
            code: "CONTRIBUTOR_SUSPENDED",
            message: `Contributor is suspended: ${contributor.suspensionReason ?? "No reason provided"}`,
          },
        });
      }

      // Create appeal
      const appeal = await createAppeal({
        contributionId: contribution.id,
        originalReviewId: review.id,
        appellantId: contributor.id,
        appealReasoning: body.appeal_reasoning,
      });

      // Enqueue for arbitration
      await enqueueArbitration({
        contributionId: contribution.id,
        trigger: "appeal",
        appealId: appeal.id,
      });

      return reply.code(201).send({
        appeal: {
          id: appeal.id,
          contribution_id: appeal.contributionId,
          original_review_id: appeal.originalReviewId,
          appellant_id: appeal.appellantId,
          appeal_reasoning: appeal.appealReasoning,
          submitted_at: appeal.submittedAt.toISOString(),
          status: appeal.status,
        },
      });
    },
  });

  // GET /appeals/:id
  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["appeals"],
      summary: "Get appeal details",
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
            // Without additionalProperties, fast-json-stringify drops every
            // key of a property-less object schema (see contributions.ts).
            appeal: { type: "object", additionalProperties: true },
            arbitration: { type: "object", nullable: true, additionalProperties: true },
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
      const appeal = await getAppealById(request.params.id);
      if (!appeal) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Appeal not found" },
        });
      }

      const arbitration = await getArbitrationForContribution(
        appeal.contributionId
      );

      return reply.send({
        appeal: {
          id: appeal.id,
          contribution_id: appeal.contributionId,
          original_review_id: appeal.originalReviewId,
          appellant_id: appeal.appellantId,
          appeal_reasoning: appeal.appealReasoning,
          submitted_at: appeal.submittedAt.toISOString(),
          status: appeal.status,
        },
        arbitration: arbitration
          ? {
              id: arbitration.id,
              contribution_id: arbitration.contributionId,
              appeal_id: arbitration.appealId,
              outcome: arbitration.outcome,
              decision: arbitration.decision,
              reasoning: arbitration.reasoning,
              consensus_achieved: arbitration.consensusAchieved,
              human_review_recommended: arbitration.humanReviewRecommended,
              arbitrated_at: arbitration.arbitratedAt.toISOString(),
              arbitrated_by: arbitration.arbitratedBy,
            }
          : null,
      });
    },
  });
}
