/**
 * Request authentication (#70).
 *
 * Three ways a request can authenticate, tried in order:
 *
 *  1. DB-backed API key (x-api-key) — minted from the dashboard, stored
 *     hashed. Resolves to the owning user. scope='service' keys are trusted
 *     first-party keys (the web BFF) and may act ON BEHALF OF another user
 *     via the x-acting-user header (the dashboard session path), never on
 *     behalf of the platform account. scope='platform_grantmaking' keys
 *     resolve to the platform account and are accepted only on the
 *     granting-conversation routes, never /fund (#529).
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
 *     An MCP tool that dispatches in-process to a REST route (src/mcp/
 *     dispatch.ts) carries the /mcp request's resolved identity across under
 *     a single-use nonce; that is how the token reaches the routes MCP
 *     exposes, without the token itself being accepted off /mcp.
 *
 *  4. Dev bypass — only when NO keys are configured AND env != production:
 *     acts as the fixed "dev:local" identity with service trust so the whole
 *     dashboard flow works locally with zero setup. In production a missing
 *     API_KEYS now fails closed (401) instead of leaving writes open.
 *
 * The resolved identity is exposed as request.auth; the legacy
 * request.contributorExternalId is kept in sync for existing routes.
 *
 * In a members-only deployment (src/permissions.ts) one hook authenticates
 * every request before its route's own guards run
 * (plugins/members-only.ts), and adds the request's standing: what it may
 * do and read. A route's `app.authenticate` then finds the work done and
 * returns. The dev bypass does not exist there: nothing is served to a
 * request that presents no credential, whatever the environment.
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
import {
  PLATFORM_EXTERNAL_ID,
  PLATFORM_GRANTMAKING_SCOPE,
} from "../../services/platform-account.js";
import {
  MCP_DISPATCH_HEADER,
  resolveDispatchedAuth,
} from "../../mcp/dispatch.js";
import { membersOnly, type Standing } from "../../permissions.js";
import type { DeploymentGrant, MemberPermission } from "../../db/schema.js";
import { deploymentNeeds, memberMayCall } from "../organization-routes.js";
import { deploymentByKey, logDeploymentRequest, recordNonce } from "../../services/deployment-service.js";
import {
  EMPTY_BODY_HASH,
  SIGNATURE_FAULT_WORDS,
  checkSignature,
  isSignedRequest,
  parseSignatureHeader,
} from "../../services/request-signature.js";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import {
  actingStandingOf,
  isOrganizationExternalId,
  logActedAs,
  memberStanding,
} from "../../services/organization-service.js";

export type AuthMethod = "api_key" | "env_key" | "oauth" | "dev_bypass" | "deployment";

/**
 * The one label a credential works at (server/request-labels.ts), and what
 * kind of credential it is, for the sentence a refusal says.
 */
export interface FixedLabel {
  label: string;
  of: "API key" | "access token" | "Assistant conversation";
}

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
  /**
   * What the request may do and read (src/permissions.ts): the grants that
   * reach its account and the clearance they add up to. Resolved once, when
   * the request arrives, in a members-only deployment. Absent on the public
   * graph, where nobody holds a grant; read it with standingOf, which
   * answers the public standing for a request that carries none.
   */
  standing?: Standing;
  /**
   * Set when the request came with a credential an agent can hold: an API
   * key, an access token, or the Assistant acting in one conversation. Such
   * a credential works at one label, fixed by the person when it was made:
   * the request reads what that label reads, within what the person may
   * read, and writes at that label and no other. Absent for a signed-in
   * session, where each request that writes gets its label from the row it
   * is about or from the person (server/plugins/request-label.ts), and
   * absent on the public graph.
   */
  fixedLabel?: FixedLabel;
  /**
   * Set when a signed-in person acts as an organization
   * (x-acting-organization; docs/organizations.md, "Acting as the
   * organization"). The request is the organization's (userId is the
   * organization's account); this is the person, whom the organization's
   * log names.
   */
  actingMember?: { accountId: string; externalId: string | null };
  /**
   * For a credential made to act as an organization (the Assistant in a
   * conversation started as it): the person's role and permissions there
   * when the credential was opened, and the organization's name, which say
   * what tools it is offered (mcp/route-tools.ts). Every request it makes is
   * checked again against their standing as it is then.
   */
  actingStanding?: {
    organizationName: string;
    role: "admin" | "member";
    permissions: MemberPermission[];
    /** What is left of the person's allowance on spend there, where an admin set one. */
    allowanceLeftMicroUsd?: number;
  };
  /**
   * Set for a request signed by a connected deployment's key
   * (docs/organizations.md, "Signed requests"). The request is its
   * organization's (userId); this is the deployment and its live grants.
   */
  deployment?: { id: string; grants: DeploymentGrant[] };
}

/**
 * Requests the members-only hook has already authenticated. `authenticate`
 * returns at once for one of these, so a route's own preHandler neither
 * repeats the lookups nor replaces the identity the hook resolved, standing
 * included. Always empty on the public graph.
 */
const alreadyAuthenticated = new WeakSet<FastifyRequest>();

export function markAuthenticated(request: FastifyRequest): void {
  alreadyAuthenticated.add(request);
}

export const DEV_EXTERNAL_ID = "dev:local";

/**
 * The header with which the web tier says a signed-in person is acting as an
 * organization. What they may do as it is src/server/organization-routes.ts.
 */
export const ACTING_ORGANIZATION_HEADER = "x-acting-organization";

/**
 * The routes a platform-grantmaking key may call (#529): open, continue,
 * list, and read the platform's granting conversations. Never `/fund`:
 * the platform's money moves only through the operator route.
 */
export function platformGrantmakingRouteAllowed(
  method: string,
  routePath: string
): boolean {
  const path = routePath.split("?")[0]!;
  if (path !== "/grant-conversations" && !path.startsWith("/grant-conversations/")) {
    return false;
  }
  if (method === "POST" && /\/fund\/?$/.test(path)) return false;
  return true;
}

function routeKeyOf(request: FastifyRequest): string {
  const url = request.routeOptions.url ?? request.url.split("?")[0]!;
  return `${request.method} ${url}`;
}

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

/**
 * Whether the request presents a credential at all: an API key, a Bearer
 * token, or an in-process MCP dispatch. Routes whose reads are open but
 * whose answer depends on who asks authenticate only when this holds.
 */
export function presentsCredentials(request: FastifyRequest): boolean {
  return Boolean(
    request.headers["x-api-key"] ||
      request.headers.authorization ||
      request.headers[MCP_DISPATCH_HEADER]
  );
}

/**
 * The sha-256 of a signed request's body as it arrived, taken while the body
 * is read (the preParsing hook below), before it is parsed. A request with
 * no body has none here, and is checked against the hash of nothing.
 */
const signedBodyHash = new WeakMap<FastifyRequest, string>();

/** The MCP transport's own routes: each tool call through it is a request of its own, checked as one. */
const MCP_TRANSPORT = new Set(["POST /mcp", "GET /mcp", "DELETE /mcp"]);

/**
 * A key or token made to act as an organization (docs/organizations.md,
 * "Other credentials"): the request is the organization's, as the person
 * acting as it, under their standing there as it is now. A refusal where
 * they no longer may, or may not do this.
 */
async function asCredentialFor(
  auth: RequestAuth,
  actingFor: string,
  route: string,
  method: string
): Promise<{ auth: RequestAuth } | { status: number; body: Record<string, unknown> }> {
  const person = auth.userId!;
  const standing = await actingStandingOf(actingFor, person);
  if (!standing || (standing.role !== "admin" && standing.permissions.length === 0)) {
    return {
      status: 403,
      body: {
        error: "This credential was made to act as an organization its person can no longer act as. Make a new one.",
        code: "CREDENTIAL_ORGANIZATION_LEFT",
      },
    };
  }
  if (!MCP_TRANSPORT.has(route)) {
    const check = memberMayCall(route, method, standing);
    if (!check.ok) {
      return {
        status: 403,
        body: {
          error:
            check.code === "PERMISSION_NOT_HELD"
              ? `Acting as ${standing.organizationName}, ${check.reason.charAt(0).toLowerCase()}${check.reason.slice(1)} An admin of it grants that on its Members tab.`
              : check.reason,
          code: check.code,
          ...(check.permission ? { permission: check.permission } : {}),
        },
      };
    }
  }
  return {
    auth: {
      ...auth,
      userId: actingFor,
      contributorExternalId: `org:${actingFor}`,
      actingMember: { accountId: person, externalId: auth.contributorExternalId },
      actingStanding: standing,
    },
  };
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest("contributorExternalId", null);
  app.decorateRequest("auth", null);

  // Hash the raw body of a deployment's signed request as it streams in, so
  // the signature can be checked against the bytes that were signed.
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!isSignedRequest(request.headers.authorization)) return payload;
    const hash = createHash("sha256");
    const pass = new Transform({
      transform(chunk, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
      flush(done) {
        signedBodyHash.set(request, hash.digest("hex"));
        done();
      },
    });
    return payload.pipe(pass);
  });

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (alreadyAuthenticated.has(request)) return;
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

      // An MCP tool dispatched in-process to this route (src/mcp/dispatch.ts):
      // the /mcp request already authenticated, so its identity is carried
      // over as resolved, OAuth tokens included — the token was presented to
      // /mcp, the surface it is bound to. An unknown nonce is refused.
      const dispatchNonce = request.headers[MCP_DISPATCH_HEADER];
      if (dispatchNonce !== undefined) {
        const dispatched =
          typeof dispatchNonce === "string"
            ? resolveDispatchedAuth(dispatchNonce)
            : null;
        if (!dispatched) {
          return reply.code(401).send({ error: "Invalid or missing API key" });
        }
        // A tool call made as an organization is checked here as the request
        // the person would make themselves: they are a member now, and hold
        // what this route needs (docs/organizations.md, "Acting as the
        // organization"). The tools offered were chosen when the run began;
        // a permission withdrawn since is refused here.
        if (dispatched.actingMember && dispatched.userId) {
          const standing = await memberStanding(dispatched.userId, dispatched.actingMember.accountId);
          const check = standing
            ? memberMayCall(routeKeyOf(request), request.method, standing)
            : ({ ok: false, code: "NOT_A_MEMBER", reason: "Your user is no longer a member of the organization this conversation acts for." } as const);
          if (!check.ok) {
            return reply.code(403).send({
              error:
                check.code === "PERMISSION_NOT_HELD"
                  ? `Acting as this organization, ${check.reason.charAt(0).toLowerCase()}${check.reason.slice(1)} An admin of it grants that on its Members tab.`
                  : check.reason,
              code: check.code,
              ...("permission" in check && check.permission ? { permission: check.permission } : {}),
            });
          }
        }
        request.auth = dispatched;
        request.contributorExternalId = dispatched.contributorExternalId;
        return;
      }

      // A connected deployment, signing with its own key
      // (docs/organizations.md, "Signed requests"): the request is its
      // organization's, on the routes its grants open and no others.
      if (isSignedRequest(authz)) {
        const presented = parseSignatureHeader(authz!);
        if (!presented) {
          return reply.code(401).send({ error: SIGNATURE_FAULT_WORDS.MALFORMED, code: "SIGNATURE_MALFORMED" });
        }
        const deployment = await deploymentByKey(presented.keyId);
        if (!deployment) {
          return reply.code(401).send({
            error: "No connected deployment has this key. It may have been retired or never approved; connect it again.",
            code: "DEPLOYMENT_NOT_CONNECTED",
          });
        }
        const fault = checkSignature(presented, deployment.public_key, {
          host: String(request.headers.host ?? ""),
          method: request.method,
          path: request.url,
          bodyHash: signedBodyHash.get(request) ?? EMPTY_BODY_HASH,
        });
        if (fault) {
          return reply.code(401).send({ error: SIGNATURE_FAULT_WORDS[fault], code: `SIGNATURE_${fault}` });
        }
        const route = routeKeyOf(request);
        const needed = deploymentNeeds(route);
        if (!needed) {
          return reply.code(403).send({
            error: "A connected deployment may not call this route. What it may call is the routes its grants open.",
            code: "NOT_A_DEPLOYMENT_ROUTE",
          });
        }
        const holds = needed === "any" ? deployment.grants.length > 0 : needed.some((g) => deployment.grants.includes(g));
        if (!holds) {
          const words = needed === "any" ? "any grant" : needed.join(" or ");
          return reply.code(403).send({
            error: `This deployment does not hold ${words}. An admin of ${deployment.organization_name} gives it on minerval.ai.`,
            code: "GRANT_NOT_HELD",
            grant: needed === "any" ? "any" : needed[0],
          });
        }
        // A write may be made once: its nonce is refused if seen with this key lately.
        if (request.method !== "GET" && !(await recordNonce(presented.keyId, presented.nonce))) {
          return reply.code(401).send({ error: "This signed request has been made already.", code: "SIGNATURE_REPLAYED" });
        }
        auth = {
          method: "deployment",
          userId: deployment.organization_id,
          apiKeyId: null,
          contributorExternalId: deployment.organization_external_id,
          isService: false,
          isSession: false,
          deployment: { id: deployment.id, grants: deployment.grants },
        };
      } else if (bearer && isOAuthAccessToken(bearer)) {
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
          ...(membersOnly(config)
            ? { fixedLabel: { label: resolved.token.workLabel, of: "access token" as const } }
            : {}),
        };
        if (resolved.token.actingFor) {
          const acted = await asCredentialFor(auth, resolved.token.actingFor, routeKeyOf(request), request.method);
          if ("status" in acted) return reply.code(acted.status).send(acted.body);
          auth = acted.auth;
        }
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
          // A platform-grantmaking key holds the platform's granting
          // conversations and nothing else (#529): it is refused on every
          // other route, and on /fund, because the platform's money moves
          // only through the operator route that a public approval pins.
          if (
            resolved.key.scope === PLATFORM_GRANTMAKING_SCOPE &&
            !platformGrantmakingRouteAllowed(
              request.method,
              request.routeOptions.url ?? request.url
            )
          ) {
            return reply.code(403).send({
              error:
                "This key holds the platform's granting conversations and " +
                "is accepted only on /grant-conversations (never /fund)",
              code: "KEY_SCOPE_PLATFORM_GRANTMAKING",
            });
          }
          auth = {
            method: "api_key",
            userId: resolved.user.id,
            apiKeyId: resolved.key.id,
            contributorExternalId: resolved.user.externalId,
            isService: resolved.key.scope === "service",
            isSession: false,
            ...(membersOnly(config)
              ? { fixedLabel: { label: resolved.key.workLabel, of: "API key" as const } }
              : {}),
          };
          if (resolved.key.actingFor) {
            const acted = await asCredentialFor(auth, resolved.key.actingFor, routeKeyOf(request), request.method);
            if ("status" in acted) return reply.code(acted.status).send(acted.body);
            auth = acted.auth;
          }
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
      } else if (!envKeysConfigured && config.env !== "production" && !membersOnly(config)) {
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
        // Nobody acts as the platform through this header (#529): it is how
        // the web tier reaches the API for a signed-in person, and the
        // platform signs in nowhere. Its agency runs through the
        // platform-grantmaking key and the operator key alone.
        if (actingExternalId === PLATFORM_EXTERNAL_ID) {
          return reply.code(403).send({
            error: "The platform account cannot be acted for",
            code: "PLATFORM_NOT_ACTABLE",
          });
        }
        // Nor as an organization: nobody signs in as one. An admin acts for
        // it as themselves, with x-acting-organization below.
        if (isOrganizationExternalId(actingExternalId)) {
          return reply.code(403).send({
            error: "An organization is not signed in as. Its admins act for it as themselves.",
            code: "ORGANIZATION_NOT_ACTABLE",
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
        // A session is the person, not the key the web tier presented for
        // them: it has no fixed label, and says or derives one per request.
        const { fixedLabel: _ofTheServiceKey, ...withoutFixedLabel } = auth;
        auth = {
          ...withoutFixedLabel,
          userId: actingUser.id,
          contributorExternalId: actingUser.externalId,
          isSession: true,
        };
      }

      // A person acting as an organization (docs/organizations.md, "Acting
      // as the organization"): signed in, a live member of it right now, on
      // a route its map opens to members, holding the permission the route
      // needs (an admin holds them all). The request then is the
      // organization's.
      const actingOrganization = request.headers[ACTING_ORGANIZATION_HEADER];
      if (actingOrganization !== undefined) {
        const devSession = auth.method === "dev_bypass" && auth.userId !== null;
        if (!auth.isSession && !devSession) {
          return reply.code(403).send({
            error: "Only a person in a signed-in session acts as an organization",
            code: "ORGANIZATION_SESSION_REQUIRED",
          });
        }
        const organizationId = typeof actingOrganization === "string" ? actingOrganization : "";
        const standing = auth.userId ? await memberStanding(organizationId, auth.userId) : null;
        if (!standing) {
          return reply.code(403).send({
            error: "You are not a member of that organization, so you cannot act as it.",
            code: "NOT_A_MEMBER",
          });
        }
        const check = memberMayCall(routeKeyOf(request), request.method, standing);
        if (!check.ok) {
          return reply.code(403).send({
            error:
              check.code === "PERMISSION_NOT_HELD"
                ? `Acting as this organization, ${check.reason.charAt(0).toLowerCase()}${check.reason.slice(1)} An admin of it grants that on its Members tab.`
                : check.reason,
            code: check.code,
            ...(check.permission ? { permission: check.permission } : {}),
          });
        }
        const person = { accountId: auth.userId!, externalId: auth.contributorExternalId };
        auth = {
          ...auth,
          userId: organizationId,
          contributorExternalId: `org:${organizationId}`,
          actingMember: person,
        };
      }

      request.auth = auth;
      request.contributorExternalId = auth.contributorExternalId;
    }
  );

  // Every act a person made as an organization is on the organization's
  // log, with the route and what the API answered. Reads are not logged.
  app.addHook("onResponse", async (request, reply) => {
    // Every write a deployment signed is on its organization's record of them.
    const deployment = request.auth?.deployment;
    if (deployment && request.method !== "GET") {
      try {
        await logDeploymentRequest({
          deploymentId: deployment.id,
          method: request.method,
          route: request.routeOptions.url ?? request.url,
          status: reply.statusCode,
        });
      } catch (err) {
        request.log.error({ err }, "deployment requests: could not record a signed write");
      }
    }
    const acting = request.auth?.actingMember;
    if (!acting || request.method === "GET" || !request.auth?.userId) return;
    // The MCP transport carries tool calls, each logged as the request it makes.
    if (MCP_TRANSPORT.has(routeKeyOf(request))) return;
    const a = request.auth;
    // How the act was made (docs/organizations.md, "The record"): in a page,
    // by the Assistant (its calls carry no key of their own), by a key, or by
    // an MCP client.
    const how =
      a.isSession || a.method === "dev_bypass"
        ? "page"
        : a.method === "oauth"
          ? "mcp_client"
          : a.method === "api_key" && a.apiKeyId
            ? "api_key"
            : a.fixedLabel?.of === "Assistant conversation" || a.method === "api_key"
              ? "assistant"
              : a.method;
    try {
      await logActedAs({
        organizationId: request.auth.userId,
        actorId: acting.accountId,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: reply.statusCode,
        how,
        ...(a.apiKeyId ? { apiKeyId: a.apiKeyId } : {}),
      });
    } catch (err) {
      request.log.error({ err }, "organization log: could not record an act made for an organization");
    }
  });

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
