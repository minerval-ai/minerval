/**
 * This deployment's connection to minerval.ai, its own side
 * (docs/organizations.md, "Connecting"; src/services/public-graph-connection.ts,
 * src/services/public-graph-client.ts, the /outside/connection routes):
 * against the real members-only app and tables, with minerval.ai played by a
 * fake that checks every signature with the public graph's own check
 * (services/request-signature.ts). The public graph's side is tested in
 * connected-deployments.test.ts.
 *
 * Connecting makes a key and shows a code; an approval is learnt with no
 * restart; the private key is never returned and is the owner's alone; and
 * once connected, the outward calls and the usage reports are signed with
 * the key and carry no bearer key. Disconnecting retires it there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "connection-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-connection-administrator";
const API = "https://api.fake-minerval.test";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "connection-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-connection-administrator";
  process.env.DEPLOYMENT_HOSTING = "own_machines";
  delete process.env.PUBLIC_GRAPH_API_URL;
  delete process.env.PUBLIC_GRAPH_API_KEY;
  delete process.env.USAGE_REPORT_URL;
  delete process.env.USAGE_REPORT_API_KEY;
  delete process.env.USAGE_REPORT_DIR;
  delete process.env.PUBLIC_GRAPH_PRICE;
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery, withTransaction } from "../../src/db/client.js";
import { forgetConnection, setPublicGraphFetch } from "../../src/services/public-graph-client.js";
import { setConnectionFetch } from "../../src/services/public-graph-connection.js";
import { call, publicGraph } from "../../src/services/outbound-service.js";
import { sendUsageReports } from "../../src/services/usage-report-service.js";
import { checkSignature, parseSignatureHeader, sha256Hex, EMPTY_BODY_HASH } from "../../src/services/request-signature.js";

let app: FastifyInstance;

/** minerval.ai, as far as this deployment can see it. */
const fake = {
  key: null as string | null,
  code: "WDJB-MJHT",
  approved: false,
  grants: ["read_feed", "report_usage", "act"] as string[],
  retired: false,
  seen: [] as Array<{ method: string; path: string; signed: boolean; bearer: boolean }>,
  reports: [] as string[],
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = typeof init?.body === "string" ? init.body : null;
  const presented = parseSignatureHeader(headers.authorization ?? "");
  fake.seen.push({ method, path: url.pathname, signed: !!presented, bearer: !!headers["x-api-key"] });
  if (url.pathname === "/deployments/connect" && method === "POST") {
    const asked = JSON.parse(body ?? "{}") as { public_key: string };
    // Signed with the key it names, as the public graph checks it.
    if (!presented || checkSignature(presented, asked.public_key, { host: url.host, method, path: url.pathname, bodyHash: sha256Hex(body ?? "") })) {
      return answer(401, { error: "bad signature", code: "SIGNATURE_BAD_SIGNATURE" });
    }
    fake.key = asked.public_key;
    return answer(201, {
      code: fake.code,
      key_id: presented.keyId,
      verification_uri: "https://fake-minerval.test/connect",
      verification_uri_complete: `https://fake-minerval.test/connect?code=${fake.code}`,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      expires_in: 900,
      interval: 5,
    });
  }
  // Everything else must be signed with the key the deployment connected with.
  if (!presented || !fake.key) return answer(401, { error: "unsigned", code: "SIGNATURE_MALFORMED" });
  const fault = checkSignature(presented, fake.key, {
    host: url.host,
    method,
    path: `${url.pathname}${url.search}`,
    bodyHash: body === null ? EMPTY_BODY_HASH : sha256Hex(body),
  });
  if (fault) return answer(401, { error: fault, code: `SIGNATURE_${fault}` });
  if (url.pathname === `/deployments/connect/${fake.code}`) {
    return answer(
      200,
      fake.approved
        ? { state: "approved", deployment: { id: randomUUID(), name: "Research" }, organization: { id: randomUUID(), name: "Acme Corp" }, grants: fake.grants }
        : { state: "waiting", expires_at: new Date(Date.now() + 60_000).toISOString() }
    );
  }
  if (fake.retired) return answer(401, { error: "No connected deployment has this key.", code: "DEPLOYMENT_NOT_CONNECTED" });
  if (url.pathname === "/organizations/me") {
    return answer(200, { organization: { name: "Acme Corp" }, deployment: { name: "Research", grants: fake.grants } });
  }
  if (url.pathname === "/users/me") return answer(200, { user: { id: randomUUID(), external_id: "org:x", display_name: "Acme Corp" } });
  if (url.pathname === "/usage-reports" && method === "POST") {
    fake.reports.push(body ?? "");
    return answer(201, { recorded: true, charged: false });
  }
  if (url.pathname === "/deployments/me/retire" && method === "POST") {
    fake.retired = true;
    return answer(200, { retired: true });
  }
  return answer(404, { error: "not here" });
};

async function signIn(externalId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().user.id;
}

function asAdmin(request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": FIRST_ADMINISTRATOR },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  // Start from a deployment that has never had an administrator and is not connected. Files in one
  // worker share its database, and the FIRST_ADMINISTRATOR setting grants nothing once any account has
  // ever administered (permission-service.ts, establishFirstAdministrator), so what an earlier file left
  // would otherwise decide whether this one passes.
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM public_graph_connection`);
  forgetConnection();
  setConnectionFetch(fakeFetch);
  setPublicGraphFetch(fakeFetch);
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  await signIn(FIRST_ADMINISTRATOR, "Dana");
});

afterAll(async () => {
  setConnectionFetch(null);
  setPublicGraphFetch(null);
  await app?.close();
});

describe("connecting to minerval.ai", () => {
  it("makes a key, shows a code, and learns an approval with no restart", async () => {
    expect((await asAdmin({ url: "/outside/connection" })).json().connection).toBeNull();

    const start = await asAdmin({
      method: "POST",
      url: "/outside/connection",
      payload: { name: "Research", grants: ["read_feed", "report_usage", "act"], api_url: API },
    });
    expect(start.statusCode, start.body).toBe(201);
    expect(start.json().connection).toMatchObject({ state: "waiting", code: fake.code, connected: false });
    expect(start.body).not.toContain("PRIVATE KEY");

    // Not yet approved: still waiting.
    const waiting = await asAdmin({ method: "POST", url: "/outside/connection/check" });
    expect(waiting.json().connection.state).toBe("waiting");

    fake.approved = true;
    const approved = await asAdmin({ method: "POST", url: "/outside/connection/check" });
    expect(approved.json().connection).toMatchObject({
      state: "connected",
      connected: true,
      organization: { name: "Acme Corp" },
      grants: ["read_feed", "report_usage", "act"],
    });
    expect(approved.body).not.toContain("PRIVATE KEY");

    const acts = await rawQuery<{ kind: string; result: string }>(
      `SELECT kind, result FROM outward_acts WHERE kind = 'connect_deployment' ORDER BY at DESC LIMIT 1`
    );
    expect(acts[0]).toEqual({ kind: "connect_deployment", result: "done" });
  });

  it("keeps the key the owner's alone where reads are held to a clearance", async () => {
    // Turn enforcement on inside a transaction and look, then roll it all back.
    const seen = await withTransaction(async (tx) => {
      await tx.query(`SELECT * FROM public.minerval_enforcement_sync(true)`);
      const [row] = await tx.query<{ cleared: boolean; views: boolean }>(
        `SELECT has_table_privilege('minerval_cleared', 'public.public_graph_connection', 'SELECT') AS cleared,
                has_table_privilege('minerval_sql_views', 'public.public_graph_connection', 'SELECT') AS views`
      );
      throw Object.assign(new Error("rollback"), { seen: row });
    }).catch((err: { seen?: { cleared: boolean; views: boolean } }) => err.seen);
    expect(seen).toEqual({ cleared: false, views: false });
  });

  it("signs every call to the public graph once connected, with no bearer key", async () => {
    forgetConnection();
    fake.seen.length = 0;
    const graph = await publicGraph();
    expect(graph.signed).toBe(true);
    const me = await call(graph, "GET", "/users/me");
    expect(me.status).toBe(200);
    expect(fake.seen.at(-1)).toMatchObject({ path: "/users/me", signed: true, bearer: false });
  });

  it("sends the usage report signed, to the connection's address", async () => {
    await rawQuery(
      `INSERT INTO usage_reports (deployment_id, period, revision, body, body_hash, spent_micro_owls)
       VALUES ($1, '2001-07-01', 0, $2, $3, 0)`,
      [randomUUID(), '{"probe":true}', sha256Hex('{"probe":true}')]
    );
    const out = await sendUsageReports({ fetch: fakeFetch });
    expect(out.stopped, String(out.stopped)).toBeNull();
    expect(fake.reports).toContain('{"probe":true}');
    expect(fake.seen.filter((s) => s.path === "/usage-reports").every((s) => s.signed && !s.bearer)).toBe(true);
  });

  it("disconnects by retiring itself there and forgetting the key", async () => {
    const res = await asAdmin({ method: "DELETE", url: "/outside/connection" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().retired_there).toBe(true);
    expect(fake.retired).toBe(true);
    expect((await asAdmin({ url: "/outside/connection" })).json().connection).toBeNull();
    const [n] = await rawQuery<{ n: string }>(`SELECT count(*)::text AS n FROM public_graph_connection`);
    expect(n!.n).toBe("0");
  });
});
