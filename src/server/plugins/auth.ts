/**
 * Request authentication (#70).
 *
 * Three ways a request can authenticate, tried in order:
 *
 *  1. DB-backed API key (x-api-key) — minted from the dashboard, stored
 *     hashed. Resolves to the owning user. scope='service' keys are trusted
 *     first-party keys (the web BFF) and may act ON BEHALF OF another user
 *     via the x-acting-user header (the dashboard session path).
 *
 *  2. Env-configured key (API_KEYS) — operator-provisioned bootstrap keys
 *     ("key" or "key:contributor_external_id" entries). Treated as service-
 *     trusted: they may also send x-acting-user. This is how the web
 *     frontend authenticates before any DB keys exist.
 *
 *  3. OAuth access token (Authorization: Bearer eoat_*) — issued by the
 *     OAuth flow for hosted MCP clients (Claude.ai connectors). Resolves to
 *     the consenting user, never service-trusted, and only accepted on the
 *     MCP surface (tokens are scoped 'mcp' — the capability set the consent
 *     page describes, not a general-purpose API credential).
 *
 *  4. Dev bypass — only when NO keys are configured AND env != production:
 *     acts as the fixed "dev:local" identity with service trust so the whole
 *     dashboard flow works locally with zero setup. In production a missing
 *     API_KEYS now fails closed (401) instead of leaving writes open.
 *
 * The resolved identity is exposed as request.auth; the legacy
 * request.contributorExternalId is kept in sync for existing routes.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../../config.js";
import { resolveApiKey } from "../../services/api-key-service.js";
import {
  isOAuthAccessToken,
  resolveAccessToken,
} from "../../services/oauth-service.js";
import {
  getContributorByExternalId,
  getOrCreateContributor,
} from "../../services/contributor-service.js";

export type AuthMethod = "api_key" | "env_key" | "oauth" | "dev_bypass";

export interface RequestAuth {
  method: AuthMethod;
  /** Acting account id (contributors.id); null when no user identity applies. */
  userId: string | null;
  /** DB key used to authenticate, when method === "api_key". */
  apiKeyId: string | null;
  /** Acting identity's external auth subject ("<provider>:<subject>"). */
  contributorExternalId: string | null;
  /** True for service-scope DB keys, env keys, and the dev bypass. */
  isService: boolean;
  /**
   * True when a service caller is acting on behalf of a signed-in user
   * (x-acting-user) — the "dashboard session" trust level required to manage
   * API keys, so a leaked consumer key can never mint or revoke keys.
   */
  isSession: boolean;
}

export const DEV_EXTERNAL_ID = "dev:local";

/**
 * Constant-time comparison of a presented operator key against the
 * configured one. False whenever no key is configured, whatever is
 * presented: the operator routes are closed, not open, by default.
 */
export function operatorKeyMatches(
  configured: string,
  presented: string | undefined
): boolean {
  if (!configured || !presented) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Direct trusted first-party caller: service scope with no acting-user
 * forwarding. The surfaces that can write claim content into the live graph
 * without review (POST /claims/propose, POST /sources) reserve their fast
 * path for these callers — internal seeding (corpus, FLF case studies) —
 * while everything else, including a service key acting on behalf of a
 * signed-in user (the web BFF path), is user traffic and goes through intake
 * review (#157).
 */
export function isDirectService(auth: RequestAuth | null): auth is RequestAuth {
  return auth?.isService === true && !auth.isSession;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest("contributorExternalId", null);
  app.decorateRequest("auth", null);

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const config = loadConfig();
      const envKeysConfigured =
        config.apiKeys.length > 0 && config.apiKeys[0] !== "";
      const presented = request.headers["x-api-key"] as string | undefined;

      // OAuth access tokens (hosted MCP clients) arrive as a Bearer header
      // and are recognizable by prefix — resolve them before the key paths.
      const authz = request.headers.authorization;
      const bearer = authz?.startsWith("Bearer ")
        ? authz.slice("Bearer ".length).trim()
        : undefined;

      let auth: RequestAuth | null = null;

      if (bearer && isOAuthAccessToken(bearer)) {
        const resolved = await resolveAccessToken(bearer);
        if (!resolved) {
          return reply
            .code(401)
            .send({ error: "Invalid or expired access token" });
        }
        if (resolved.user.isSuspended) {
          return reply.code(403).send({
            error: "Account suspended",
            code: "ACCOUNT_SUSPENDED",
          });
        }
        // Audience binding: an OAuth token is what the user consented to on
        // the consent page — the MCP surface — not a general-purpose API
        // credential. Tokens are scoped 'mcp' today; a broader scope would
        // have to be advertised, consented to, and checked here first.
        const scopes = (resolved.token.scope ?? "mcp").split(" ");
        const routePath = request.routeOptions.url ?? request.url;
        if (!routePath.startsWith("/mcp") && !scopes.includes("api")) {
          return reply
            .code(403)
            .header(
              "www-authenticate",
              'Bearer error="insufficient_scope", scope="mcp"'
            )
            .send({
              error:
                "This access token is scoped to the MCP endpoint (/mcp); use an API key for the REST API",
              code: "INSUFFICIENT_SCOPE",
            });
        }
        auth = {
          method: "oauth",
          userId: resolved.user.id,
          apiKeyId: null,
          contributorExternalId: resolved.user.externalId,
          isService: false,
          isSession: false,
        };
      } else if (presented) {
        // 1. DB-backed key
        const resolved = await resolveApiKey(presented);
        if (resolved) {
          if (resolved.user.isSuspended) {
            return reply.code(403).send({
              error: "Account suspended",
              code: "ACCOUNT_SUSPENDED",
            });
          }
          auth = {
            method: "api_key",
            userId: resolved.user.id,
            apiKeyId: resolved.key.id,
            contributorExternalId: resolved.user.externalId,
            isService: resolved.key.scope === "service",
            isSession: false,
          };
        } else if (envKeysConfigured && config.apiKeys.includes(presented)) {
          // 2. Env-configured operator key
          const boundExternalId =
            config.apiKeyContributors[presented] ?? null;
          auth = {
            method: "env_key",
            userId: null,
            apiKeyId: null,
            contributorExternalId: boundExternalId,
            isService: true,
            isSession: false,
          };
        } else {
          return reply
            .code(401)
            .send({ error: "Invalid or missing API key" });
        }
      } else if (!envKeysConfigured && config.env !== "production") {
        // 3. Dev bypass — keyless local development acts as a fixed local
        // account (created on first use) so the full dashboard flow — keys,
        // usage, provisioning — works with zero configuration.
        const devUser = await getOrCreateContributor({
          externalId: DEV_EXTERNAL_ID,
          displayName: "Local Developer",
        });
        auth = {
          method: "dev_bypass",
          userId: devUser.id,
          apiKeyId: null,
          contributorExternalId: DEV_EXTERNAL_ID,
          isService: true,
          isSession: false,
        };
      } else {
        return reply.code(401).send({ error: "Invalid or missing API key" });
      }

      // Act-on-behalf-of: only service-trusted callers may assert another
      // user's identity. This is how the web app's session reaches the API.
      const actingExternalId = request.headers["x-acting-user"] as
        | string
        | undefined;
      if (actingExternalId) {
        if (!auth.isService) {
          return reply.code(403).send({
            error: "This API key cannot act on behalf of a user",
            code: "ACTING_USER_FORBIDDEN",
          });
        }
        const actingUser = await getContributorByExternalId(actingExternalId);
        if (!actingUser) {
          return reply.code(401).send({
            error: "Unknown acting user (not provisioned)",
            code: "UNKNOWN_ACTING_USER",
          });
        }
        if (actingUser.isSuspended) {
          return reply
            .code(403)
            .send({ error: "Account suspended", code: "ACCOUNT_SUSPENDED" });
        }
        auth = {
          ...auth,
          userId: actingUser.id,
          contributorExternalId: actingUser.externalId,
          isSession: true,
        };
      }

      request.auth = auth;
      request.contributorExternalId = auth.contributorExternalId;
    }
  );

  // Route guard: trusted first-party callers only (env keys, service-scope
  // DB keys, dev bypass). Run AFTER app.authenticate.
  app.decorate(
    "requireService",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.auth?.isService) {
        return reply.code(403).send({
          error: "This endpoint requires a service-scoped key",
          code: "SERVICE_KEY_REQUIRED",
        });
      }
    }
  );

  // Route guard: a resolved user account (own key, bound env key resolved
  // upstream, or a session acting user). Run AFTER app.authenticate.
  app.decorate(
    "requireUser",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.auth?.userId) {
        return reply.code(403).send({
          error:
            "This endpoint requires a user identity (sign in, or use a key bound to your account)",
          code: "USER_IDENTITY_REQUIRED",
        });
      }
    }
  );

  // Route guard: the operator key (docs/mathematics.md §8.11). The four
  // routes that move prize money — the fund deposit, the bounty
  // confirmation, the prize-claim sign-off, and the void — require a
  // credential held outside the web deployment, presented as
  // x-operator-key, because the service key acts for any user through the
  // acting-user header and so cannot be the credential that moves money.
  // Runs on its own (the operator need not also present an API key); an
  // empty MINERVAL_OPERATOR_KEY keeps the routes closed. Compared in
  // constant time so the key's length and prefix never leak by timing.
  app.decorate(
    "requireOperator",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const config = loadConfig();
      const presented = request.headers["x-operator-key"];
      const key = Array.isArray(presented) ? presented[0] : presented;
      if (!operatorKeyMatches(config.minervalOperatorKey, key)) {
        return reply.code(403).send({
          error: "This endpoint requires the operator key",
          code: "OPERATOR_KEY_REQUIRED",
        });
      }
    }
  );

  // Route guard: dashboard-session trust — a service caller acting for a
  // signed-in user. API-key management requires this so a leaked consumer key
  // cannot mint new keys. Dev bypass counts as a session for local DX.
  app.decorate(
    "requireSession",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      const devSession = auth?.method === "dev_bypass" && auth.userId !== null;
      if (!auth?.isSession && !devSession) {
        return reply.code(403).send({
          error:
            "This operation is only available from a signed-in session (the dashboard)",
          code: "SESSION_REQUIRED",
        });
      }
    }
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireOperator: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    requireService: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    requireUser: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    requireSession: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
  interface FastifyRequest {
    contributorExternalId: string | null;
    auth: RequestAuth | null;
  }
}
