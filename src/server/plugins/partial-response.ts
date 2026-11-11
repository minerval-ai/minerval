/**
 * Partial responses: `fields=` on GET routes.
 *
 * A caller that needs three properties of a claim should not have to carry
 * the whole record: a website embedding claims pays for it in bytes, an agent
 * in context. `fields` is a comma-separated list of dotted paths
 * (`fields=claim.text,assessment.status,assessment.confidence`) and the
 * response is pruned to them. It is one mechanism for every GET route that
 * answers with a JSON object, not something each route implements.
 *
 * How it is wired:
 *  - onRoute adds `fields` to the querystring schema of every covered GET
 *    route, so it shows in the OpenAPI document and, through the route
 *    catalog, as an input of the MCP tool generated from the route.
 *  - preValidation parses it; malformed input is a 400 in the API's error
 *    envelope before the handler runs.
 *  - preSerialization prunes. It serializes the handler's payload with the
 *    route's own serializer first, so the paths select from exactly what the
 *    route serves (its declared response shape), then hands Fastify the
 *    pruned object. Everything downstream (onSend, and so any header
 *    computed from the response bytes) sees the pruned body.
 *
 * What it leaves alone: non-GET routes, error responses, and anything a
 * route sends as a string, buffer or stream (BibTeX, Atom, Lean, exports,
 * the MCP stream). Fastify does not run preSerialization for those, so a
 * `fields` there is validated and then has no effect.
 *
 * Pruning rules (pruneToFields):
 *  - A path selects the value at it, whole. `claim` keeps all of `claim`.
 *  - A path through an array applies to each element: `results.id`.
 *    Elements keep their positions; an object element that matches nothing
 *    becomes `{}`.
 *  - A path that matches nothing is simply absent from the response.
 *  - A null on the way is kept as null: `assessment.status` on a claim
 *    with no assessment answers `{"assessment": null}`, because "not
 *    assessed" is something the caller asked about, not something missing.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { normalizeRouteUrl } from "./route-catalog.js";

/**
 * The longest `fields` value accepted. It bounds the work of parsing a
 * value that arrives before any other validation; no response in the API
 * has paths that need more. Stated in the parameter's schema.
 */
export const FIELDS_MAX_LENGTH = 2000;

const SEGMENT = /^[A-Za-z0-9_-]+$/;

export const FIELDS_PARAMETER = {
  type: "string",
  maxLength: FIELDS_MAX_LENGTH,
  description:
    "Return only these parts of the response: a comma-separated list of " +
    "dotted paths, e.g. `claim.text,assessment.status,assessment.confidence`. " +
    "A path through a list applies to each item (`results.id,results.text`). " +
    "A path that matches nothing is left out; a null on the way is kept as " +
    "null. Omit for the full response. Applies to JSON responses only. When " +
    "you trim a judgment, keep what goes with the status you will report: " +
    "its confidence and the claim's contestation. " +
    `At most ${FIELDS_MAX_LENGTH} characters.`,
} as const;

/** Malformed `fields` input; the message says what is wrong with it. */
export class FieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldsError";
  }
}

/** A selection tree: `true` keeps the whole value, a map keeps those keys. */
type Selection = true | Map<string, Selection>;

/**
 * Parse a `fields` value into paths. Throws FieldsError on anything that is
 * not a comma-separated list of dotted names (letters, digits, `_`, `-`).
 * Spaces around a path are allowed; duplicates are dropped.
 */
export function parseFields(raw: unknown): string[][] {
  if (typeof raw !== "string") {
    throw new FieldsError(
      "fields must be given once, as a comma-separated list of dotted paths"
    );
  }
  if (raw.length > FIELDS_MAX_LENGTH) {
    throw new FieldsError(`fields is longer than ${FIELDS_MAX_LENGTH} characters`);
  }
  if (raw.trim() === "") {
    throw new FieldsError("fields is empty; omit it for the full response");
  }
  const seen = new Set<string>();
  const paths: string[][] = [];
  for (const part of raw.split(",")) {
    const path = part.trim();
    if (path === "") {
      throw new FieldsError("fields has an empty path (a stray comma)");
    }
    const segments = path.split(".");
    for (const segment of segments) {
      if (!SEGMENT.test(segment)) {
        throw new FieldsError(
          `fields path "${path}" is not a dotted path of names ` +
            "(letters, digits, underscore, hyphen)"
        );
      }
    }
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(segments);
  }
  return paths;
}

function buildSelection(paths: string[][]): Selection {
  const root = new Map<string, Selection>();
  for (const path of paths) {
    let node = root;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i]!;
      const existing = node.get(segment);
      // A shorter path already keeps everything below it.
      if (existing === true) break;
      if (i === path.length - 1) {
        node.set(segment, true);
        break;
      }
      if (existing) {
        node = existing;
      } else {
        const next = new Map<string, Selection>();
        node.set(segment, next);
        node = next;
      }
    }
  }
  return root;
}

const NOTHING = Symbol("nothing");

function prune(value: unknown, selection: Selection): unknown | typeof NOTHING {
  if (selection === true) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      if (element === null) {
        out.push(null);
      } else if (Array.isArray(element)) {
        out.push(prune(element, selection));
      } else if (typeof element === "object") {
        const pruned = prune(element, selection);
        out.push(pruned === NOTHING ? {} : pruned);
      }
      // A string or number has nothing at a deeper path: left out.
    }
    return out;
  }
  if (typeof value !== "object") return NOTHING;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let kept = false;
  // The response's own key order, not the order the paths were given in.
  for (const key of Object.keys(source)) {
    const sub = selection.get(key);
    if (sub === undefined) continue;
    const pruned = prune(source[key], sub);
    if (pruned === NOTHING) continue;
    out[key] = pruned;
    kept = true;
  }
  return kept ? out : NOTHING;
}

/**
 * Prune a JSON value to the given paths (see the rules at the top of this
 * file). Pure: the input is not modified. A top-level object that matches
 * nothing comes back as `{}`.
 */
export function pruneToFields(value: unknown, paths: string[][]): unknown {
  const pruned = prune(value, buildSelection(paths));
  return pruned === NOTHING ? {} : pruned;
}

/**
 * Route families that are not JSON reads: the MCP endpoint (a stream), the
 * OAuth server and its discovery documents (shapes fixed by RFCs), and the
 * API documentation pages.
 */
const UNCOVERED_PREFIXES = ["/mcp", "/oauth/", "/.well-known/", "/docs"];

/**
 * GET routes that never answer with a JSON object, so advertising `fields`
 * on them would promise something they cannot do.
 */
const UNCOVERED_ROUTES = new Set([
  "/health",
  "/prizes.atom",
  "/correspondents/:id/feed",
  "/claims/:claim_id/formalization.lean",
  // Exports in their own formats (TriG or JSON-LD, s(CASP), MIRA JSON-LD),
  // sent as text.
  "/claims/:claim_id/nanopub",
  "/claims/:claim_id/scasp",
  "/claims/:claim_id/mira",
  "/attachments/:id",
]);

function covered(url: string): boolean {
  if (UNCOVERED_ROUTES.has(url)) return false;
  return !UNCOVERED_PREFIXES.some(
    (prefix) => url === prefix || url.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}

type JsonSchemaObject = { type?: string; properties?: Record<string, unknown> };

export async function registerPartialResponse(app: FastifyInstance): Promise<void> {
  /** URL patterns of the GET routes that take `fields`. */
  const routes = new Set<string>();
  const selections = new WeakMap<FastifyRequest, string[][]>();

  // Registered on the root instance before any route (and before the route
  // catalog, which must record the schema with `fields` in it).
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some((m) => m.toUpperCase() === "GET")) return;
    const url = normalizeRouteUrl(route.url);
    if (!covered(url)) return;
    const querystring = (route.schema?.querystring ?? { type: "object" }) as JsonSchemaObject;
    // A route that already has a `fields` of its own keeps it.
    if (querystring.properties && "fields" in querystring.properties) return;
    routes.add(url);
    // A new schema object: route schemas are often shared constants.
    route.schema = {
      ...route.schema,
      querystring: {
        ...querystring,
        properties: { ...(querystring.properties ?? {}), fields: FIELDS_PARAMETER },
      },
    };
  });

  app.addHook("preValidation", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") return;
    const pattern = request.routeOptions?.url;
    if (!pattern || !routes.has(normalizeRouteUrl(pattern))) return;
    const raw = (request.query as Record<string, unknown> | undefined)?.fields;
    if (raw === undefined) return;
    try {
      selections.set(request, parseFields(raw));
    } catch (err) {
      if (!(err instanceof FieldsError)) throw err;
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: err.message,
          details: [{ path: "fields", message: err.message }],
          request_id: request.id,
        },
      });
    }
  });

  app.addHook("preSerialization", async (request, reply, payload) => {
    const paths = selections.get(request);
    if (!paths) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    if (payload === null || typeof payload !== "object") return payload;

    // Serialize with the route's own serializer first, so the paths select
    // from what the route serves, never from a property its response schema
    // would have dropped, and a `required` in that schema is checked against
    // the full payload rather than the pruned one.
    let served: unknown;
    try {
      const serialized = reply.serialize(payload);
      if (typeof serialized !== "string") return payload;
      served = JSON.parse(serialized);
    } catch {
      // Not JSON after all (a route with its own serializer): leave it.
      return payload;
    }
    reply.serializer(JSON.stringify);
    return pruneToFields(served, paths);
  });
}
