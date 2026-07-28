/**
 * OAuth 2.1 endpoints for the remote MCP server (#73 follow-up).
 *
 * The shape the MCP authorization spec expects of a resource+authorization
 * server:
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 — points
 *        clients at the authorization server (us).
 *   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414 metadata.
 *   POST /oauth/register    RFC 7591 dynamic client registration (public).
 *   GET  /oauth/authorize   validates the request, parks it, and sends the
 *        browser to the web frontend's consent page — the API has no session
 *        of its own (#70: web owns login).
 *   POST /oauth/token       authorization_code + refresh_token grants.
 *
 * Plus the consent page's back-channel (service/session trust, like the
 * dashboard API-key endpoints):
 *
 *   GET  /oauth/requests/:request_id          what the user is approving
 *   POST /oauth/requests/:request_id/approve  mint code, get redirect URL
 *   POST /oauth/requests/:request_id/deny
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { loadConfig } from "../config.js";
import {
  approveAuthorizationRequest,
  createAuthorizationRequest,
  denyAuthorizationRequest,
  exchangeAuthorizationCode,
  getAuthorizationRequest,
  getClientByClientId,
  hashToken,
  OAuthTokenError,
  registerClient,
  refreshAccessToken,
  SUPPORTED_AUTH_METHODS,
  type OAuthClient,
  type TokenEndpointAuthMethod,
} from "../services/oauth-service.js";

const SCOPES_SUPPORTED = ["mcp"];

// Redirect URIs must be https, except loopback hosts for local development
// (RFC 8252 §7.3).
function isAcceptableRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

function tokenError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string
): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send({ error, error_description: description });
}

/**
 * Resolve and authenticate the client at the token endpoint: HTTP Basic or
 * body credentials for confidential clients; bare client_id for public
 * clients (whose proof is PKCE).
 */
async function authenticateClient(
  body: Record<string, unknown>,
  authorizationHeader: string | undefined
): Promise<OAuthClient | null> {
  let clientId = typeof body.client_id === "string" ? body.client_id : "";
  let clientSecret =
    typeof body.client_secret === "string" ? body.client_secret : "";

  if (authorizationHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(
      authorizationHeader.slice("Basic ".length),
      "base64"
    ).toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    clientId = decodeURIComponent(decoded.slice(0, sep));
    clientSecret = decodeURIComponent(decoded.slice(sep + 1));
  }

  if (!clientId) return null;
  const client = await getClientByClientId(clientId);
  if (!client) return null;

  if (client.tokenEndpointAuthMethod === "none") {
    return client;
  }
  if (!clientSecret || !client.clientSecretHash) return null;
  return hashToken(clientSecret) === client.clientSecretHash ? client : null;
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const issuer = config.publicApiBaseUrl.replace(/\/$/, "");

  // --- discovery metadata (public, cacheable, CORS-readable) ----------------

  const authServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...SUPPORTED_AUTH_METHODS],
    scopes_supported: SCOPES_SUPPORTED,
    service_documentation: `${config.publicWebBaseUrl.replace(/\/$/, "")}/docs`,
  };

  const protectedResourceMetadata = {
    resource: `${issuer}/mcp`,
    resource_name: "Minerval claim graph",
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES_SUPPORTED,
  };

  const serveMetadata =
    (payload: Record<string, unknown>) =>
    async (_request: unknown, reply: FastifyReply) =>
      reply
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=3600")
        .send(payload);

  // Clients derive the well-known path from the resource URL two ways: bare
  // (issuer-level) and path-suffixed (resource-level). Serve both.
  for (const suffix of ["", "/mcp"]) {
    app.get(
      `/.well-known/oauth-authorization-server${suffix}`,
      { schema: { hide: true } },
      serveMetadata(authServerMetadata)
    );
    app.get(
      `/.well-known/oauth-protected-resource${suffix}`,
      { schema: { hide: true } },
      serveMetadata(protectedResourceMetadata)
    );
  }

  // --- dynamic client registration (RFC 7591) --------------------------------

  app.post("/oauth/register", {
    schema: {
      tags: ["oauth"],
      summary: "Dynamic client registration (RFC 7591)",
      body: {
        type: "object",
        required: ["redirect_uris"],
        properties: {
          redirect_uris: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 10,
          },
          client_name: { type: "string", maxLength: 200 },
          token_endpoint_auth_method: { type: "string" },
          grant_types: { type: "array", items: { type: "string" } },
          response_types: { type: "array", items: { type: "string" } },
          logo_uri: { type: "string", maxLength: 2000 },
          client_uri: { type: "string", maxLength: 2000 },
          scope: { type: "string", maxLength: 200 },
        },
      },
    },
    handler: async (request, reply) => {
      const body = request.body as {
        redirect_uris: string[];
        client_name?: string;
        token_endpoint_auth_method?: string;
        grant_types?: string[];
        response_types?: string[];
        logo_uri?: string;
        client_uri?: string;
        scope?: string;
      };

      if (!body.redirect_uris.every(isAcceptableRedirectUri)) {
        return reply.code(400).send({
          error: "invalid_redirect_uri",
          error_description:
            "redirect_uris must be https URLs (or http on localhost)",
        });
      }
      const authMethod = (body.token_endpoint_auth_method ??
        "client_secret_basic") as TokenEndpointAuthMethod;
      if (!SUPPORTED_AUTH_METHODS.includes(authMethod)) {
        return reply.code(400).send({
          error: "invalid_client_metadata",
          error_description: `token_endpoint_auth_method must be one of: ${SUPPORTED_AUTH_METHODS.join(", ")}`,
        });
      }
      const unsupportedGrant = body.grant_types?.find(
        (g) => !["authorization_code", "refresh_token"].includes(g)
      );
      if (unsupportedGrant) {
        return reply.code(400).send({
          error: "invalid_client_metadata",
          error_description: `unsupported grant type: ${unsupportedGrant}`,
        });
      }

      const { client, clientSecret } = await registerClient({
        name: body.client_name?.trim() || "Unnamed MCP client",
        redirectUris: body.redirect_uris,
        tokenEndpointAuthMethod: authMethod,
        logoUri: body.logo_uri,
        clientUri: body.client_uri,
      });
      return reply
        .code(201)
        .header("access-control-allow-origin", "*")
        .send({
          client_id: client.clientId,
          ...(clientSecret
            ? { client_secret: clientSecret, client_secret_expires_at: 0 }
            : {}),
          client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: SCOPES_SUPPORTED.join(" "),
        });
    },
  });

  // --- authorization endpoint -------------------------------------------------

  app.get("/oauth/authorize", {
    schema: {
      tags: ["oauth"],
      summary: "Authorization endpoint (redirects to the consent page)",
      querystring: {
        type: "object",
        properties: {
          client_id: { type: "string" },
          redirect_uri: { type: "string" },
          response_type: { type: "string" },
          scope: { type: "string" },
          state: { type: "string" },
          code_challenge: { type: "string" },
          code_challenge_method: { type: "string" },
          resource: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;

      // Client/redirect_uri failures MUST NOT redirect (open-redirect risk);
      // everything after that redirects back to the client per RFC 6749 §4.1.2.1.
      const client = q.client_id
        ? await getClientByClientId(q.client_id)
        : null;
      if (!client) {
        return reply
          .code(400)
          .send({ error: "invalid_request", error_description: "Unknown client_id" });
      }
      if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
        return reply.code(400).send({
          error: "invalid_request",
          error_description: "redirect_uri is not registered for this client",
        });
      }

      const redirectError = (error: string, description: string) => {
        const url = new URL(q.redirect_uri!);
        url.searchParams.set("error", error);
        url.searchParams.set("error_description", description);
        if (q.state) url.searchParams.set("state", q.state);
        return reply.redirect(url.toString(), 302);
      };

      if (q.response_type !== "code") {
        return redirectError(
          "unsupported_response_type",
          "Only response_type=code is supported"
        );
      }
      // PKCE is mandatory (OAuth 2.1 / MCP spec), S256 only.
      if (!q.code_challenge) {
        return redirectError("invalid_request", "code_challenge is required");
      }
      if ((q.code_challenge_method ?? "plain") !== "S256") {
        return redirectError(
          "invalid_request",
          "code_challenge_method must be S256"
        );
      }
      const unknownScope = q.scope
        ?.split(" ")
        .filter(Boolean)
        .find((s) => !SCOPES_SUPPORTED.includes(s));
      if (unknownScope) {
        return redirectError("invalid_scope", `Unknown scope: ${unknownScope}`);
      }

      const authRequest = await createAuthorizationRequest({
        client,
        redirectUri: q.redirect_uri,
        scope: q.scope ?? null,
        state: q.state ?? null,
        codeChallenge: q.code_challenge,
        resource: q.resource ?? null,
      });

      const consent = new URL(
        "/oauth/consent",
        config.publicWebBaseUrl.replace(/\/$/, "") + "/"
      );
      consent.searchParams.set("request_id", authRequest.id);
      return reply.redirect(consent.toString(), 302);
    },
  });

  // --- token endpoint ----------------------------------------------------------

  app.post("/oauth/token", {
    schema: {
      tags: ["oauth"],
      summary: "Token endpoint (authorization_code and refresh_token grants)",
    },
    handler: async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const client = await authenticateClient(
        body,
        request.headers.authorization
      );
      if (!client) {
        return reply
          .code(401)
          .header("www-authenticate", 'Basic realm="oauth"')
          .header("cache-control", "no-store")
          .send({
            error: "invalid_client",
            error_description: "Client authentication failed",
          });
      }

      try {
        switch (body.grant_type) {
          case "authorization_code": {
            if (
              typeof body.code !== "string" ||
              typeof body.redirect_uri !== "string" ||
              typeof body.code_verifier !== "string"
            ) {
              return tokenError(
                reply,
                400,
                "invalid_request",
                "code, redirect_uri, and code_verifier are required"
              );
            }
            const tokens = await exchangeAuthorizationCode({
              code: body.code,
              client,
              redirectUri: body.redirect_uri,
              codeVerifier: body.code_verifier,
            });
            return sendTokens(reply, tokens);
          }
          case "refresh_token": {
            if (typeof body.refresh_token !== "string") {
              return tokenError(
                reply,
                400,
                "invalid_request",
                "refresh_token is required"
              );
            }
            const tokens = await refreshAccessToken({
              refreshToken: body.refresh_token,
              client,
            });
            return sendTokens(reply, tokens);
          }
          default:
            return tokenError(
              reply,
              400,
              "unsupported_grant_type",
              "grant_type must be authorization_code or refresh_token"
            );
        }
      } catch (err) {
        if (err instanceof OAuthTokenError) {
          return tokenError(reply, 400, err.code, err.message);
        }
        throw err;
      }
    },
  });

  function sendTokens(
    reply: FastifyReply,
    tokens: {
      accessToken: string;
      refreshToken: string;
      expiresInSeconds: number;
      scope: string | null;
    }
  ): FastifyReply {
    return reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
  }

  // --- consent back-channel (web frontend only) --------------------------------

  // GET /oauth/requests/:request_id — what the consent page renders.
  app.get("/oauth/requests/:request_id", {
    schema: {
      tags: ["oauth"],
      summary: "Inspect a pending authorization request (consent page)",
      params: {
        type: "object",
        required: ["request_id"],
        properties: { request_id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const { request_id } = request.params as { request_id: string };
      const view = await getAuthorizationRequest(request_id);
      if (!view) {
        return reply.code(404).send({ error: "Unknown authorization request" });
      }
      return reply.send({
        id: view.request.id,
        status: view.request.status,
        expired: view.request.expiresAt.getTime() < Date.now(),
        scope: view.request.scope,
        client: {
          name: view.client.name,
          uri: view.client.clientUri,
          logo_uri: view.client.logoUri,
          redirect_host: new URL(view.request.redirectUri).host,
        },
      });
    },
  });

  // POST /oauth/requests/:request_id/approve — session trust required: the
  // consent click is exactly as sensitive as minting an API key.
  app.post("/oauth/requests/:request_id/approve", {
    schema: {
      tags: ["oauth"],
      summary: "Approve an authorization request as the signed-in user",
      params: {
        type: "object",
        required: ["request_id"],
        properties: { request_id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const { request_id } = request.params as { request_id: string };
      const outcome = await approveAuthorizationRequest({
        requestId: request_id,
        userId: request.auth!.userId!,
      });
      if (!outcome) {
        return reply.code(410).send({
          error: "Authorization request expired or already handled",
          code: "AUTHORIZATION_REQUEST_GONE",
        });
      }
      return reply.send({ redirect_to: outcome.redirectTo });
    },
  });

  app.post("/oauth/requests/:request_id/deny", {
    schema: {
      tags: ["oauth"],
      summary: "Deny an authorization request",
      params: {
        type: "object",
        required: ["request_id"],
        properties: { request_id: { type: "string", format: "uuid" } },
      },
    },
    preHandler: [app.authenticate, app.requireService],
    handler: async (request, reply) => {
      const { request_id } = request.params as { request_id: string };
      const outcome = await denyAuthorizationRequest(request_id);
      if (!outcome) {
        return reply.code(410).send({
          error: "Authorization request expired or already handled",
          code: "AUTHORIZATION_REQUEST_GONE",
        });
      }
      return reply.send({ redirect_to: outcome.redirectTo });
    },
  });
}
