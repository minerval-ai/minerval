/**
 * The anonymous rate limit: a count per IP address on requests that present
 * no credential the API recognises.
 *
 * Why a count, where everything else here is bounded by money: an account's
 * use is bounded by its budget, and an anonymous caller has no account or
 * budget to bound it. Nothing prices its requests, so one address could
 * monopolise the origin. A count per address is the only measure there is.
 *
 * Stated up front, as every limit is: each response to a counted request
 * carries `RateLimit-Policy: <limit>;w=60`, the OpenAPI description states
 * the figure and this reason (src/server/plugins/swagger.ts), and past the
 * limit the answer is a 429 with `Retry-After` and a body that restates
 * both. The policy header is the same for every caller, so it is safe on a
 * response the edge caches; the running count is not sent, because a cached
 * copy would hand one caller another's remainder.
 *
 * Who is counted. A request is exempt only when the API recognises the
 * credential it presents: a live API key, an env key, the operator key, a
 * live OAuth token, or an in-flight MCP dispatch. A made-up key is counted
 * like no key at all, or adding any `x-api-key` header would switch the
 * limit off. Recognising a key costs a lookup, so a recognised credential
 * is remembered (by hash) for a minute; an unrecognised one is looked up
 * each time, which the limit itself bounds. Preflights and health checks
 * are not counted, and neither is keyless local development, where every
 * caller is the dev account (src/server/plugins/auth.ts, "Dev bypass").
 *
 * Where it runs. In this process, per API instance: with several instances
 * behind the load balancer an address can reach each one's limit, so the
 * effective ceiling is the limit times the instance count. That is enough
 * for what the limit is for (stopping one address from monopolising the
 * origin) and it is why the figure is described as per instance. Requests
 * the edge answers from its cache never arrive, so they are not counted:
 * the limit meters what costs the origin something. It lives here and not
 * at Cloudflare because exempting a recognised credential needs the request
 * headers, which Cloudflare's rate limiting does not read on our plan.
 *
 * The address is Cloudflare's `cf-connecting-ip`, which Cloudflare sets
 * itself and a client cannot forge through it; a caller that reached the
 * load balancer directly could. Without the header it is the socket's
 * address.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadConfig } from "../../config.js";
import { resolveApiKey } from "../../services/api-key-service.js";
import {
  isOAuthAccessToken,
  resolveAccessToken,
} from "../../services/oauth-service.js";
import {
  MCP_DISPATCH_HEADER,
  resolveDispatchedAuth,
} from "../../mcp/dispatch.js";
import { operatorKeyMatches } from "./auth.js";

export const ANONYMOUS_RATE_LIMIT_WINDOW_SECONDS = 60;
const WINDOW_MS = ANONYMOUS_RATE_LIMIT_WINDOW_SECONDS * 1000;

/** How long a recognised credential is remembered before it is looked up again. */
const RECOGNISED_TTL_MS = 60_000;
/** Past this many tracked entries, expired ones are swept on the next request. */
const SWEEP_AT = 10_000;

/** Paths the limit never counts: the load balancer's health checks. */
const UNCOUNTED_PREFIXES = ["/health"];

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function clientAddress(request: FastifyRequest): string {
  return header(request, "cf-connecting-ip")?.trim() || request.ip;
}

export function anonymousRateLimitMessage(limit: number): string {
  return (
    `Requests without credentials are limited to ${limit} requests per minute ` +
    "per IP address. An anonymous caller has no account or budget to bound " +
    "its use, so a count per address stands in for one. Wait a minute and " +
    "retry, or present an API key: requests with a key are not subject to " +
    "this limit."
  );
}

function sweep<V>(map: Map<string, V>, expired: (value: V) => boolean): void {
  if (map.size < SWEEP_AT) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
}

export async function registerAnonymousRateLimit(
  app: FastifyInstance
): Promise<void> {
  // Held per app instance, so two apps in one process (tests) do not share
  // counts. address -> the window it is in and the requests counted in it.
  const windows = new Map<string, { start: number; count: number }>();
  // sha256(credential) -> when the recognition lapses.
  const recognised = new Map<string, number>();

  async function presentsRecognisedCredential(
    request: FastifyRequest
  ): Promise<boolean> {
    const config = loadConfig();

    const nonce = header(request, MCP_DISPATCH_HEADER);
    if (nonce !== undefined && resolveDispatchedAuth(nonce)) return true;

    if (operatorKeyMatches(config.minervalOperatorKey, header(request, "x-operator-key"))) {
      return true;
    }

    const apiKey = header(request, "x-api-key");
    if (apiKey && config.apiKeys.includes(apiKey)) return true;

    const authz = header(request, "authorization");
    const bearer = authz?.startsWith("Bearer ")
      ? authz.slice("Bearer ".length).trim()
      : undefined;
    const token = bearer && isOAuthAccessToken(bearer) ? bearer : undefined;
    if (!apiKey && !token) return false;

    const now = Date.now();
    const remember = (credential: string) =>
      createHash("sha256").update(credential).digest("hex");
    for (const credential of [apiKey, token]) {
      if (credential && (recognised.get(remember(credential)) ?? 0) > now) return true;
    }

    // A lookup that fails (the database is down) recognises nothing: the
    // request is counted, and the route answers as it would have anyway.
    const known =
      (apiKey ? await resolveApiKey(apiKey).catch(() => null) : null) ??
      (token ? await resolveAccessToken(token).catch(() => null) : null);
    if (!known) return false;
    sweep(recognised, (until) => until <= now);
    recognised.set(remember((apiKey ?? token)!), now + RECOGNISED_TTL_MS);
    return true;
  }

  app.addHook("onRequest", async (request, reply) => {
    const config = loadConfig();
    const limit = config.anonymousRateLimitPerMinute;

    if (request.method === "OPTIONS") return;
    const path = request.url.split("?")[0]!;
    if (UNCOUNTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
    // Keyless local development: every caller is the dev account.
    const envKeysConfigured = config.apiKeys.length > 0 && config.apiKeys[0] !== "";
    if (!envKeysConfigured && config.env !== "production") return;
    if (await presentsRecognisedCredential(request)) return;

    const now = Date.now();
    const address = clientAddress(request);
    let window = windows.get(address);
    if (!window || now - window.start >= WINDOW_MS) {
      sweep(windows, (w) => now - w.start >= WINDOW_MS);
      window = { start: now, count: 0 };
      windows.set(address, window);
    }

    reply.header(
      "ratelimit-policy",
      `${limit};w=${ANONYMOUS_RATE_LIMIT_WINDOW_SECONDS}`
    );
    if (window.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .header("cache-control", "no-store")
        .send({
          error: {
            code: "ANONYMOUS_RATE_LIMITED",
            message: anonymousRateLimitMessage(limit),
            request_id: request.id,
          },
        });
    }
    window.count += 1;
  });
}
