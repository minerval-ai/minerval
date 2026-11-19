/**
 * minerval.ai as an OpenID Connect provider for organizations
 * (services/oidc-provider.ts; docs/organizations.md, "Signing in"). The
 * protocol's own routes under /oidc, which a deployment's sign-in calls and
 * no agent does, and the organization's admins' routes for registering a
 * deployment as a client.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { loadConfig } from "../config.js";
import { OrganizationError } from "../services/organization-service.js";
import {
  OidcError,
  approveAuthorization,
  beginAuthorization,
  clientCredentials,
  denyAuthorization,
  discovery,
  exchangeCode,
  jwks,
  listOidcClients,
  makeOidcClient,
  readAuthorization,
  revokeOidcClient,
  userinfo,
} from "../services/oidc-provider.js";

const TAGS = ["oidc"];

function oidcRefused(reply: FastifyReply, err: unknown) {
  if (err instanceof OidcError) {
    if (err.status === 401 && err.code === "invalid_token") reply.header("www-authenticate", `Bearer error="invalid_token"`);
    return reply.code(err.status).header("cache-control", "no-store").send({ error: err.code, error_description: err.message });
  }
  throw err;
}

async function answer<T>(reply: FastifyReply, fn: () => Promise<T>, status = 200): Promise<FastifyReply> {
  try {
    return reply.code(status).send(await fn());
  } catch (err) {
    if (err instanceof OrganizationError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof OidcError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  }
}

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  const reader = [app.authenticate, app.requireUser];
  const session = [app.authenticate, app.requireSession, app.requireUser];
  const me = (request: { auth: { userId: string | null } | null }) => request.auth!.userId!;

  // ---- the protocol ----

  app.get("/oidc/.well-known/openid-configuration", { schema: { hide: true } }, async (_request, reply) => {
    try {
      return reply.header("access-control-allow-origin", "*").header("cache-control", "public, max-age=3600").send(discovery());
    } catch (err) {
      return oidcRefused(reply, err);
    }
  });

  app.get("/oidc/jwks", { schema: { hide: true } }, async (_request, reply) => {
    try {
      return reply.header("access-control-allow-origin", "*").header("cache-control", "public, max-age=3600").send(jwks());
    } catch (err) {
      return oidcRefused(reply, err);
    }
  });

  app.get("/oidc/authorize", {
    schema: {
      tags: TAGS,
      summary: "Authorization endpoint: a deployment sends a person here to sign in with their minerval.ai account (redirects to the consent page)",
    },
    handler: async (request, reply) => {
      try {
        const { request_id } = await beginAuthorization(request.query as Record<string, string | undefined>);
        const consent = new URL("/oidc/consent", loadConfig().publicWebBaseUrl.replace(/\/$/, "") + "/");
        consent.searchParams.set("request_id", request_id);
        return reply.redirect(consent.toString(), 302);
      } catch (err) {
        return oidcRefused(reply, err);
      }
    },
  });

  app.post("/oidc/token", {
    schema: { tags: TAGS, summary: "Token endpoint: a deployment exchanges a code for an ID token naming the person, their organization and role" },
    handler: async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const tokens = await exchangeCode({
          credentials: clientCredentials(request.headers.authorization, body),
          grantType: body.grant_type,
          code: body.code,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
        });
        return reply.header("cache-control", "no-store").header("pragma", "no-cache").send(tokens);
      } catch (err) {
        return oidcRefused(reply, err);
      }
    },
  });

  app.get("/oidc/userinfo", {
    schema: { tags: TAGS, summary: "UserInfo endpoint: the person an access token is for, read again now" },
    handler: async (request, reply) => {
      try {
        return reply.header("cache-control", "no-store").send(await userinfo(request.headers.authorization));
      } catch (err) {
        return oidcRefused(reply, err);
      }
    },
  });

  app.get<{ Params: { request_id: string } }>("/oidc/requests/:request_id", {
    schema: {
      tags: TAGS,
      summary: "A sign-in waiting for the person: which deployment asks, for which organization, and whether they are a member of it",
      params: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, () => readAuthorization(request.params.request_id, me(request))),
  });

  app.post<{ Params: { request_id: string } }>("/oidc/requests/:request_id/approve", {
    schema: {
      tags: TAGS,
      summary: "Sign in to an organization's deployment as yourself (a live member of it only): answers where to send you back, with a code",
      params: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) => answer(reply, () => approveAuthorization(request.params.request_id, me(request))),
  });

  app.post<{ Params: { request_id: string } }>("/oidc/requests/:request_id/deny", {
    schema: {
      tags: TAGS,
      summary: "Decline to sign in to a deployment: answers where to send you back, saying so",
      params: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) => answer(reply, () => denyAuthorization(request.params.request_id)),
  });

  // ---- an organization's clients ----

  app.get<{ Params: { id: string } }>("/organizations/:id/oidc-clients", {
    schema: {
      tags: ["organizations"],
      summary:
        "The sign-in clients an organization registered for its deployments (its members): each deployment that signs its members in " +
        "with their minerval.ai accounts, where it sends them back, and when it was last used. Never the secrets",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ clients: await listOidcClients(request.params.id, me(request)) })),
  });

  app.post<{ Params: { id: string }; Body: { name: string; redirect_uris: string[] | string } }>("/organizations/:id/oidc-clients", {
    schema: {
      tags: ["organizations"],
      summary:
        "Register a deployment of the organization to sign its members in with their minerval.ai accounts (its admins, from a signed-in " +
        "session). Answers the client id, its secret once, and the issuer to set as AUTH_OIDC_ISSUER",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: {
        type: "object",
        required: ["name", "redirect_uris"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          redirect_uris: { anyOf: [{ type: "array", items: { type: "string" }, minItems: 1 }, { type: "string", minLength: 1 }] },
        },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(
        reply,
        async () => ({
          client: await makeOidcClient({ organizationId: request.params.id, name: request.body.name, redirectUris: request.body.redirect_uris, by: me(request) }),
        }),
        201
      ),
  });

  app.delete<{ Params: { id: string; client_id: string } }>("/organizations/:id/oidc-clients/:client_id", {
    schema: {
      tags: ["organizations"],
      summary: "Revoke a sign-in client (its admins, from a signed-in session): no one signs in to that deployment through minerval.ai again",
      params: { type: "object", required: ["id", "client_id"], properties: { id: { type: "string" }, client_id: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await revokeOidcClient({ organizationId: request.params.id, id: request.params.client_id, by: me(request) });
        return { revoked: true };
      }),
  });
}
