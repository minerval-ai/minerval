/**
 * In-process dispatch from an MCP tool call to a REST route.
 *
 * A route tool (src/mcp/route-tools.ts) does not reimplement its route: it
 * injects a request into the same Fastify app, so the route's own guards,
 * owl charges, validation, and serialization run exactly as they do for a
 * REST caller. MCP and the REST API cannot disagree about what an operation
 * does or what it costs, because there is only one implementation.
 *
 * Identity crosses the hop without the caller's credential. The MCP request
 * already authenticated (and passed the OAuth audience check, which binds a
 * token to /mcp); its resolved RequestAuth is parked under a single-call
 * random nonce, and the injected request carries only that nonce. The auth
 * plugin swaps the nonce back for the identity. A nonce exists only while
 * its injected request is in flight, and it is 256 random bits, so a header
 * sent from outside the process can never name one.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RequestAuth } from "../server/plugins/auth.js";

export const MCP_DISPATCH_HEADER = "x-minerval-mcp-dispatch";

const inFlight = new Map<string, RequestAuth>();

/** The identity an in-flight dispatch carries, or null for an unknown nonce. */
export function resolveDispatchedAuth(nonce: string): RequestAuth | null {
  return inFlight.get(nonce) ?? null;
}

export interface DispatchRequest {
  method: string;
  url: string;
  query?: Record<string, string | string[]>;
  body?: Record<string, unknown>;
}

export interface DispatchResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

export async function dispatchToRoute(
  app: FastifyInstance,
  auth: RequestAuth,
  request: DispatchRequest
): Promise<DispatchResponse> {
  const nonce = randomBytes(32).toString("hex");
  inFlight.set(nonce, auth);
  try {
    const response = await app.inject({
      method: request.method as "GET",
      url: request.url,
      query: request.query,
      ...(request.body !== undefined ? { payload: request.body } : {}),
      headers: { [MCP_DISPATCH_HEADER]: nonce },
    });
    return {
      statusCode: response.statusCode,
      contentType: String(response.headers["content-type"] ?? ""),
      body: response.body,
    };
  } finally {
    inFlight.delete(nonce);
  }
}
