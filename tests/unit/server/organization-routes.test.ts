/**
 * What may be done in an organization's name (src/server/organization-routes.ts):
 * every route that writes is either open to a member or deployment under a
 * permission or named as a person's with its reason, so a route added later
 * cannot be done as an organization until someone decides; the map names only
 * routes that exist; each side names only the permissions that side can hold.
 *
 * The app is built with the mirror both published and applied, so that the
 * feed's routes are mounted (src/services/mirror-roles.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  NATIVE_TOOL_PERMISSIONS,
  ORGANIZATION_ROUTES,
  PERSON_READS,
  PERSON_ROUTES,
  memberMayCall,
} from "../../../src/server/organization-routes.js";
import { assistantAuth, openAccountTools } from "../../../src/llm/tools/assistant-tools.js";
import { NATIVE_TOOL_ROUTES, ROUTE_TOOLS } from "../../../src/mcp/route-tools.js";
import { DEPLOYMENT_GRANTS, MEMBER_PERMISSIONS } from "../../../src/db/schema.js";
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

describe("what may be done in an organization's name", () => {
  it("decides every route that writes", () => {
    const writes = [...keys].filter((k) => !k.startsWith("GET "));
    const undecided = writes.filter((k) => !ORGANIZATION_ROUTES[k] && !PERSON_ROUTES[k]);
    expect(undecided).toEqual([]);
  });

  it("names only routes that exist", () => {
    const named = [...Object.keys(ORGANIZATION_ROUTES), ...Object.keys(PERSON_ROUTES), ...Object.keys(PERSON_READS)];
    expect(named.filter((k) => !keys.has(k))).toEqual([]);
  });

  it("never names a route both as an act and as a person's", () => {
    expect(Object.keys(ORGANIZATION_ROUTES).filter((k) => PERSON_ROUTES[k] || PERSON_READS[k])).toEqual([]);
  });

  it("gives each side only the permissions it can hold", () => {
    const member = new Set<string>([...MEMBER_PERMISSIONS, "member", "admin"]);
    const deployment = new Set<string>(DEPLOYMENT_GRANTS);
    for (const [route, rule] of Object.entries(ORGANIZATION_ROUTES)) {
      if (rule.member) expect(member.has(rule.member), route).toBe(true);
      if (rule.deployment && rule.deployment !== "any" && rule.deployment !== "self") {
        expect(rule.deployment.length, route).toBeGreaterThan(0);
        for (const g of rule.deployment) expect(deployment.has(g), route).toBe(true);
      }
      expect(rule.member ?? rule.deployment, route).toBeDefined();
    }
  });

  it("never opens to either a route that changes who speaks for an organization", () => {
    const listed = Object.keys(ORGANIZATION_ROUTES);
    expect(
      listed.filter((k) => /organizations\/:id|connect-requests|api-keys|oauth|account-conversion|organization-invitations/.test(k))
    ).toEqual([]);
  });

  it("gives every person's route a reason", () => {
    for (const [route, why] of Object.entries({ ...PERSON_ROUTES, ...PERSON_READS })) {
      expect(why.trim().length, route).toBeGreaterThan(20);
    }
  });
});

describe("a member acting as the organization", () => {
  const member = (permissions: (typeof MEMBER_PERMISSIONS)[number][] = []) => ({ role: "member" as const, permissions });
  const admin = { role: "admin" as const, permissions: [] };

  it("needs the route's permission, which an admin holds without a grant", () => {
    expect(memberMayCall("POST /contributions", "POST", member())).toMatchObject({ ok: false, code: "PERMISSION_NOT_HELD", permission: "speak" });
    expect(memberMayCall("POST /contributions", "POST", member(["speak"]))).toEqual({ ok: true });
    expect(memberMayCall("POST /contributions", "POST", admin)).toEqual({ ok: true });
  });

  it("holds each kind of act separately", () => {
    expect(memberMayCall("POST /mandates/:id/contribute", "POST", member(["speak"]))).toMatchObject({ ok: false, permission: "spend" });
    expect(memberMayCall("POST /billing/checkout", "POST", member(["spend"]))).toMatchObject({ ok: false, permission: "buy" });
  });

  it("carries a deployment's packages by hand, and only an admin registers its key", () => {
    // docs/organizations.md, "Connecting by hand": the package is signed by the deployment's key, and checked as if it had sent it.
    expect(memberMayCall("POST /published-pages", "POST", member(["spend"]))).toEqual({ ok: true });
    // Its first version is charged to the organization's owls.
    expect(memberMayCall("POST /published-pages", "POST", member(["speak"]))).toMatchObject({ ok: false });
    expect(memberMayCall("POST /publishers", "POST", member(["spend", "speak"]))).toMatchObject({ ok: false, code: "ADMIN_REQUIRED" });
    expect(memberMayCall("POST /publishers", "POST", admin)).toEqual({ ok: true });
  });

  it("cannot send usage reports as a deployment does: an admin uploads them on the Billing tab", () => {
    expect(memberMayCall("POST /usage-reports", "POST", admin)).toMatchObject({ ok: false, code: "NOT_AN_ORGANIZATION_ACT" });
  });

  it("cannot reach a person's own routes or reads", () => {
    expect(memberMayCall("POST /api-keys", "POST", admin)).toMatchObject({ ok: false, code: "NOT_AN_ORGANIZATION_ACT" });
    expect(memberMayCall("GET /api-keys", "GET", admin)).toMatchObject({ ok: false, code: "NOT_AN_ORGANIZATION_ACT" });
  });

  it("reads the public graph and the organization's own state", () => {
    expect(memberMayCall("GET /claims/:claim_id", "GET", member())).toEqual({ ok: true });
    expect(memberMayCall("GET /users/me", "GET", member())).toEqual({ ok: true });
  });

  it("leaves the ledger to admins", () => {
    expect(memberMayCall("GET /billing/ledger", "GET", member(["spend", "buy"]))).toMatchObject({ ok: false, code: "ADMIN_REQUIRED" });
    expect(memberMayCall("GET /billing/ledger", "GET", admin)).toEqual({ ok: true });
  });
});

describe("the MCP tools, done as the organization", () => {
  const someone = { id: "00000000-0000-4000-8000-000000000001", externalId: null };

  it("decides every tool that writes or spends: by its route, or by name", async () => {
    const account = await openAccountTools(app, assistantAuth(someone), "test");
    try {
      const routeTools = new Set(Object.values(ROUTE_TOOLS).map((t) => t.name));
      const nativeWrites = new Set(
        Object.entries(NATIVE_TOOL_ROUTES)
          .filter(([key]) => !key.startsWith("GET "))
          .flatMap(([, names]) => names)
      );
      const undecided = account.definitions
        .map((d) => d.name)
        .filter((name) => !account.readOnly.has(name))
        .filter((name) => !routeTools.has(name) && !nativeWrites.has(name) && !(name in NATIVE_TOOL_PERMISSIONS));
      expect(undecided).toEqual([]);
    } finally {
      await account.close();
    }
  });

  it("offers a member only what they may do as it, and says what it left out", async () => {
    const auth = {
      ...assistantAuth({ id: "00000000-0000-4000-8000-0000000000aa", externalId: "org:00000000-0000-4000-8000-0000000000aa" }),
      actingMember: { accountId: someone.id, externalId: null },
      actingStanding: { organizationName: "Acme Corp", role: "member" as const, permissions: ["speak" as const] },
    };
    const account = await openAccountTools(app, auth, "test");
    try {
      const names = new Set(account.definitions.map((d) => d.name));
      expect(names.has("submit_contribution")).toBe(true);
      expect(names.has("state_view")).toBe(true);
      expect(names.has("search_claims")).toBe(true);
      expect(names.has("fund_mandate")).toBe(false);
      expect(names.has("match_claim")).toBe(false);
      expect(names.has("create_api_key")).toBe(false);
      const left = new Map(account.actingFor!.withheld.map((w) => [w.tool, w.permission]));
      expect(left.get("fund_mandate")).toBe("spend");
      expect(left.get("match_claim")).toBe("spend");
      expect(account.actingFor!.organizationName).toBe("Acme Corp");
    } finally {
      await account.close();
    }
  });
});
