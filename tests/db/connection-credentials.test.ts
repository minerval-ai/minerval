/**
 * A credential given on a connection's page and kept sealed
 * (src/services/connection-credential.ts; docs/connections.md, "A
 * credential given here"), against the real app, real tables and a real MCP
 * server over HTTP: that it reaches the server and nothing else, that the
 * database never holds it in the clear, that it is bound to the address it
 * was given for, who may give it, what the log says, and how a key is
 * replaced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";

const SERVICE_KEY = "connection-credentials-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-connection-credentials-administrator";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "connection-credentials-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-connection-credentials-administrator";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { STORED_CREDENTIAL_NO_KEY, STORED_CREDENTIAL_NOT_OPENED } from "../../src/services/connection-client.js";
import { CREDENTIAL_KEY_ENV, PREVIOUS_CREDENTIAL_KEYS_ENV } from "../../src/services/connection-credential.js";
import { createApiKey } from "../../src/services/api-key-service.js";
import { checkConnections, resealStoredCredentials } from "../../src/services/connection-service.js";
import { runAtLabel } from "../../src/llm/usage-context.js";
import { startFakeMcpServer } from "../fake-mcp-server.js";

type Fake = Awaited<ReturnType<typeof startFakeMcpServer>>;

const LABEL = "cred-internal";
const OTHER = "cred-other";
const TOKEN = `ntn_${randomBytes(18).toString("hex")}`;
const KEY = randomBytes(32).toString("base64");

let app: FastifyInstance;
let server: Fake;
let admin: Person;
let ownParty: string;

interface Person {
  id: string;
  externalId: string;
}

interface Credential {
  source: "stored" | "environment" | null;
  env: string | null;
  header: string;
  set: boolean;
  stored: { given_at: string; key: "current" | "previous" | "missing" } | null;
}

async function signIn(name: string, externalId = `oidc:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId };
}

function as(person: Person, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

let counter = 0;
function add(over: Record<string, unknown> = {}) {
  counter += 1;
  return as(admin, {
    method: "POST",
    url: "/connections",
    payload: {
      name: `Notes ${counter}`,
      tool_prefix: `notes${counter}`,
      url: server.url,
      party_id: ownParty,
      label: LABEL,
      stake: "Halden writes these notes about its own work.",
      ...over,
    },
  });
}

async function added(over: Record<string, unknown> = {}): Promise<{ id: string; credential: Credential; body: string }> {
  const res = await add(over);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().connection.id, credential: res.json().connection.credential, body: res.body };
}

async function credentialOf(id: string): Promise<Credential> {
  const res = await as(admin, { url: `/connections/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().connection.credential as Credential;
}

async function look(id: string) {
  const res = await as(admin, { method: "POST", url: `/connections/${id}/look` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().looked as { answered: boolean; problem?: string };
}

/** The connection's whole row as text, as a backup or anyone with the table would see it. */
async function rowText(id: string): Promise<string> {
  const [row] = await rawQuery<{ t: string }>(`SELECT row_to_json(c)::text AS t FROM connections c WHERE id = $1`, [id]);
  return row!.t;
}

async function logText(): Promise<string> {
  const [row] = await rawQuery<{ t: string }>(`SELECT coalesce(json_agg(e)::text, '') AS t FROM administrative_events e`);
  return row!.t;
}

async function cleanUp() {
  await rawQuery(`DELETE FROM connections`);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(`DELETE FROM label_reads`);
}

beforeAll(async () => {
  await cleanUp();
  await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'dbtest'), ($2, 'dbtest') ON CONFLICT DO NOTHING`, [LABEL, OTHER]);
  await ensureEnforcement();
  server = await startFakeMcpServer();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("cred-admin", FIRST_ADMINISTRATOR);
  const own = await as(admin, { method: "POST", url: "/parties", payload: { name: "Halden Evaluations", is_own_organization: true } });
  expect(own.statusCode, own.body).toBe(201);
  ownParty = own.json().party.id;
});

afterAll(async () => {
  await app?.close();
  await server?.close();
  delete process.env[CREDENTIAL_KEY_ENV];
  delete process.env[PREVIOUS_CREDENTIAL_KEYS_ENV];
  await cleanUp();
});

beforeEach(() => {
  server.calls.length = 0;
  server.requireBearer = null;
  server.answerStatus = null;
  server.redirectTo = null;
  server.callDelayMs = 0;
  process.env[CREDENTIAL_KEY_ENV] = KEY;
  delete process.env[PREVIOUS_CREDENTIAL_KEYS_ENV];
});

describe("a credential given when a connection is added", () => {
  it("reaches the server, and is kept only sealed: not in the row, the response or the log", async () => {
    server.requireBearer = TOKEN;
    const res = await add({ credential: TOKEN });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(TOKEN);
    // The server was asked for its tools with it, as the add does.
    expect(res.json().looked).toMatchObject({ answered: true });
    const id = res.json().connection.id as string;
    expect(res.json().connection.credential).toMatchObject({ source: "stored", env: null, set: true, stored: { key: "current" } });

    const row = await rowText(id);
    expect(row).not.toContain(TOKEN);
    const [stored] = await rawQuery<{ credential_sealed: string; credential_key_id: string; credential_set_by: string }>(
      `SELECT credential_sealed, credential_key_id, credential_set_by FROM connections WHERE id = $1`,
      [id]
    );
    expect(stored!.credential_sealed.startsWith("v1.")).toBe(true);
    expect(stored!.credential_set_by).toBe(admin.id);
    expect(await logText()).not.toContain(TOKEN);
    // The list says the same, and nothing more.
    const list = await as(admin, { url: "/connections" });
    expect(list.body).not.toContain(TOKEN);
    expect(list.json().can_keep_credentials).toBe(true);
  });

  it("is refused with a variable named as well, and where the deployment has no key", async () => {
    const both = await add({ credential: TOKEN, credential_env: "CONNECTION_DBTEST_NOTES" });
    expect(both.statusCode, both.body).toBe(400);
    expect(both.json().code).toBe("INVALID_CREDENTIAL");

    delete process.env[CREDENTIAL_KEY_ENV];
    const before = (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM connections`))[0]!.n;
    const noKey = await add({ credential: TOKEN });
    expect(noKey.statusCode, noKey.body).toBe(409);
    expect(noKey.json().code).toBe("NO_CREDENTIAL_KEY");
    expect(noKey.json().error).toContain(CREDENTIAL_KEY_ENV);
    expect((await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM connections`))[0]!.n).toBe(before);
    expect((await as(admin, { url: "/connections" })).json().can_keep_credentials).toBe(false);
  });

  it("is refused with Bearer in front, since it is sent as a bearer token", async () => {
    const res = await add({ credential: `Bearer ${TOKEN}` });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe("INVALID_CREDENTIAL");
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("giving, replacing and removing it on an existing connection", () => {
  it("replaces a variable, is logged without its value, and is removed", async () => {
    const { id } = await added({ credential_env: "CONNECTION_DBTEST_NOTES" });
    const put = await as(admin, { method: "PUT", url: `/connections/${id}/credential`, payload: { credential: TOKEN } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain(TOKEN);
    expect(put.json()).toMatchObject({ replaced: false, connection: { credential: { source: "stored", env: null, set: true } } });

    // The fake server answers only the token it was told to require.
    server.requireBearer = TOKEN;
    expect(await look(id)).toMatchObject({ answered: true });

    const again = await as(admin, { method: "PUT", url: `/connections/${id}/credential`, payload: { credential: "a-new-token" } });
    expect(again.json().replaced).toBe(true);
    expect(await look(id)).toMatchObject({ answered: false });

    const entries = (await as(admin, { url: "/permissions/log?limit=50" })).json().entries as Array<Record<string, unknown>>;
    const changes = entries.filter((e) => e.event === "connection_changed").map((e) => e.changed);
    expect(changes).toContainEqual(["stored_credential", "credential_env"]);
    expect(changes).toContainEqual(["stored_credential"]);
    expect(await logText()).not.toContain(TOKEN);
    expect(await logText()).not.toContain("a-new-token");

    const del = await as(admin, { method: "DELETE", url: `/connections/${id}/credential` });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().connection.credential).toMatchObject({ source: null, stored: null });
    expect(await rowText(id)).not.toContain("v1.");
    const twice = await as(admin, { method: "DELETE", url: `/connections/${id}/credential` });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().code).toBe("NOTHING_TO_CHANGE");
  });

  it("is removed when a variable is named instead", async () => {
    const { id } = await added({ credential: TOKEN });
    const res = await as(admin, { method: "PATCH", url: `/connections/${id}`, payload: { credential_env: "CONNECTION_DBTEST_NOTES" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().stored_credential_removed).toBe(true);
    expect(res.json().connection.credential).toMatchObject({ source: "environment", env: "CONNECTION_DBTEST_NOTES", stored: null });
  });

  it("takes a signed-in session: an administrator's own key cannot give or remove one", async () => {
    const { id } = await added();
    const key = await createApiKey({ userId: admin.id, name: "dbtest credentials key" });
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/connections/${id}/credential`,
        headers: { "x-api-key": key.plaintext },
        ...(method === "PUT" ? { payload: { credential: TOKEN } } : {}),
      });
      expect(res.statusCode, `${method}: ${res.body}`).toBe(403);
      expect(res.json().code).toBe("SESSION_REQUIRED");
    }
    expect((await credentialOf(id)).source).toBeNull();
  });

  it("is the administrator's who reads the connection's label: one who does not is told it does not exist", async () => {
    const { id } = await added();
    const second = await signIn("cred-second-admin");
    const g = await as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "administer", account_id: second.id } });
    expect(g.statusCode, g.body).toBe(201);
    const res = await as(second, { method: "PUT", url: `/connections/${id}/credential`, payload: { credential: TOKEN } });
    expect(res.statusCode, res.body).toBe(404);
    expect((await credentialOf(id)).source).toBeNull();
  });
});

describe("bound to the address it was given for", () => {
  it("is removed when the address changes, and is not given back by changing it back", async () => {
    const { id } = await added({ credential: TOKEN });
    const moved = await as(admin, { method: "PATCH", url: `/connections/${id}`, payload: { url: `${server.url}?moved=1` } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().stored_credential_removed).toBe(true);
    expect(moved.json().connection.credential).toMatchObject({ source: null, stored: null });
    const back = await as(admin, { method: "PATCH", url: `/connections/${id}`, payload: { url: server.url } });
    expect(back.json().connection.credential.source).toBeNull();

    const entries = (await as(admin, { url: "/permissions/log?limit=50" })).json().entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.changed)).toContainEqual(["url", "stored_credential_removed"]);
  });

  it("is removed when the transport changes", async () => {
    const { id } = await added({ credential: TOKEN });
    const res = await as(admin, { method: "PATCH", url: `/connections/${id}`, payload: { transport: "sse" } });
    expect(res.json().stored_credential_removed).toBe(true);
  });

  it("does not open in another connection's row, and nothing is sent", async () => {
    const { id: from } = await added({ credential: TOKEN });
    const { id: to } = await added();
    // Written around the service, as a row copied by hand or by any other way would be.
    await runAtLabel(LABEL, "the credentials test", () =>
      rawQuery(
        `UPDATE connections t SET credential_sealed = f.credential_sealed, credential_key_id = f.credential_key_id,
                credential_set_at = f.credential_set_at
           FROM connections f WHERE f.id = $1 AND t.id = $2`,
        [from, to]
      )
    );
    server.requireBearer = TOKEN;
    const requests = server.requests;
    expect(await look(to)).toEqual({ answered: false, problem: STORED_CREDENTIAL_NOT_OPENED, kind: "credential_missing" });
    expect(server.requests).toBe(requests);
  });
});

describe("the key", () => {
  it("missing: the view says so, nothing is sent, and the check says why", async () => {
    const { id } = await added({ credential: TOKEN });
    delete process.env[CREDENTIAL_KEY_ENV];
    expect(await credentialOf(id)).toMatchObject({ source: "stored", set: false, stored: { key: "missing" } });
    const requests = server.requests;
    expect(await look(id)).toEqual({ answered: false, problem: STORED_CREDENTIAL_NO_KEY, kind: "credential_missing" });
    expect(server.requests).toBe(requests);
    const checks = await runAtLabel(LABEL, "the credentials test", () => checkConnections());
    expect(checks.find((c) => c.id === id)!.credential).toEqual({ source: "stored", env: null, set: false });
  });

  it("replaced: credentials open under the previous key, and resealing moves them to the new one", async () => {
    // Only this test's connection, so that what resealing counts is its own.
    await rawQuery(`DELETE FROM connections`);
    server.requireBearer = TOKEN;
    const { id } = await added({ credential: TOKEN });
    const newKey = randomBytes(32).toString("base64");
    process.env[CREDENTIAL_KEY_ENV] = newKey;
    process.env[PREVIOUS_CREDENTIAL_KEYS_ENV] = KEY;
    expect(await credentialOf(id)).toMatchObject({ set: true, stored: { key: "previous" } });
    expect(await look(id)).toMatchObject({ answered: true });

    const before = await rowText(id);
    const resealed = await resealStoredCredentials();
    expect(resealed).toEqual({ ok: true, resealed: 1, already_current: 0, not_opened: [] });
    expect(await rowText(id)).not.toBe(before);
    expect(await rowText(id)).not.toContain(TOKEN);

    // The old key can go.
    delete process.env[PREVIOUS_CREDENTIAL_KEYS_ENV];
    expect(await credentialOf(id)).toMatchObject({ set: true, stored: { key: "current" } });
    expect(await look(id)).toMatchObject({ answered: true });
    // Run again, it changes nothing.
    expect(await resealStoredCredentials()).toEqual({ ok: true, resealed: 0, already_current: 1, not_opened: [] });
  });

  it("one that does not open is left as it is and named", async () => {
    await rawQuery(`DELETE FROM connections`);
    const { id: from } = await added({ credential: TOKEN });
    const { id: to } = await added();
    await runAtLabel(LABEL, "the credentials test", () =>
      rawQuery(
        `UPDATE connections t SET credential_sealed = f.credential_sealed, credential_key_id = f.credential_key_id,
                credential_set_at = f.credential_set_at
           FROM connections f WHERE f.id = $1 AND t.id = $2`,
        [from, to]
      )
    );
    process.env[PREVIOUS_CREDENTIAL_KEYS_ENV] = KEY;
    process.env[CREDENTIAL_KEY_ENV] = randomBytes(32).toString("base64");
    const before = await rowText(to);
    const out = await resealStoredCredentials();
    expect(out.ok && out.resealed).toBe(1);
    expect(out.ok && out.not_opened.map((c) => c.id)).toEqual([to]);
    expect(await rowText(to)).toBe(before);
  });
});

describe("who can read the sealed column at all", () => {
  it("not the roles read-only SQL runs as, and no view they read carries it", async () => {
    const [grants] = await rawQuery<{ sql: boolean }>(
      `SELECT has_column_privilege('minerval_sql', 'public.connections', 'credential_sealed', 'SELECT') AS sql`
    );
    expect(grants!.sql).toBe(false);
    const views = await rawQuery<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public_read' AND c.relkind = 'v'
          AND pg_get_viewdef(c.oid) ILIKE '%credential_sealed%'`
    );
    expect(views).toEqual([]);
  });

  it("a run at a label that does not read the connection's does not see the row", async () => {
    const { id } = await added({ credential: TOKEN });
    const rows = await runAtLabel(OTHER, "the credentials test", () =>
      rawQuery(`SELECT credential_sealed FROM connections WHERE id = $1`, [id])
    );
    expect(rows).toEqual([]);
  });
});
