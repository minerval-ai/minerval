/**
 * The route guard for a permission (src/permissions.ts).
 *
 * A route whose act a permission covers lists `requirePermission("fund")`
 * among its preHandlers, after `app.authenticate`. What it does depends on
 * the one setting that says who a deployment serves:
 *
 *  - Open (the public graph): nothing. The act keeps exactly the rules its
 *    route already carries, and nobody holds a permission.
 *  - Members-only: the request's standing, resolved when it arrived
 *    (server/plugins/members-only.ts), must hold the permission, or the
 *    answer is a 403 that names it and says who grants it.
 *
 * Each guard remembers which permission it asks for, so the route catalog
 * can record it against the route (server/plugins/route-catalog.ts) and the
 * MCP server can leave out a tool its caller may not use
 * (mcp/route-tools.ts). A route is given its permission in one place, here
 * in its preHandler list.
 *
 * It is a plain function and not a decorator on the app, so a route file
 * needs nothing registered to use it.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  holdsPermission,
  membersOnly,
  permissionRefusal,
  standingOf,
  type PermissionName,
} from "../permissions.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Send a refusal as written. Some routes declare a response schema for 401
 * or 403 in their own error shape, and a body sent as an object would be
 * serialized through it and lose its fields. A string is sent as it is, so
 * a refusal reads the same on every route.
 */
export function refuse(
  reply: FastifyReply,
  status: 401 | 403,
  body: { error: string; code: string } & Record<string, unknown>
): FastifyReply {
  return reply.code(status).type("application/json; charset=utf-8").send(JSON.stringify(body));
}

const permissionOfGuard = new WeakMap<object, PermissionName>();

export function requirePermission(permission: PermissionName): Guard {
  const guard: Guard = async (request, reply) => {
    if (!membersOnly()) return;
    if (holdsPermission(standingOf(request.auth), permission)) return;
    return refuse(reply, 403, {
      error: permissionRefusal(permission),
      code: "PERMISSION_REQUIRED",
      permission,
    });
  };
  permissionOfGuard.set(guard, permission);
  return guard;
}

/**
 * The permissions a route's preHandlers ask for, each once, in the order
 * they are listed. Empty for a route no permission guards.
 */
export function permissionsRequiredBy(preHandler: unknown): PermissionName[] {
  const hooks = preHandler === undefined || preHandler === null
    ? []
    : Array.isArray(preHandler)
      ? preHandler
      : [preHandler];
  const found: PermissionName[] = [];
  for (const hook of hooks) {
    if (typeof hook !== "function") continue;
    const permission = permissionOfGuard.get(hook);
    if (permission && !found.includes(permission)) found.push(permission);
  }
  return found;
}
