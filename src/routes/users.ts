/**
 * Account routes (#70). One identity: these operate on the `contributors`
 * table, which is both the API consumer and the graph contributor.
 */
import type { FastifyInstance } from "fastify";
import type { Contributor } from "../db/schema.js";
import { provisionUser, getContributorById } from "../services/contributor-service.js";
import {
  getEntitlement,
  serializeEntitlement,
  serializeOwlPacks,
} from "../services/billing-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { trustLevelFor } from "../services/reputation-service.js";

export function serializeUser(user: Contributor) {
  return {
    id: user.id,
    external_id: user.externalId,
    display_name: user.displayName,
    email: user.email,
    avatar_url: user.avatarUrl,
    reputation_score: user.reputationScore,
    trust_level: trustLevelFor(user.reputationScore, user.isSuspended),
    owls_earned: microUsdToOwls(user.owlsEarnedMicroUsd),
    contribution_standing: user.contributionStanding,
    bad_faith_flags: user.badFaithFlags,
    contributions_accepted: user.contributionsAccepted,
    contributions_rejected: user.contributionsRejected,
    contributions_escalated: user.contributionsEscalated,
    is_verified: user.isVerified,
    is_suspended: user.isSuspended,
    created_at: user.createdAt?.toISOString(),
    last_active_at: user.lastActiveAt?.toISOString(),
  };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // POST /users/provision — upsert an account after the auth provider has
  // verified the human. Service-only: the web BFF calls this from its sign-in
  // callback; end users never hit it directly.
  app.post("/provision", {
    schema: {
      tags: ["users"],
      summary: "Provision (upsert) an account from a verified sign-in",
      body: {
        type: "object",
        required: ["external_id", "display_name"],
        properties: {
          external_id: { type: "string", minLength: 1 },
          display_name: { type: "string", minLength: 1 },
          email: { type: "string" },
          avatar_url: { type: "string" },
        },
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const body = request.body as {
        external_id: string;
        display_name: string;
        email?: string;
        avatar_url?: string;
      };
      const user = await provisionUser({
        externalId: body.external_id,
        displayName: body.display_name,
        email: body.email ?? null,
        avatarUrl: body.avatar_url ?? null,
      });
      return reply.send({ user: serializeUser(user) });
    },
  });

  // GET /users/me — the acting account plus its current entitlement.
  app.get("/me", {
    schema: {
      tags: ["users"],
      summary: "Get the authenticated account and its plan/entitlement",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      const [user, entitlement] = await Promise.all([
        getContributorById(userId),
        getEntitlement(userId),
      ]);
      if (!user) {
        return reply.code(404).send({ error: "Account not found" });
      }
      return reply.send({
        user: serializeUser(user),
        entitlement: serializeEntitlement(entitlement),
        packs: serializeOwlPacks(),
      });
    },
  });
}
