/**
 * Account routes (#70). One identity: these operate on the `contributors`
 * table, which is both the API consumer and the graph contributor.
 */
import type { FastifyInstance } from "fastify";
import type { Contributor } from "../db/schema.js";
import { provisionUser, getContributorById } from "../services/contributor-service.js";
import { isOrganizationExternalId } from "../services/organization-service.js";
import {
  getEntitlement,
  serializeEntitlement,
  serializeOwlPacks,
} from "../services/billing-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { listOpenPrizeClaimsFor } from "../services/prize-account-service.js";
import { trustLevelFor } from "../services/reputation-service.js";
import { membersOnly } from "../permissions.js";
import {
  GUEST_EXTERNAL_ID_PREFIX,
  carryGuestToAccount,
  guestTerms,
  guestsOffered,
  isGuestExternalId,
  makeGuestPass,
} from "../services/guest-service.js";
import { assistantModels } from "../services/assistant-service.js";
import {
  establishFirstAdministrator,
  recordSignInGroups,
} from "../services/permission-service.js";

export function serializeUser(user: Contributor) {
  return {
    id: user.id,
    external_id: user.externalId,
    kind: user.kind,
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
          // The group names the identity provider put in this sign-in's
          // claims. A field of a members-only deployment alone, where a
          // grant can be made to a group (src/permissions.ts). When present
          // it is the whole list: a group left out is one the person is no
          // longer in.
          ...(membersOnly() ? { groups: { type: "array", items: { type: "string" } } } : {}),
          // The guest this person was on /ask before signing in, from the
          // web tier's cookie: their conversations with the Assistant are
          // carried to the account (docs/accounts.md, "Guests").
          guest_external_id: { type: "string", maxLength: 200 },
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
        groups?: string[];
        guest_external_id?: string;
      };
      // No sign-in makes an organization's or the platform's identity:
      // nobody signs in as either (docs/organizations.md).
      if (
        isOrganizationExternalId(body.external_id) ||
        body.external_id.startsWith("platform:") ||
        isGuestExternalId(body.external_id)
      ) {
        return reply.code(422).send({
          error: "That identity is an organization's or the platform's, and no sign-in makes one.",
          code: "NOT_A_SIGN_IN_IDENTITY",
        });
      }
      const user = await provisionUser({
        externalId: body.external_id,
        displayName: body.display_name,
        email: body.email ?? null,
        avatarUrl: body.avatar_url ?? null,
      });
      if (membersOnly()) {
        if (body.groups !== undefined) await recordSignInGroups(user.id, body.groups);
        // The person the FIRST_ADMINISTRATOR setting names is granted every
        // permission the first time they sign in, once (permission-service).
        await establishFirstAdministrator({ id: user.id, externalId: user.externalId });
      }
      let carried = 0;
      if (body.guest_external_id) {
        carried = await carryGuestToAccount({ guestExternalId: body.guest_external_id, accountId: user.id }).catch(
          (err) => {
            // The sign-in stands whether or not the guest's conversations came with it.
            console.error("[users] carrying a guest's conversations failed:", err instanceof Error ? err.message : err);
            return 0;
          }
        );
      }
      return reply.send({ user: serializeUser(user), ...(carried > 0 ? { carried_conversations: carried } : {}) });
    },
  });

  // GET /users/guest — whether this deployment offers guests on /ask, and
  // on what terms, for the page a signed-out visitor sees before their first
  // message (every bound is stated before it is met).
  app.get("/guest", {
    schema: {
      tags: ["users"],
      summary: "Whether visitors without an account may use the Assistant here, and on what terms",
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (_request, reply) =>
      reply.send({ offered: guestsOffered(), terms: guestTerms(), models: assistantModels(GUEST_EXTERNAL_ID_PREFIX) }),
  });

  // POST /users/guest — a guest account for a visitor on /ask with no
  // account (docs/accounts.md, "Guests"; src/services/guest-service.ts).
  // Service-only: the web tier calls it, naming the visitor's address,
  // which counts against the per-address bound and is not stored.
  app.post("/guest", {
    schema: {
      tags: ["users"],
      summary: "Make a guest account for a visitor on /ask, given the platform's guest owls",
      body: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const { address } = request.body as { address: string };
      const result = await makeGuestPass({ address });
      if (!result.ok) {
        return reply.code(result.code === "GUESTS_OFF" ? 403 : 429).send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({
        guest: { id: result.account.id, external_id: result.account.externalId, granted_owls: result.grantedOwls },
      });
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
