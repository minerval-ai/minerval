/**
 * Marks a preHandler as optional authentication: it authenticates a caller
 * who presents credentials and lets an anonymous one through untouched.
 *
 * The public-read plugin (src/server/plugins/public-read.ts) treats any
 * preHandler it does not recognise as a gate and keeps the route out of
 * caches, so a route whose anonymous reads are open says so by wrapping its
 * optional-auth hook in this. Only wrap a hook that never refuses or alters
 * a request that carries no credentials.
 */
const optionalAuthHooks = new WeakSet<object>();

export function optionalAuthHook<T extends (...args: never[]) => unknown>(hook: T): T {
  optionalAuthHooks.add(hook);
  return hook;
}

export function isOptionalAuthHook(hook: unknown): boolean {
  return typeof hook === "function" && optionalAuthHooks.has(hook);
}
