/**
 * Remote MCP endpoint (#73): streamable HTTP at POST /mcp.
 *
 * Stateless mode: every JSON-RPC POST builds a fresh McpServer + transport
 * carrying the caller's resolved identity, handles the message, and tears
 * down when the response closes. No session state lives on this server, so
 * it scales horizontally and survives deploys — the trade-off is no
 * server-initiated notifications, which none of our tools need.
 *
 * Auth is the shared plugin (#70): x-api-key, or `Authorization: Bearer
 * <api-key>` for hosted clients (Claude.ai / Cowork custom connectors) that
 * only send an Authorization header. Full OAuth (dynamic client
 * registration) is a documented follow-up.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../config.js";
import { buildMcpServer } from "../mcp/server.js";
import { isOAuthAccessToken } from "../services/oauth-service.js";

// Hosted MCP clients commonly authenticate with a Bearer token; when it's an
// API key (not an OAuth access token, which the auth plugin resolves from the
// Authorization header itself), map it onto the x-api-key header.
async function bearerToApiKey(request: FastifyRequest): Promise<void> {
  const authz = request.headers.authorization;
  if (!request.headers["x-api-key"] && authz?.startsWith("Bearer ")) {
    const token = authz.slice("Bearer ".length).trim();
    if (!isOAuthAccessToken(token)) {
      request.headers["x-api-key"] = token;
    }
  }
}

const methodNotAllowed = {
  jsonrpc: "2.0",
  error: {
    code: -32000,
    message:
      "Method not allowed. This MCP server is stateless: send JSON-RPC over POST /mcp.",
  },
  id: null,
} as const;

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // MCP authorization (RFC 9728): a 401 must point the client at the
  // protected-resource metadata so it can discover the OAuth flow. Scoped to
  // this plugin, so only /mcp responses carry the challenge.
  const issuer = loadConfig().publicApiBaseUrl.replace(/\/$/, "");
  app.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode === 401) {
      reply.header(
        "www-authenticate",
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`
      );
    }
    return payload;
  });

  app.post(
    "/",
    {
      schema: { hide: true },
      preHandler: [bearerToApiKey, app.authenticate],
    },
    async (request, reply) => {
      const server = buildMcpServer({
        auth: request.auth!,
        requestId: request.id,
        app,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });

      // The SDK writes directly to the Node response; take Fastify out of
      // the reply lifecycle.
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    }
  );

  // Stateless servers have no SSE stream to resume and no session to delete.
  const reject405 = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send(methodNotAllowed);
  app.get("/", { schema: { hide: true } }, reject405);
  app.delete("/", { schema: { hide: true } }, reject405);
}
