/**
 * What a connected deployment may call on the public graph, by route
 * (docs/organizations.md, "What each deployment may do"; #1118).
 *
 * A signed request from a deployment is refused on every route not listed
 * here (NOT_A_DEPLOYMENT_ROUTE), so a route added later is closed to
 * deployments until someone decides otherwise. A listed route needs the
 * grant beside it (GRANT_NOT_HELD otherwise), or `"any"`, which any live
 * grant opens: the deployment reading its own organization's state.
 *
 * tests/unit/server/deployment-grants.test.ts builds the app and fails on a
 * route listed here that does not exist.
 */
import type { DeploymentGrant } from "../db/schema.js";

export type RouteGrant = DeploymentGrant | "any";

export const DEPLOYMENT_ROUTE_GRANTS: Readonly<Record<string, RouteGrant>> = {
  // ---- read_feed: pulling the whole mirror feed ----
  "GET /mirror/feed/:sequence": "read_feed",

  // ---- report_usage: one day's total, privately to Minerval ----
  "POST /usage-reports": "report_usage",

  // ---- publish: the signing key's registration, pages, mandates, and the nodes pages need ----
  "POST /publishers": "publish",
  "POST /published-pages": "publish",
  "POST /published-mandates": "publish",
  "POST /claims/propose": "publish",

  // ---- act: acting and spending in the organization's name ----
  "POST /requests/:request_id/take-up": "act",
  "POST /requests/:request_id/take-up/decline": "act",
  "POST /grant-conversations": "act",
  "POST /grant-conversations/:id/messages": "act",
  "POST /grant-conversations/:id/fund": "act",
  "POST /mandates/:id/contribute": "act",
  "POST /mandates/:id/raise": "act",
  "POST /claims/:claim_id/contribute": "act",
  "POST /reports": "act",
  "POST /contributions": "act",

  // ---- any grant: the organization's own state ----
  "GET /organizations/me": "any",
  "POST /deployments/me/retire": "any",
  "GET /users/me": "any",
  "GET /grants": "any",
  "GET /reports/mine/:id": "any",
  "GET /contributions/:id": "any",
  "GET /grant-conversations/:id": "any",
};

export const GRANT_WORDS: Readonly<Record<DeploymentGrant, string>> = {
  read_feed: "Pull the whole mirror feed. It shows only that the deployment exists and when it pulls.",
  report_usage: "Send one day's total of owls spent, privately to Minerval, for the metered price.",
  publish: "Register the deployment's signing key, and send pages and mandates released at its gate to outside, under the organization.",
  act: "Take up requests, open and fund mandates, and spend the organization's public owls, in its name.",
};
