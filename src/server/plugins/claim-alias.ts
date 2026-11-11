/**
 * Merged ids on the REST routes under /claims/:claim_id (#884).
 *
 * A merge leaves the absorbed node as an alias "so that existing references
 * still resolve" (constitution §5). services/claim-alias-service.ts follows
 * the pointer; this plugin applies it to every route addressed to a node,
 * in one place, so no route can forget it and MCP's route tools (which
 * dispatch to these routes) inherit it:
 *
 *  - A read (GET) of an alias is answered as a read of the survivor: the
 *    `claim_id` the handler sees is the survivor's, and the JSON response
 *    carries `resolved_from` saying which id was asked, its wording, how it
 *    stood to the survivor (`stance_relation`) and when it was merged.
 *    Every response, JSON or not (BibTeX, nanopub, s(CASP), MIRA), carries
 *    the alias in the `x-minerval-resolved-from` header.
 *  - A write (POST, PATCH, PUT, DELETE) addressed to an alias is refused
 *    with 409 CLAIM_MERGED and the survivor's id. It is not redirected: the
 *    writer composed it for the node it named, and an opposed merge inverts
 *    what that node said.
 *
 * How it is wired, as partial-response.ts is: onRoute adds `resolved_from`
 * to the 200 schema of each covered GET route (so the serializer keeps it
 * and the OpenAPI document shows it); preHandler resolves or refuses;
 * preSerialization adds the field. It is registered after the `fields=`
 * plugin, so its preSerialization runs after the pruning: `resolved_from`
 * is served whatever `fields` selects, because a caller who trims a
 * response to `assessment.status` must still learn that the status is the
 * survivor's, and after an opposed merge the opposite of what it asked.
 *
 * Not covered, on purpose: the routes that read records pinned to a node's
 * own formal statement (see ALIAS_ROW_READS).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { normalizeRouteUrl } from "./route-catalog.js";
import {
  RESOLVED_FROM_SCHEMA,
  mergedAliasRefusal,
  resolveClaimId,
  type ResolvedFrom,
} from "../../services/claim-alias-service.js";

export const RESOLVED_FROM_HEADER = "x-minerval-resolved-from";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Routes addressed to one node: /claims/:claim_id and everything under it. */
const NODE_ROUTE = /^\/claims\/:claim_id(\/|$)/;

/**
 * Reads that answer with the row the id names, alias or not. A formal
 * statement, and the bounty, prize claims and solver attempts pinned to it,
 * belong to the wording they formalize: a merge does not move them, and
 * after an opposed merge the survivor's statement is the negation of the
 * absorbed node's. Serving the survivor's Lean file under the caller's id
 * (a text file cannot carry a notice) or hiding a bounty still recorded on
 * the absorbed row would mislead a solver about what it is proving. These
 * keep showing the absorbed node's own record; get_claim on the same id
 * says where the claim went. (The prize and attempt routes use `:id`, so
 * NODE_ROUTE already leaves them out; they are named here for the reader.)
 */
const ALIAS_ROW_READS = new Set([
  "/claims/:claim_id/formalization",
  "/claims/:claim_id/formalization.lean",
  "/claims/:claim_id/formalizations",
]);

type JsonSchemaObject = { type?: string; properties?: Record<string, unknown> };

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function covers(url: string | undefined, method: string): boolean {
  if (!url) return false;
  const pattern = normalizeRouteUrl(url);
  if (!NODE_ROUTE.test(pattern)) return false;
  return !(isRead(method) && ALIAS_ROW_READS.has(pattern));
}

export async function registerClaimAliasResolution(app: FastifyInstance): Promise<void> {
  const resolved = new WeakMap<FastifyRequest, ResolvedFrom>();

  app.addHook("onRoute", (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) => m.toUpperCase());
    if (!methods.includes("GET") || !covers(route.url, "GET")) return;
    const response = route.schema?.response as Record<string, JsonSchemaObject> | undefined;
    const ok = response?.[200] ?? response?.["200"];
    // A route with no 200 schema, or a free-form one, serializes what the
    // handler sends; only a schema with named properties would drop the field.
    if (!response || !ok?.properties || "resolved_from" in ok.properties) return;
    // New objects: route schemas are often shared constants.
    route.schema = {
      ...route.schema,
      response: {
        ...response,
        200: { ...ok, properties: { ...ok.properties, resolved_from: RESOLVED_FROM_SCHEMA } },
      },
    };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!covers(request.routeOptions?.url, request.method)) return;
    const params = request.params as Record<string, unknown> | null;
    const id = params?.claim_id;
    // An id that is not a uuid names no node; the route says so itself.
    if (!params || typeof id !== "string" || !UUID_RE.test(id)) return;

    if (isRead(request.method)) {
      const resolution = await resolveClaimId(id.toLowerCase());
      if (!resolution?.resolvedFrom) return;
      params.claim_id = resolution.id;
      resolved.set(request, resolution.resolvedFrom);
      reply.header(RESOLVED_FROM_HEADER, resolution.resolvedFrom.id);
      return;
    }

    const refusal = await mergedAliasRefusal(id.toLowerCase());
    if (!refusal) return;
    // The flat error shape the write routes here answer with.
    return reply.code(409).send({
      error: refusal.message,
      code: "CLAIM_MERGED",
      merged_into: refusal.survivorId,
      stance_relation: refusal.stanceRelation,
    });
  });

  app.addHook("preSerialization", async (request, reply, payload) => {
    const from = resolved.get(request);
    if (!from) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
    // A shape that always carries the key (a card) has it null; the alias wins.
    const { resolved_from: _unresolved, ...rest } = payload as Record<string, unknown>;
    return { resolved_from: from, ...rest };
  });
}
