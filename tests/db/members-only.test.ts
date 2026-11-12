/**
 * A members-only deployment (src/permissions.ts,
 * src/server/plugins/members-only.ts), against the real app and real tables:
 * what is served to someone not signed in, how the first administrator is
 * established, what a grant lets a person do, the log, parties and labels,
 * and what an MCP caller and the Assistant are offered.
 *
 * The public graph's side of the same setting is in
 * tests/unit/server/members-only.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "members-web-tier-key";
const OPERATOR_KEY = "members-operator-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-first-administrator";

// Set before any module reads config.
vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "members-web-tier-key";
  process.env.MINERVAL_OPERATOR_KEY = "members-operator-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-first-administrator";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { currentClearance } from "../../src/llm/usage-context.js";
import { assistantAuth, openAccountTools } from "../../src/llm/tools/assistant-tools.js";
import { permissionsNote } from "../../src/llm/permissions-note.js";
import { MCP_EXCLUDED_ROUTES, ROUTE_TOOLS } from "../../src/mcp/route-tools.js";
import { routeKey } from "../../src/server/plugins/route-catalog.js";
import {
  NOT_A_MEMBER_MESSAGE,
  OPEN_TO_ANYONE,
  OWN_CREDENTIAL,
  SERVICE_WITHOUT_A_PERSON,
  SIGNED_IN,
  SIGN_IN_REQUIRED_MESSAGE,
} from "../../src/server/plugins/members-only.js";
import { createApiKey } from "../../src/services/api-key-service.js";
import { resolveStanding } from "../../src/services/permission-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, UUID);

let app: FastifyInstance;
/** Labels a test defined through the API, removed again when the file is done. */
const definedLabels: string[] = [];

interface Person {
  id: string;
  externalId: string;
}

/** Sign a person in the way the web tier does: provision with the service key. */
async function signIn(name: string, groups?: string[], externalId = `oidc:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name, ...(groups ? { groups } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId };
}

/** A request from the web tier acting for a signed-in person: session trust. */
function as(person: Person, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

async function grant(admin: Person, body: Record<string, unknown>) {
  const res = await as(admin, { method: "POST", url: "/permissions/grants", payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().grant as { id: string };
}

let admin: Person;

beforeAll(async () => {
  // Start from a deployment that has never had an administrator.
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ('internal', 'dbtest'), ('restricted', 'dbtest'), ('partner-a', 'dbtest')
     ON CONFLICT DO NOTHING`
  );
  await rawQuery(`DELETE FROM label_reads`);

  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  // Two routes of the test's own, to read the clearance the way a service
  // deep in a request would: from the async context, with no parameter.
  app.get("/__clearance", async () => ({ clearance: currentClearance() }));
  app.post("/__clearance", async () => ({ clearance: currentClearance() }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  // The scratch database is shared with every other file in the suite, and
  // the labels tests count rows: leave the tables this file wrote as an
  // open deployment has them.
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(`DELETE FROM label_reads`);
  await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [["restricted", "partner-a", ...definedLabels]]);
});

describe("someone who is not signed in", () => {
  it("is served nothing: every route outside the written list answers 401", async () => {
    const reachable = new Set([...Object.keys(OPEN_TO_ANYONE), ...Object.keys(OWN_CREDENTIAL)]);
    let refused = 0;
    for (const route of app.routeCatalog) {
      const key = routeKey(route.method, route.url);
      const operatorOnly = app.signInClasses.get(key) === "own_credential";
      if (reachable.has(key) || operatorOnly) continue;
      const res = await app.inject({ method: route.method as "GET", url: concrete(route.url) });
      expect(res.statusCode, key).toBe(401);
      if (!route.url.startsWith("/mcp")) {
        expect(res.json(), key).toEqual({ error: SIGN_IN_REQUIRED_MESSAGE, code: "SIGN_IN_REQUIRED" });
      }
      refused += 1;
    }
    // Vacuous otherwise: the claim page, the search, the run log and the rest.
    expect(refused).toBeGreaterThan(150);
    for (const key of ["GET /claims/:claim_id", "GET /claims/search/:query", "GET /setup/features", "GET /sources/:source_id/document", "GET /runs/:run_id/steps", "POST /mcp"]) {
      expect(app.signInClasses.get(key), key).toBe("member");
    }
  });

  it("is refused before learning whether an address exists", async () => {
    const res = await app.inject({ url: "/no/such/route" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SIGN_IN_REQUIRED");
  });

  it("reaches exactly the routes sign-in and the health check need", async () => {
    expect(Object.keys(OPEN_TO_ANYONE).sort()).toEqual([
      "GET /.well-known/oauth-authorization-server",
      "GET /.well-known/oauth-authorization-server/mcp",
      "GET /.well-known/oauth-protected-resource",
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /health",
      "GET /oauth/authorize",
      "POST /oauth/register",
      "POST /oauth/token",
    ]);
    expect(Object.keys(OWN_CREDENTIAL)).toEqual(["POST /billing/webhook"]);
    expect(Object.keys(SERVICE_WITHOUT_A_PERSON)).toEqual(["POST /users/provision"]);
    expect(Object.keys(SIGNED_IN).sort()).toEqual(["GET /permissions/mine", "GET /users/me"]);

    // Every name in the lists is a route this app mounts.
    const mounted = new Set(app.routeCatalog.map((r) => routeKey(r.method, r.url)));
    for (const key of [OPEN_TO_ANYONE, OWN_CREDENTIAL, SERVICE_WITHOUT_A_PERSON, SIGNED_IN].flatMap(Object.keys)) {
      expect(mounted.has(key), key).toBe(true);
    }

    const health = await app.inject({ url: "/health" });
    expect(health.statusCode).toBe(200);
    const discovery = await app.inject({ url: "/.well-known/oauth-protected-resource/mcp" });
    expect(discovery.statusCode).toBe(200);
    // The routes that take a credential of their own check it themselves.
    const webhook = await app.inject({ method: "POST", url: "/billing/webhook", payload: {} });
    expect(webhook.statusCode).toBe(400);
    const operator = await app.inject({ method: "POST", url: "/operator/administrators", payload: { external_id: "oidc:x" } });
    expect(operator.statusCode).toBe(403);
    expect(operator.json().code).toBe("OPERATOR_KEY_REQUIRED");
  });

  it("is not let in by a made-up key, or by the web tier's key with nobody named", async () => {
    const fake = await app.inject({ url: `/claims/${UUID}`, headers: { "x-api-key": "made-up" } });
    expect(fake.statusCode).toBe(401);
    const nobody = await app.inject({ url: `/claims/${UUID}`, headers: { "x-api-key": SERVICE_KEY } });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.json().code).toBe("SIGN_IN_REQUIRED");
    const unknown = await app.inject({
      url: `/claims/${UUID}`,
      headers: { "x-api-key": SERVICE_KEY, "x-acting-user": "oidc:never-signed-in" },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("gets the OAuth challenge from the MCP endpoint, so a client can find where to sign in", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).toMatch(/resource_metadata=/);
  });
});

describe("an account that has signed in and holds nothing", () => {
  it("exists, is told who it is and that it holds nothing, and is served nothing else", async () => {
    const person = await signIn("newcomer");
    const me = await as(person, { url: "/users/me" });
    expect(me.statusCode).toBe(200);

    const mine = await as(person, { url: "/permissions/mine" });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      account: { id: person.id, external_id: person.externalId },
      member: false,
      permissions: [],
      clearance: ["public"],
    });

    // A route with its own 403 schema refuses in the same words (POST /sources).
    const post = await as(person, { method: "POST", url: "/sources", payload: { url: "https://example.org/x" } });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toEqual({ error: NOT_A_MEMBER_MESSAGE, code: "NOT_A_MEMBER" });
    for (const url of [`/claims/${UUID}`, "/claims", "/permissions", "/permissions/log", "/setup/features"]) {
      const res = await as(person, { url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({ error: NOT_A_MEMBER_MESSAGE, code: "NOT_A_MEMBER" });
    }
  });
});

describe("the first administrator", () => {
  it("is nobody until the person the setting names signs in", async () => {
    await signIn("someone-else");
    const [{ n }] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM permission_grants`);
    expect(n).toBe(0);
  });

  it("is granted every permission on first sign-in, logged as made by the setting", async () => {
    admin = await signIn("first-admin", undefined, FIRST_ADMINISTRATOR);
    const rows = await rawQuery<{ permission: string; label: string | null; granted_via: string; granted_by: string | null }>(
      `SELECT permission, label, granted_via, granted_by FROM permission_grants WHERE account_id = $1`,
      [admin.id]
    );
    expect(rows.every((r) => r.granted_via === "first_administrator" && r.granted_by === null)).toBe(true);
    const held = rows.map((r) => (r.label ? `${r.permission}@${r.label}` : r.permission)).sort();
    expect(held).toEqual(expect.arrayContaining(["administer", "direct", "fund", "read@internal", "read@restricted", "read_sources@internal", "read_sources@partner-a"]));
    expect(held).not.toContain("read@public");

    const mine = (await as(admin, { url: "/permissions/mine" })).json();
    expect(mine.member).toBe(true);
    expect(mine.permissions).toEqual(["direct", "fund", "read", "read_sources", "administer"]);
  });

  it("is established once: signing in again grants nothing more", async () => {
    const before = await rawQuery(`SELECT id FROM permission_grants`);
    await signIn("first-admin", undefined, FIRST_ADMINISTRATOR);
    expect((await rawQuery(`SELECT id FROM permission_grants`)).length).toBe(before.length);
  });

  it("stays established: the setting does nothing once an administrator has existed, even a removed one", async () => {
    const second = await signIn("second-admin");
    await grant(admin, { permission: "administer", account_id: second.id });
    const [own] = await rawQuery<{ id: string }>(
      `SELECT id FROM permission_grants WHERE account_id = $1 AND permission = 'administer'`,
      [admin.id]
    );
    const removed = await as(second, { method: "DELETE", url: `/permissions/grants/${own!.id}` });
    expect(removed.statusCode, removed.body).toBe(200);

    await signIn("first-admin", undefined, FIRST_ADMINISTRATOR);
    expect((await resolveStanding(admin.id)).grants.some((g) => g.permission === "administer")).toBe(false);

    // The operator key is the way back in, and its grant says so.
    const back = await app.inject({
      method: "POST",
      url: "/operator/administrators",
      headers: { "x-operator-key": OPERATOR_KEY },
      payload: { external_id: FIRST_ADMINISTRATOR },
    });
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json().grant).toMatchObject({ permission: "administer", granted_via: "operator", granted_by: null });
  });
});

describe("grants", () => {
  it("make a member, with the clearance its reading grants add up to", async () => {
    await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ('restricted', 'internal')`);
    const reader = await signIn("reader");
    await grant(admin, { permission: "read", account_id: reader.id, label: "restricted" });

    const mine = (await as(reader, { url: "/permissions/mine" })).json();
    expect(mine.member).toBe(true);
    expect(mine.permissions).toEqual(["read"]);
    // restricted reads internal; partner-a is read by nothing it holds.
    expect(mine.clearance).toEqual(["internal", "public", "restricted"]);
    // Opening raw sources is its own grant, label by label.
    expect(mine.raw_source_labels).toEqual(["public"]);

    expect((await as(reader, { url: "/permissions" })).statusCode).toBe(200);
  });

  it("put the clearance where a read can find it without being handed it", async () => {
    const reader = await signIn("context-reader");
    await grant(admin, { permission: "read", account_id: reader.id, label: "restricted" });
    const viaGet = await as(reader, { url: "/__clearance" });
    expect(viaGet.json().clearance).toEqual(["internal", "public", "restricted"]);
    const viaPost = await as(reader, { method: "POST", url: "/__clearance", payload: { some: "body" } });
    expect(viaPost.json().clearance).toEqual(["internal", "public", "restricted"]);

    // Over a real socket too, where the body arrives on its own events.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/__clearance`, {
      method: "POST",
      headers: { "x-api-key": SERVICE_KEY, "x-acting-user": reader.externalId, "content-type": "application/json" },
      body: JSON.stringify({ some: "body", padding: "x".repeat(50_000) }),
    });
    expect(((await res.json()) as { clearance: string[] }).clearance).toEqual(["internal", "public", "restricted"]);

    // Two requests at once keep their own.
    const other = await signIn("context-other");
    await grant(admin, { permission: "read", account_id: other.id, label: "partner-a" });
    const [a, b] = await Promise.all([as(reader, { url: "/__clearance" }), as(other, { url: "/__clearance" })]);
    expect(a.json().clearance).toEqual(["internal", "public", "restricted"]);
    expect(b.json().clearance).toEqual(["partner-a", "public"]);
    // Outside any request there is none, which reads as public alone.
    expect(currentClearance()).toEqual(["public"]);
  });

  it("reach an account through a group its sign-in carried, while that sign-in vouches for it", async () => {
    const staff = await signIn("staffer", ["staff", " analysts ", ""]);
    expect((await as(staff, { url: `/claims/${UUID}` })).statusCode).toBe(403);

    await grant(admin, { permission: "read", group: "staff", label: "internal" });
    const mine = (await as(staff, { url: "/permissions/mine" })).json();
    expect(mine).toMatchObject({ member: true, groups: ["analysts", "staff"], clearance: ["internal", "public"] });
    expect(mine.grants).toEqual([{ permission: "read", label: "internal", through_group: "staff" }]);

    // The next sign-in no longer carries the group: the grant no longer reaches them.
    await signIn("staffer", ["analysts"], staff.externalId);
    expect((await as(staff, { url: "/permissions/mine" })).json().member).toBe(false);

    // A sign-in older than SIGN_IN_VALID_HOURS vouches for nothing.
    await signIn("staffer", ["staff"], staff.externalId);
    expect((await as(staff, { url: "/permissions/mine" })).json().member).toBe(true);
    await rawQuery(`UPDATE account_groups SET asserted_at = now() - interval '13 hours' WHERE account_id = $1`, [staff.id]);
    const lapsed = (await as(staff, { url: "/permissions/mine" })).json();
    expect(lapsed).toMatchObject({ member: false, groups: [] });
  });

  it("are refused when malformed, unknown, or already held", async () => {
    const person = await signIn("grantee");
    const post = (payload: Record<string, unknown>) => as(admin, { method: "POST", url: "/permissions/grants", payload });
    expect((await post({ permission: "read", account_id: person.id })).json().code).toBe("INVALID_SCOPE");
    expect((await post({ permission: "fund", account_id: person.id, label: "internal" })).json().code).toBe("INVALID_SCOPE");
    expect((await post({ permission: "read", account_id: person.id, label: "no-such" })).json().code).toBe("UNKNOWN_LABEL");
    expect((await post({ permission: "release", account_id: person.id, party_id: UUID })).json().code).toBe("UNKNOWN_PARTY");
    expect((await post({ permission: "fund" })).json().code).toBe("INVALID_SUBJECT");
    expect((await post({ permission: "fund", account_id: person.id, group: "g" })).json().code).toBe("INVALID_SUBJECT");
    expect((await post({ permission: "fund", account_id: UUID })).json().code).toBe("UNKNOWN_ACCOUNT");
    expect((await post({ permission: "fund", account_id: person.id })).statusCode).toBe(201);
    const again = await post({ permission: "fund", account_id: person.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("ALREADY_HELD");
  });

  it("are made and removed only by an administrator, from a signed-in session", async () => {
    const person = await signIn("not-an-admin");
    await grant(admin, { permission: "fund", account_id: person.id });
    const byMember = await as(person, { method: "POST", url: "/permissions/grants", payload: { permission: "fund", group: "x" } });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "administer" });
    expect((await as(person, { url: "/permissions/grants" })).statusCode).toBe(403);
    expect((await as(person, { url: "/permissions/accounts" })).statusCode).toBe(403);
    expect((await as(person, { url: "/parties" })).statusCode).toBe(403);
    expect((await as(person, { url: "/labels" })).statusCode).toBe(403);

    // The administrator's own API key reads, and cannot write.
    const key = await createApiKey({ userId: admin.id, name: "dbtest admin key" });
    const headers = { "x-api-key": key.plaintext };
    expect((await app.inject({ url: "/permissions/grants", headers })).statusCode).toBe(200);
    const byKey = await app.inject({ method: "POST", url: "/permissions/grants", headers, payload: { permission: "fund", group: "x" } });
    expect(byKey.statusCode).toBe(403);
    expect(byKey.json().code).toBe("SESSION_REQUIRED");
  });

  it("are never deleted: a removal marks the row, and the last administrator cannot be removed", async () => {
    const person = await signIn("removed-later");
    const made = await grant(admin, { permission: "direct", account_id: person.id });
    expect((await resolveStanding(person.id)).member).toBe(true);

    const removed = await as(admin, { method: "DELETE", url: `/permissions/grants/${made.id}` });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().grant).toMatchObject({ id: made.id, removed_by: { id: admin.id } });
    expect(removed.json().grant.removed_at).toBeTruthy();
    expect((await resolveStanding(person.id)).member).toBe(false);
    const [row] = await rawQuery<{ removed_at: Date | null }>(`SELECT removed_at FROM permission_grants WHERE id = $1`, [made.id]);
    expect(row!.removed_at).not.toBeNull();
    expect((await as(admin, { method: "DELETE", url: `/permissions/grants/${made.id}` })).json().code).toBe("ALREADY_REMOVED");
    // Held again later is a new row; the old one stays as it was.
    await grant(admin, { permission: "direct", account_id: person.id });

    const live = await rawQuery<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM permission_grants WHERE permission = 'administer' AND removed_at IS NULL`
    );
    for (const g of live.filter((g) => g.account_id !== admin.id)) {
      expect((await as(admin, { method: "DELETE", url: `/permissions/grants/${g.id}` })).statusCode).toBe(200);
    }
    const last = live.find((g) => g.account_id === admin.id)!;
    const refused = await as(admin, { method: "DELETE", url: `/permissions/grants/${last.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("LAST_ADMINISTRATOR");
  });
});

describe("what a permission guards", () => {
  it("is written on the routes, one place each", () => {
    const guarded = Object.fromEntries(
      app.routeCatalog.filter((r) => r.permissions.length > 0).map((r) => [routeKey(r.method, r.url), r.permissions])
    );
    expect(guarded).toEqual({
      "POST /grant-conversations": ["direct"],
      "POST /grant-conversations/:id/messages": ["direct"],
      "POST /grants": ["direct", "fund"],
      "POST /grants/:id/approve": ["direct"],
      "POST /correspondents/:id/poke": ["direct"],
      "POST /sources": ["direct"],
      "POST /grant-conversations/:id/fund": ["fund"],
      "POST /grants/:id/topup": ["fund"],
      "POST /mandates/:id/contribute": ["fund"],
      "POST /claims/:claim_id/order": ["fund"],
      "POST /claims/:claim_id/contribute": ["fund"],
      "POST /claims/:claim_id/decompose": ["fund"],
      "POST /requests/:request_id/contribute": ["fund"],
      "POST /budget-jobs/:id/topup": ["fund"],
      "GET /permissions/grants": ["administer"],
      "POST /permissions/grants": ["administer"],
      "DELETE /permissions/grants/:grant_id": ["administer"],
      "GET /permissions/accounts": ["administer"],
      "GET /parties": ["administer"],
      "POST /parties": ["administer"],
      "PUT /sources/:source_id/party": ["administer"],
      "GET /labels": ["administer"],
      "POST /labels": ["administer"],
      "POST /labels/:label/reads": ["administer"],
      "DELETE /labels/:label/reads/:reads": ["administer"],
      // Connections to an organization's systems (tests/db/connections.test.ts).
      "GET /connections": ["administer"],
      "GET /connections/:connection_id": ["administer"],
      "GET /connections/:connection_id/calls": ["administer"],
      "POST /connections": ["administer"],
      "PATCH /connections/:connection_id": ["administer"],
      "POST /connections/:connection_id/look": ["administer"],
      "PUT /connections/:connection_id/tools": ["administer"],
    });
  });

  it("refuses a member who lacks it, naming it, and lets through one who holds it", async () => {
    const reader = await signIn("reads-only");
    await grant(admin, { permission: "read", account_id: reader.id, label: "internal" });

    const fund = await as(reader, { method: "POST", url: `/mandates/${UUID}/contribute`, payload: { owls: 1 } });
    expect(fund.statusCode).toBe(403);
    expect(fund.json()).toEqual({
      error:
        "This needs the permission to fund work, which this account does not hold. " +
        "An administrator of this deployment grants it.",
      code: "PERMISSION_REQUIRED",
      permission: "fund",
    });
    const direct = await as(reader, { method: "POST", url: `/grants/${UUID}/approve` });
    expect(direct.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "direct" });
    const source = await as(reader, { method: "POST", url: "/sources", payload: { url: "https://example.org/a" } });
    expect(source.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "direct" });

    await grant(admin, { permission: "fund", account_id: reader.id });
    await grant(admin, { permission: "direct", account_id: reader.id });
    // Past the guard, the route's own answer: there is no such mandate.
    expect((await as(reader, { method: "POST", url: `/mandates/${UUID}/contribute`, payload: { owls: 1 } })).statusCode).toBe(404);
    expect((await as(reader, { method: "POST", url: `/grants/${UUID}/approve` })).statusCode).toBe(404);
  });

  it("never stands between a person and their own money: withdrawing and cancelling ask for no permission", async () => {
    const reader = await signIn("withdraws");
    await grant(admin, { permission: "read", account_id: reader.id, label: "internal" });
    for (const url of [`/mandates/${UUID}/withdraw`, `/grants/${UUID}/cancel`, `/budget-jobs/${UUID}/cancel`]) {
      const res = await as(reader, { method: "POST", url, payload: {} });
      expect(res.json().code, url).not.toBe("PERMISSION_REQUIRED");
      expect(res.statusCode, url).not.toBe(403);
    }
  });
});

describe("parties and labels", () => {
  it("adds parties, one of them the organization itself, and says whose material a source is", async () => {
    const own = await as(admin, { method: "POST", url: "/parties", payload: { name: "Halden  Evaluations", is_own_organization: true } });
    expect(own.statusCode, own.body).toBe(201);
    expect(own.json().party).toMatchObject({ name: "Halden Evaluations", is_own_organization: true });
    const second = await as(admin, { method: "POST", url: "/parties", payload: { name: "Another", is_own_organization: true } });
    expect(second.json().code).toBe("OWN_ORGANIZATION_EXISTS");
    const orrin = (await as(admin, { method: "POST", url: "/parties", payload: { name: "Orrin Labs" } })).json().party;
    expect((await as(admin, { method: "POST", url: "/parties", payload: { name: "orrin labs" } })).json().code).toBe("NAME_TAKEN");
    expect((await as(admin, { url: "/parties" })).json().parties.map((p: { name: string }) => p.name)).toEqual([
      "Halden Evaluations",
      "Orrin Labs",
    ]);

    const source = await getOrCreateSource({ url: `https://example.org/members-only/${randomUUID()}`, title: "A report" });
    const set = await as(admin, { method: "PUT", url: `/sources/${source.id}/party`, payload: { party_id: orrin.id } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ source_id: source.id, party: { id: orrin.id, name: "Orrin Labs" } });
    const moved = await as(admin, { method: "PUT", url: `/sources/${source.id}/party`, payload: { party_id: own.json().party.id } });
    expect(moved.statusCode).toBe(200);
    const events = await rawQuery<{ detail: Record<string, string | null> }>(
      `SELECT detail FROM administrative_events WHERE action = 'source_party_set' AND detail->>'source_id' = $1 ORDER BY created_at`,
      [source.id]
    );
    expect(events.map((e) => e.detail)).toEqual([
      { source_id: source.id, party_id: orrin.id, previous_party_id: null },
      { source_id: source.id, party_id: own.json().party.id, previous_party_id: orrin.id },
    ]);
    expect((await as(admin, { method: "PUT", url: `/sources/${UUID}/party`, payload: { party_id: orrin.id } })).statusCode).toBe(404);

    // The source's own reads say nothing of it yet.
    const facts = await as(admin, { url: `/sources/${source.id}` });
    expect(facts.statusCode).toBe(200);
    expect(facts.body).not.toMatch(/party_id|sensitivity_label/);

    // Release is held for one party.
    const reviewer = await signIn("orrin-reviewer");
    await grant(admin, { permission: "release", account_id: reviewer.id, party_id: orrin.id });
    expect((await as(reviewer, { url: "/permissions/mine" })).json().grants).toEqual([
      { permission: "release", party: { id: orrin.id, name: "Orrin Labs" } },
    ]);
  });

  it("defines labels and which reads which, and never lets public read anything", async () => {
    const name = `l${randomUUID().slice(0, 8)}`;
    definedLabels.push(name);
    const made = await as(admin, { method: "POST", url: "/labels", payload: { name, description: "For a test.", reads: ["internal", "public"] } });
    expect(made.statusCode, made.body).toBe(201);
    const label = made.json().labels.find((l: { name: string }) => l.name === name);
    expect(label.reads).toEqual(["internal", "public"]);
    expect(made.json().labels[0].name).toBe("public");

    expect((await as(admin, { method: "POST", url: "/labels", payload: { name, description: "Again." } })).json().code).toBe("LABEL_EXISTS");
    expect((await as(admin, { method: "POST", url: "/labels", payload: { name: "Not A Name", description: "x" } })).statusCode).toBe(400);
    const open = await as(admin, { method: "POST", url: "/labels/public/reads", payload: { reads: "internal" } });
    expect(open.statusCode).toBe(400);
    expect(open.json().code).toBe("PUBLIC_READS_NOTHING");
    expect((await as(admin, { method: "POST", url: `/labels/${name}/reads`, payload: { reads: name } })).json().code).toBe("READS_ITSELF");
    expect((await as(admin, { method: "POST", url: `/labels/${name}/reads`, payload: { reads: "nope" } })).json().code).toBe("UNKNOWN_LABEL");

    expect((await as(admin, { method: "POST", url: `/labels/${name}/reads`, payload: { reads: "partner-a" } })).statusCode).toBe(201);
    expect((await as(admin, { method: "POST", url: `/labels/${name}/reads`, payload: { reads: "partner-a" } })).json().code).toBe("ALREADY_READS");
    expect((await as(admin, { method: "DELETE", url: `/labels/${name}/reads/partner-a` })).statusCode).toBe(200);
    expect((await as(admin, { method: "DELETE", url: `/labels/${name}/reads/partner-a` })).json().code).toBe("NOT_READ");

    const actions = await rawQuery<{ action: string }>(
      `SELECT action FROM administrative_events WHERE detail->>'label' = $1 ORDER BY created_at, id`,
      [name]
    );
    expect(actions.map((a) => a.action).sort()).toEqual(
      ["label_defined", "label_read_added", "label_read_added", "label_read_added", "label_read_removed"].sort()
    );

    // A read grant at the new label reaches what it reads, and what that reads.
    const reader = await signIn("new-label-reader");
    await grant(admin, { permission: "read", account_id: reader.id, label: name });
    expect((await resolveStanding(reader.id)).clearance).toEqual([name, "internal", "public"].sort());
  });
});

describe("the log", () => {
  it("is open to every member, and withholds only the names a reader is not entitled to", async () => {
    const [orrin] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE name = 'Orrin Labs'`);
    const outsider = await signIn("log-reader");
    await grant(admin, { permission: "read", account_id: outsider.id, label: "internal" });
    const subject = await signIn("log-subject");
    await grant(admin, { permission: "read", account_id: subject.id, label: "partner-a" });
    await grant(admin, { permission: "release", account_id: subject.id, party_id: orrin!.id });

    type Entry = Record<string, unknown>;
    const entriesFor = async (person: Person) =>
      (await as(person, { url: "/permissions/log?limit=500" })).json().entries as Entry[];

    const seen = await entriesFor(outsider);
    const about = seen.filter((e) => e.account === "log-subject");
    // That the grants happened, to whom, by whom and when is shown.
    expect(about.map((e) => `${e.event}:${e.permission}`).sort()).toEqual(["granted:read", "granted:release"]);
    expect(about.every((e) => e.by === "first-admin" && typeof e.at === "string")).toBe(true);
    // The label they are not cleared for and the outside party's name are not.
    expect(about.find((e) => e.permission === "read")!.label).toEqual({ withheld: true });
    expect(about.find((e) => e.permission === "release")!.party).toEqual({ withheld: true });
    // Their own label is named, and so is the organization itself.
    expect(seen.find((e) => e.account === "log-reader")!.label).toBe("internal");
    expect(JSON.stringify(seen)).not.toContain("Orrin Labs");
    expect(JSON.stringify(seen)).not.toContain("partner-a");
    expect(seen.some((e) => e.event === "party_added" && e.party === "Halden Evaluations")).toBe(true);
    // Nothing in it identifies a person beyond a display name.
    expect(JSON.stringify(seen)).not.toMatch(/oidc:|external_id|@/);

    // The first administrator's own grants say how they came to be.
    expect(seen.some((e) => e.event === "granted" && e.via === "first_administrator" && e.by === null)).toBe(true);
    expect(seen.some((e) => e.event === "removed")).toBe(true);
    // Newest first.
    const times = seen.map((e) => Date.parse(e.at as string));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // The holder of release for a party is shown its name; an administrator, everything.
    const own = await entriesFor(subject);
    expect(own.find((e) => e.account === "log-subject" && e.permission === "release")!.party).toBe("Orrin Labs");
    const all = await entriesFor(admin);
    expect(JSON.stringify(all)).not.toContain("withheld");

    const page = (await as(outsider, { url: `/permissions/log?limit=2&before=${encodeURIComponent(seen[1]!.at as string)}` })).json().entries as Entry[];
    expect(page.length).toBe(2);
    expect(Date.parse(page[0]!.at as string)).toBeLessThan(Date.parse(seen[1]!.at as string));
  });
});

describe("an MCP caller and the Assistant", () => {
  it("are offered only the tools the person's permissions allow, and the Assistant is told why", async () => {
    const reader = await signIn("assistant-user");
    await grant(admin, { permission: "read", account_id: reader.id, label: "internal" });

    const limited = await openAccountTools(app, assistantAuth({ id: reader.id, externalId: reader.externalId }), "t1");
    const names = limited.definitions.map((d) => d.name);
    for (const tool of ["fund_mandate", "fund_grant", "order_assessment", "start_grant_conversation", "submit_source", "list_permission_grants", "list_labels"]) {
      expect(names, tool).not.toContain(tool);
    }
    for (const tool of ["search_claims", "get_claim", "propose_claim", "withdraw_from_mandate", "cancel_grant", "get_my_permissions", "get_permission_log", "list_permissions"]) {
      expect(names, tool).toContain(tool);
    }
    expect(limited.withheld!.map((w) => `${w.tool}:${w.permission}`)).toEqual(expect.arrayContaining([
      "fund_mandate:fund",
      "start_grant_conversation:direct",
      "list_parties:administer",
    ]));
    // A tool that is offered works: the call carries the standing it was opened with.
    const mine = await limited.call("get_my_permissions", {});
    expect(mine.isError).toBe(false);
    expect(JSON.parse(mine.text)).toMatchObject({ member: true, permissions: ["read"] });

    const note = permissionsNote(limited.withheld!);
    expect(note).toContain("your user does not hold all of them");
    expect(note).toMatch(/Without the permission to direct the graph: .*start_grant_conversation/);
    expect(note).toMatch(/Without the permission to fund work: .*fund_mandate/);
    expect(note).toMatch(/Without the permission to administer the deployment: .*list_permission_grants/);
    expect(note).not.toMatch(/read at a label|release/);
    await limited.close();

    await grant(admin, { permission: "fund", account_id: reader.id });
    await grant(admin, { permission: "direct", account_id: reader.id });
    const wider = await openAccountTools(app, assistantAuth({ id: reader.id, externalId: reader.externalId }), "t2");
    expect(wider.definitions.map((d) => d.name)).toEqual(expect.arrayContaining(["fund_mandate", "start_grant_conversation", "submit_source"]));
    expect(wider.withheld!.every((w) => w.permission === "administer")).toBe(true);
    await wider.close();

    const everything = await openAccountTools(app, assistantAuth({ id: admin.id, externalId: admin.externalId }), "t3");
    expect(everything.withheld).toEqual([]);
    expect(permissionsNote(everything.withheld!)).toBe("");
    // No one is offered a tool that changes who may do what: those take a session.
    const all = everything.definitions.map((d) => d.name);
    expect(all.filter((n) => /grant_permission|remove_permission|add_party|define_label|set_source_party/.test(n))).toEqual([]);
    expect(all).toEqual(expect.arrayContaining(["list_permission_grants", "list_accounts", "list_parties", "list_labels"]));
    await everything.close();
  });

  it("decides every members-only route: the reads are tools, the writes are excluded with the reason", () => {
    const mine = app.routeCatalog
      .map((r) => routeKey(r.method, r.url))
      .filter((key) => /^\S+ \/(permissions|parties|labels)(\/|$)|\/party$|^POST \/operator\/administrators$/.test(key));
    expect(mine.length).toBe(15);
    for (const key of mine) {
      const isRead = key.startsWith("GET ");
      expect(key in ROUTE_TOOLS, key).toBe(isRead);
      expect(key in MCP_EXCLUDED_ROUTES, key).toBe(!isRead);
    }
  });
});
