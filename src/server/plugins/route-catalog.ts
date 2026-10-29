/**
 * The route catalog: every REST route the app registers, with its JSON
 * schemas, recorded as it registers.
 *
 * The MCP server reads it to expose REST routes as tools (src/mcp/
 * route-tools.ts), so a tool's input schema and description come from the
 * route itself and cannot drift from it. The MCP parity test reads it to
 * check that every route is either a tool or excluded with a stated reason.
 *
 * Registered on the root instance before any route, so the onRoute hook sees
 * routes in every child plugin. Fastify's automatic HEAD routes are skipped:
 * they are the GET route again.
 */
import type { FastifyInstance, FastifySchema } from "fastify";

export interface CatalogRoute {
  method: string;
  /** The full URL pattern, prefix included, trailing slash removed. */
  url: string;
  schema: FastifySchema | undefined;
}

/** `"GET /claims/:claim_id"`: how the parity table names a route. */
export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeRouteUrl(url)}`;
}

/** A prefixed root route registers as "/claims/"; it is called as "/claims". */
export function normalizeRouteUrl(url: string): string {
  return url.length > 1 && url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function registerRouteCatalog(app: FastifyInstance): Promise<void> {
  const catalog: CatalogRoute[] = [];
  app.decorate("routeCatalog", catalog);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      catalog.push({
        method: method.toUpperCase(),
        url: normalizeRouteUrl(route.url),
        schema: route.schema,
      });
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    routeCatalog: CatalogRoute[];
  }
}
