/**
 * What a connected deployment may call (src/server/deployment-grants.ts):
 * every route the map names exists, so the map cannot quietly keep a route
 * that was renamed, and the grants it names are the four there are.
 *
 * The app is built with the mirror both published and applied, so that the
 * feed's routes are mounted (src/services/mirror-roles.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEPLOYMENT_ROUTE_GRANTS } from "../../../src/server/deployment-grants.js";
import { DEPLOYMENT_GRANTS } from "../../../src/db/schema.js";
import { routeKey } from "../../../src/server/plugins/route-catalog.js";

const MIRROR_ENV = { MIRROR_PUBLISH: "true", MIRROR_FEED_DIR: "/var/empty/mirror-batches" };
let app: FastifyInstance;
let keys: Set<string>;

beforeAll(async () => {
  process.env.ENVIRONMENT = "staging";
  process.env.LOG_LEVEL = "fatal";
  Object.assign(process.env, MIRROR_ENV);
  const { buildApp } = await import("../../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  keys = new Set(app.routeCatalog.map((r) => routeKey(r.method, r.url)));
});

afterAll(async () => {
  await app?.close();
  for (const name of Object.keys(MIRROR_ENV)) delete process.env[name];
});

describe("what a connected deployment may call", () => {
  it("names only routes that exist", () => {
    expect(Object.keys(DEPLOYMENT_ROUTE_GRANTS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("names only the four grants, or any of them", () => {
    const allowed = new Set<string>([...DEPLOYMENT_GRANTS, "any"]);
    expect(Object.values(DEPLOYMENT_ROUTE_GRANTS).filter((g) => !allowed.has(g))).toEqual([]);
  });

  it("never opens a route that changes who speaks for an organization", () => {
    const listed = Object.keys(DEPLOYMENT_ROUTE_GRANTS);
    expect(listed.filter((k) => /organizations\/:id|connect-requests|api-keys|account-conversion|organization-invitations/.test(k))).toEqual([]);
  });
});
