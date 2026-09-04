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
import { listOpenPrizeClaimsFor } from "../services/prize-account-service.js";
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
    // Prize owls (docs/mathematics.md §8.7) beside, not inside, owls earned:
    // the leaderboard sum excludes them.
    owls_prized: microUsdToOwls(user.owlsPrizedMicroUsd ?? 0),
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

  // GET /users/me — the acting account plus its current entitlement and,
  // for a claimant, its prize claims with where the winner's steps stand
  // (docs/mathematics.md §8.7). A failure in the prize query is logged and
  // must not hide the account.
  app.get("/me", {
    schema: {
      tags: ["users"],
      summary: "Get the authenticated account, its plan/entitlement, and its prize claims",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const userId = request.auth!.userId!;
      const [user, entitlement, openPrizeClaims] = await Promise.all([
        getContributorById(userId),
        getEntitlement(userId),
        listOpenPrizeClaimsFor(userId).catch((err) => {
          console.error("[users] prize claims for /users/me failed:", err instanceof Error ? err.message : err);
          return [];
        }),
      ]);
      if (!user) {
        return reply.code(404).send({ error: "Account not found" });
      }
      return reply.send({
        user: serializeUser(user),
        entitlement: serializeEntitlement(entitlement),
        packs: serializeOwlPacks(),
        open_prize_claims: openPrizeClaims,
      });
    },
  });
}
