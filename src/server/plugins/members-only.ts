/**
 * Members-only deployments: nothing is served to anyone who is not signed
 * in (src/permissions.ts; docs/accounts.md, "Members-only deployments").
 *
 * The public graph is open by design, so a route there is authenticated
 * only when it lists a guard. A private deployment needs the reverse, and
 * gets it from one setting, READS=members, and this one hook: every
 * request is authenticated before its route runs, a route added later is
 * closed without anyone remembering to close it, and the list of what stays
 * reachable is written out below and nowhere else.
 *
 * With READS at its starting value this plugin registers nothing: no hook,
 * no route config, no context. The public graph runs exactly as it did.
 *
 * What a request must be, by route:
 *
 *  - OPEN_TO_ANYONE: answered without a credential. The health check, and
 *    the endpoints an MCP client signs in through, which have to be
 *    reachable before there is a credential to present.
 *  - OWN_CREDENTIAL: routes that authenticate by a credential the hook
 *    does not read, and check it themselves: the operator key
 *    (requireOperator), and Stripe's signature on its webhook.
 *  - SERVICE_WITHOUT_A_PERSON: the deployment's own web tier, by its
 *    service key, before anyone is signed in. One route: the one that
 *    creates the account when a person signs in.
 *  - SIGNED_IN: any account that has signed in, member or not. Two routes:
 *    who the account is, and what it holds, so a person with no grant can
 *    be told so and shown the identity an administrator needs.
 *  - everything else: a member, which is an account with at least one live
 *    grant. What a member may then do is the route's own guards.
 *
 * A CORS preflight (OPTIONS) is let through: it carries no credentials by
 * the browser's own rules and is answered with headers and no content.
 *
 * Standing is resolved here, once (services/permission-service.ts), put on
 * request.auth, and its clearance entered into the async context for the
 * rest of the request (currentClearance in llm/usage-context.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { runWithUsageContext } from "../../llm/usage-context.js";
import { membersOnly } from "../../permissions.js";
import { bearerToApiKey } from "../../routes/mcp.js";
import { resolveStanding } from "../../services/permission-service.js";
import { refuse } from "../require-permission.js";
import { markAuthenticated, presentsCredentials } from "./auth.js";
import { routeKey } from "./route-catalog.js";

export type SignInClass = "anyone" | "own_credential" | "service" | "signed_in" | "member";

/** Reachable with no credential, each with the reason. */
export const OPEN_TO_ANYONE: Readonly<Record<string, string>> = {
  "GET /health": "The load balancer's liveness probe. It says whether the API and its database are up and nothing else.",
  "GET /.well-known/oauth-authorization-server":
    "OAuth discovery: how an MCP client finds where to sign in.",
  "GET /.well-known/oauth-authorization-server/mcp": "The same document at the path some clients ask for.",
  "GET /.well-known/oauth-protected-resource":
    "OAuth discovery: which authorization server guards the MCP endpoint.",
  "GET /.well-known/oauth-protected-resource/mcp": "The same document at the path some clients ask for.",
  "POST /oauth/register":
    "An MCP client registers itself before it can ask anyone to sign in. A registration reads nothing and grants nothing.",
  "GET /oauth/authorize":
    "Sends a person's browser to the web app's consent page, where they must be signed in to approve.",
  "POST /oauth/token":
    "Exchanges the code a signed-in member's approval produced for an access token. It is how the credential is obtained.",
};

/** Routes that check a credential of their own, which this hook does not read. */
export const OWN_CREDENTIAL: Readonly<Record<string, string>> = {
  "POST /billing/webhook":
    "Stripe's callback, trusted by its signature over the raw body. It credits a purchase and serves nothing.",
};

/** Reachable by the deployment's own service key with no person named. */
export const SERVICE_WITHOUT_A_PERSON: Readonly<Record<string, string>> = {
  "POST /users/provision":
    "The web tier creates or refreshes the account when a person signs in, before there is a session to act for.",
};

/** Reachable by any signed-in account, whether or not it holds a grant. */
export const SIGNED_IN: Readonly<Record<string, string>> = {
  "GET /users/me": "Who the signed-in account is.",
  "GET /permissions/mine": "What the signed-in account holds, which for an account with no grant is the news that it holds none.",
};

export const SIGN_IN_REQUIRED_MESSAGE =
  "This deployment serves nothing to anyone who is not signed in. Sign in through its web app, " +
  "or send an API key or access token that belongs to a member.";
export const NO_PERSON_MESSAGE =
  "This credential does not act for a person, and this deployment serves only people who are " +
  "signed in. A service key says who is asking with x-acting-user.";
export const NOT_A_MEMBER_MESSAGE =
  "This account is signed in but holds no permission in this deployment, so there is nothing " +
  "it may read or do. An administrator of the deployment grants permissions.";

function hooksOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** The class of one route. `requireOperator` is the app's decorated guard. */
export function classifySignIn(
  route: Pick<RouteOptions, "method" | "url" | "preHandler">,
  method: string,
  requireOperator: unknown
): SignInClass {
  // A GET's HEAD twin answers the same question with no body.
  const key = routeKey(method === "HEAD" ? "GET" : method, route.url);
  if (key in OPEN_TO_ANYONE) return "anyone";
  if (key in OWN_CREDENTIAL) return "own_credential";
  if (hooksOf(route.preHandler).includes(requireOperator)) return "own_credential";
  if (key in SERVICE_WITHOUT_A_PERSON) return "service";
  if (key in SIGNED_IN) return "signed_in";
  return "member";
}

/**
 * Register before any route, like the route catalog: the onRoute hook only
 * sees routes that register after it. After registerAuth, whose
 * `authenticate` it calls. `app.signInClasses` records each route's class,
 * for tests and for anyone asking why a request was refused.
 */
export async function registerMembersOnly(app: FastifyInstance): Promise<void> {
  if (!membersOnly()) return;

  const signInClasses = new Map<string, SignInClass>();
  app.decorate("signInClasses", signInClasses);
  app.addHook("onRoute", (route) => {
    // One options object can register several methods; they share a class
    // unless one of them is listed above by its own key.
    const methods = hooksOf(route.method).map(String);
    const classes = methods.map((m) => classifySignIn(route, m, app.requireOperator));
    methods.forEach((m, i) => signInClasses.set(routeKey(m, route.url), classes[i]!));
    const signIn = classes.every((c) => c === classes[0]) ? classes[0]! : "member";
    route.config = { ...route.config, signIn };
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS") return;
    // A request that matched no route has no class and is treated as any
    // other: refused before it can learn which addresses exist.
    const signIn = (request.routeOptions.config as { signIn?: SignInClass }).signIn ?? "member";
    if (signIn === "anyone" || signIn === "own_credential") return;

    // Hosted MCP clients send an API key as a Bearer token; the /mcp route
    // maps it in a preHandler, which runs after this.
    if ((request.routeOptions.url ?? "").startsWith("/mcp")) await bearerToApiKey(request);

    if (!presentsCredentials(request)) {
      return refuse(reply, 401, { error: SIGN_IN_REQUIRED_MESSAGE, code: "SIGN_IN_REQUIRED" });
    }
    await app.authenticate(request, reply);
    if (reply.sent) return reply;
    const auth = request.auth;
    if (!auth) {
      return refuse(reply, 401, { error: SIGN_IN_REQUIRED_MESSAGE, code: "SIGN_IN_REQUIRED" });
    }
    markAuthenticated(request);

    if (!auth.userId) {
      if (signIn === "service" && auth.isService) return;
      return refuse(reply, 401, { error: NO_PERSON_MESSAGE, code: "SIGN_IN_REQUIRED" });
    }
    // An identity carried over from an MCP request or an Assistant run was
    // given its standing when that began; anything else gets it now.
    const standing = auth.standing ?? (await resolveStanding(auth.userId));
    request.auth = { ...auth, standing };
    if (signIn === "signed_in" || signIn === "service") return;
    if (!standing.member) {
      return refuse(reply, 403, { error: NOT_A_MEMBER_MESSAGE, code: "NOT_A_MEMBER" });
    }
  });

  // The clearance goes on the async context for whatever runs next. `done`
  // is called inside the context, so the rest of the request's work is
  // started there. It is entered again once the body has been read: a body
  // arrives on the socket's own events, outside any context entered earlier.
  const enterClearance = (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const standing = request.auth?.standing;
    if (!standing) return done();
    runWithUsageContext({ clearance: standing.clearance }, done);
  };
  app.addHook("onRequest", enterClearance);
  app.addHook("preValidation", enterClearance);
}

declare module "fastify" {
  interface FastifyContextConfig {
    signIn?: SignInClass;
  }
  interface FastifyInstance {
    signInClasses: Map<string, SignInClass>;
  }
}
