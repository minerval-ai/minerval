/**
 * Public contributor surfaces (#71): the owls-earned leaderboard and
 * per-contributor profiles. Reads stay open (no auth), like claim reads —
 * recognition only works if it's visible. The leaderboard ranks lifetime
 * owls EARNED from accepted contributions: purchases never move it and
 * spending never lowers it. Private account fields (email, external auth
 * subject, spendable balance) are never exposed here; that's /users/me.
 */
import type { FastifyInstance } from "fastify";
import { getContributorById } from "../services/contributor-service.js";
import { listContributions } from "../services/contribution-service.js";
import {
  getLeaderboard,
  listRecentAwards,
} from "../services/contribution-award-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { trustLevelFor } from "../services/reputation-service.js";

export async function contributorRoutes(app: FastifyInstance): Promise<void> {
  // GET /contributors — the owls-earned leaderboard.
  app.get<{ Querystring: { limit?: number } }>("/", {
    schema: {
      tags: ["contributors"],
      summary: "Top contributors by owls earned",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            contributors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  display_name: { type: "string" },
                  avatar_url: { type: "string", nullable: true },
                  owls_earned: { type: "number" },
                  reputation_score: { type: "number" },
                  trust_level: { type: "string" },
                  contributions_accepted: { type: "integer" },
                  member_since: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const limit = request.query.limit ?? 20;
      const rows = await getLeaderboard(limit);
      return reply.send({
        contributors: rows.map((r) => ({
          id: r.id,
          display_name: r.displayName,
          avatar_url: r.avatarUrl,
          owls_earned: r.owlsEarned,
          reputation_score: r.reputationScore,
          trust_level: trustLevelFor(r.reputationScore, false),
          contributions_accepted: r.contributionsAccepted,
          member_since: r.createdAt.toISOString(),
        })),
      });
    },
  });

  // GET /contributors/:id — public profile with standing and recent activity.
  app.get<{ Params: { id: string } }>("/:id", {
    schema: {
      tags: ["contributors"],
      summary: "Public contributor profile",
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
            // Enumerated so Fastify's serializer keeps the fields (an empty
            // object schema strips everything).
            contributor: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                display_name: { type: "string" },
                avatar_url: { type: "string", nullable: true },
                member_since: { type: "string", format: "date-time" },
                reputation_score: { type: "number" },
                trust_level: { type: "string" },
                owls_earned: { type: "number" },
                contribution_standing: { type: "string" },
                is_verified: { type: "boolean" },
                is_suspended: { type: "boolean" },
                contributions_accepted: { type: "integer" },
                contributions_rejected: { type: "integer" },
                contributions_escalated: { type: "integer" },
                total_contributions: { type: "integer" },
                acceptance_rate: { type: "integer", nullable: true },
              },
            },
            recent_contributions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  claim_id: { type: "string", format: "uuid" },
                  contribution_type: { type: "string" },
                  review_status: { type: "string" },
                  submitted_at: { type: "string", format: "date-time" },
                },
              },
            },
            recent_awards: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  contribution_id: {
                    type: "string",
                    format: "uuid",
                    nullable: true,
                  },
                  owls: { type: "number" },
                  created_at: { type: "string", format: "date-time" },
                },
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
    handler: async (request, reply) => {
      const contributor = await getContributorById(request.params.id);
      if (!contributor) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Contributor not found" },
        });
      }

      const [contributions, awards] = await Promise.all([
        listContributions({
          contributorId: contributor.id,
          limit: 10,
          offset: 0,
        }),
        listRecentAwards(contributor.id, 10),
      ]);

      const total =
        contributor.contributionsAccepted +
        contributor.contributionsRejected +
        contributor.contributionsEscalated;

      return reply.send({
        contributor: {
          id: contributor.id,
          display_name: contributor.displayName,
          avatar_url: contributor.avatarUrl,
          member_since: contributor.createdAt.toISOString(),
          reputation_score: contributor.reputationScore,
          trust_level: trustLevelFor(
            contributor.reputationScore,
            contributor.isSuspended
          ),
          owls_earned: microUsdToOwls(contributor.owlsEarnedMicroUsd),
          contribution_standing: contributor.contributionStanding,
          is_verified: contributor.isVerified,
          is_suspended: contributor.isSuspended,
          contributions_accepted: contributor.contributionsAccepted,
          contributions_rejected: contributor.contributionsRejected,
          contributions_escalated: contributor.contributionsEscalated,
          total_contributions: total,
          acceptance_rate:
            total > 0
              ? Math.round((contributor.contributionsAccepted / total) * 100)
              : null,
        },
        recent_contributions: contributions.map((c) => ({
          id: c.id,
          claim_id: c.claimId,
          contribution_type: c.contributionType,
          review_status: c.reviewStatus,
          submitted_at: c.submittedAt.toISOString(),
        })),
        recent_awards: awards.map((a) => ({
          id: a.id,
          contribution_id: a.contributionId,
          owls: a.owls,
          created_at: a.createdAt.toISOString(),
        })),
      });
    },
  });
}
