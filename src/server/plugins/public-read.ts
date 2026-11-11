/**
 * Public reads as a cacheable, browser-facing surface.
 *
 * Outside sites embed claim data by calling the API straight from the page,
 * and Cloudflare sits in front of it. This plugin decides, in one place,
 * what every response tells a browser or the edge about caching:
 *
 *  - A GET on an open route, asked without credentials and answered 200 with
 *    JSON or text, is a PUBLIC READ: `cache-control: public, max-age=…,
 *    stale-while-revalidate=…` (config), a weak ETag over the bytes sent, and
 *    a 304 when If-None-Match already names them.
 *  - Any response on an authenticated route, and any response to a request
 *    that carried a credential, is `private, no-store`, unless the route set
 *    its own policy.
 *  - Everything else (an anonymous 404, a POST on an open route, a stream)
 *    is left as the route sent it: no policy, so nothing caches it.
 *
 * "Open route" is decided when the route registers, and the default is not
 * open. A route is open only when it has no hook that could gate it: no
 * onRequest, preParsing, preValidation, and no preHandler other than ones
 * marked optional (src/server/optional-auth.ts). A route registered before
 * this plugin, or outside the catalog, is never classified and so never
 * public. At send time three more things must hold: the request carried no
 * credential header of any kind, nothing resolved an identity onto it
 * (request.auth, which also covers the dev bypass and a handler that
 * authenticates inline), and the route did not already choose a policy.
 *
 * The policy hook is appended to each route's own onSend list rather than
 * added to the instance: route-level hooks run after every instance-level
 * one, so the ETag is computed over the bytes actually sent, after any
 * hook that rewrites the payload (a `fields=` pruner, for one).
 *
 * Shared caches never see who is asking: Cloudflare keys on the URL alone
 * and ignores `Vary` beyond Accept-Encoding. So the edge rule must bypass
 * the cache for any request that carries a credential header, or a keyed
 * caller would be handed the anonymous copy of a route that answers them
 * differently (docs/infrastructure.md, "Caching and the anonymous rate
 * limit"). The `vary` header set here covers browser caches, which do
 * honour it.
 */
import { createHash } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from "fastify";
import { loadConfig } from "../../config.js";
import { isOptionalAuthHook } from "../optional-auth.js";
import { presentsCredentials } from "./auth.js";
import { restrictedCorsOrigins } from "./cors.js";
import { routeKey } from "./route-catalog.js";

export const NO_STORE = "private, no-store";

/**
 * Surfaces this plugin leaves entirely alone. Health checks must never be
 * cached; /mcp is a session protocol on a hijacked socket; the OAuth and
 * discovery routes set their own policies where the RFCs ask for one.
 */
const EXCLUDED_PREFIXES = ["/health", "/mcp", "/oauth", "/.well-known", "/docs"];

/** Hooks that can refuse a request before the handler runs. */
const GATE_HOOKS = ["onRequest", "preParsing", "preValidation", "preHandler"] as const;

/**
 * Bodies a public read may carry: JSON and its `+json` relatives, text, and
 * the Atom feeds. Anything else (a file download, a binary) is not cached.
 */
const CACHEABLE_TYPE = /^(application\/([\w.-]+\+)?json|text\/[\w.-]+|application\/atom\+xml)\s*(;|$)/i;

export type ReadClass = "open" | "authenticated";

function excluded(url: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

function hooksOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Open only when no hook could gate the route. Any hook this cannot vouch
 * for makes the route authenticated: a route wrongly kept out of the cache
 * costs a little speed, one wrongly let in serves one caller's answer to
 * another.
 */
export function classifyRoute(route: RouteOptions): ReadClass {
  for (const name of GATE_HOOKS) {
    for (const hook of hooksOf(route[name])) {
      if (name === "preHandler" && isOptionalAuthHook(hook)) continue;
      return "authenticated";
    }
  }
  return "open";
}

/**
 * Any header that can change who the caller is taken to be. Wider than
 * presentsCredentials: the operator key and the acting-user header are read
 * by some open routes directly, and a cookie has no business here at all.
 */
function carriesCredential(request: FastifyRequest): boolean {
  return (
    presentsCredentials(request) ||
    request.headers["x-operator-key"] !== undefined ||
    request.headers["x-acting-user"] !== undefined ||
    request.headers.cookie !== undefined
  );
}

/** A weak validator over the bytes sent: equal bodies, equal tags. */
export function weakEtag(body: string | Buffer): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** If-None-Match against one tag, by the weak comparison (RFC 9110 §13.1.2). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || opaque(t) === opaque(etag));
}

function publicPolicy(): string {
  const config = loadConfig();
  const maxAge = `max-age=${config.publicReadMaxAgeSeconds}`;
  // With CORS_ORIGINS set, responses carry the caller's origin reflected
  // back, which a shared cache would hand to the wrong site (see cors.ts).
  // The browser's own cache honours `Vary: Origin`, so it may still keep it.
  if (restrictedCorsOrigins()) return `private, ${maxAge}`;
  return `public, ${maxAge}, stale-while-revalidate=${config.publicReadStaleWhileRevalidateSeconds}`;
}

function addVary(reply: FastifyReply, names: string[]): void {
  const current = String(reply.getHeader("vary") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (current.includes("*")) return;
  for (const name of names) {
    if (!current.some((v) => v.toLowerCase() === name.toLowerCase())) current.push(name);
  }
  reply.header("vary", current.join(", "));
}

async function cachePolicyOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  const readClass = (request.routeOptions.config as { readClass?: ReadClass }).readClass;
  const ownPolicy = reply.getHeader("cache-control");

  const anonymous = !carriesCredential(request) && !request.auth;
  if (readClass !== "open" || !anonymous) {
    if (ownPolicy === undefined) reply.header("cache-control", NO_STORE);
    return payload;
  }

  const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : null;
  if (
    // HEAD is answered by the GET handler and carries the same headers; the
    // body is dropped after this hook, so the validator is still the GET's.
    (request.method !== "GET" && request.method !== "HEAD") ||
    reply.statusCode !== 200 ||
    body === null ||
    !CACHEABLE_TYPE.test(String(reply.getHeader("content-type") ?? ""))
  ) {
    return payload;
  }
  // A route that chose its own policy keeps it. It still gets a validator
  // when that policy is a public one.
  if (ownPolicy !== undefined && !/(^|,)\s*public\b/i.test(String(ownPolicy))) {
    return payload;
  }

  if (ownPolicy === undefined) reply.header("cache-control", publicPolicy());
  // The same URL answers a keyed caller differently on some routes.
  addVary(reply, ["Authorization", "X-API-Key"]);
  const etag = weakEtag(body);
  reply.header("etag", etag);
  if (etagMatches(request.headers["if-none-match"], etag)) {
    reply.code(304);
    reply.removeHeader("content-type");
    reply.removeHeader("content-length");
    return "";
  }
  return payload;
}

/**
 * Register before any route, like the route catalog: the onRoute hook only
 * sees routes that register after it. `app.readClasses` records the verdict
 * per route ("GET /claims/:claim_id"), for tests and for anyone asking why
 * a route is or is not cached.
 */
export async function registerPublicRead(app: FastifyInstance): Promise<void> {
  const readClasses = new Map<string, ReadClass>();
  app.decorate("readClasses", readClasses);
  app.addHook("onRoute", (route) => {
    if (excluded(route.url)) return;
    const onSend = hooksOf(route.onSend);
    // Fastify registers a GET's HEAD twin from the same options object.
    if (onSend.includes(cachePolicyOnSend)) return;
    const readClass = classifyRoute(route);
    for (const method of hooksOf(route.method)) {
      readClasses.set(routeKey(String(method), route.url), readClass);
    }
    route.config = { ...route.config, readClass };
    // Last, so it sees the bytes actually sent. On the HEAD twin Fastify
    // generates for a GET, "last" has one exception: Fastify's own hook that
    // drops the body, which has to stay after this one or there would be no
    // bytes left to take the validator from.
    const dropsHeadBody = onSend.findIndex(
      (hook) => typeof hook === "function" && hook.name === "headRouteOnSendHandler"
    );
    const at = dropsHeadBody === -1 ? onSend.length : dropsHeadBody;
    route.onSend = [
      ...onSend.slice(0, at),
      cachePolicyOnSend,
      ...onSend.slice(at),
    ] as RouteOptions["onSend"];
  });
}

declare module "fastify" {
  interface FastifyContextConfig {
    readClass?: ReadClass;
  }
  interface FastifyInstance {
    readClasses: Map<string, ReadClass>;
  }
}
