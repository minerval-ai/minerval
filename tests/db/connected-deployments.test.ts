/**
 * Connected deployments, the public graph's side (docs/organizations.md, "A
 * deployment's identity" and "Connecting"; src/routes/deployments.ts,
 * src/services/deployment-service.ts, the signed method in
 * src/server/plugins/auth.ts), against the real app and tables: asking to
 * connect with a key, an admin approving with chosen grants, the deployment
 * learning it, and then every signed request held to its key, its host, its
 * time, its body, its grants and the routes deployments may call, with a
 * write never accepted twice.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "deployments-web-tier-key";
const HOST = "api.test";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "deployments-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { generateSigningKey, parseSigningKey } from "../../src/services/mirror-batch.js";
import { signRequest } from "../../src/services/request-signature.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
}

interface Key {
  privateKey: ReturnType<typeof parseSigningKey>;
  publicKey: string;
  keyId: string;
}

function newKey(): Key {
  const made = generateSigningKey();
  return { privateKey: parseSigningKey(made.privateKeyPem), publicKey: made.publicKey, keyId: made.keyId };
}

async function signIn(name: string): Promise<Person> {
  const externalId = `github:${name}-${randomUUID()}`;
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

/** A request signed with a key, as a deployment sends it; `sign` overrides what the signature covers. */
function signed(
  key: Key,
  request: { method?: string; url: string; body?: unknown },
  sign: { host?: string; body?: string; now?: Date } = {}
) {
  const method = request.method ?? "GET";
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const authorization = signRequest(
    key.privateKey,
    key.publicKey,
    { host: sign.host ?? HOST, method, path: request.url, body: sign.body ?? body },
    sign.now
  );
  return {
    authorization,
    send: (auth = authorization) =>
      app.inject({
        method: method as "GET",
        url: request.url,
        headers: { host: HOST, authorization: auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { payload: body } : {}),
      }),
  };
}

async function makeOrganization(admin: Person): Promise<string> {
  const res = await as(admin, { method: "POST", url: "/organizations", payload: { name: "Acme Corp" } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().organization.id;
}

async function askToConnect(key: Key, grants = ["read_feed", "report_usage", "publish", "spend", "speak"]): Promise<string> {
  const res = await signed(key, {
    method: "POST",
    url: "/deployments/connect",
    body: { public_key: key.publicKey, name: "Research", hosting: "own_machines", grants, report_identifier: randomUUID() },
  }).send();
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json().verification_uri_complete).toMatch(/\/connect\?code=[A-Z]{4}-[A-Z]{4}$/);
  return res.json().code;
}

/** A deployment connected for an organization with the grants given. */
async function connected(admin: Person, org: string, grants: string[]): Promise<Key> {
  const key = newKey();
  const code = await askToConnect(key);
  const ok = await as(admin, { method: "POST", url: `/connect-requests/${code}/approve`, payload: { organization_id: org, grants } });
  expect(ok.statusCode, ok.body).toBe(200);
  return key;
}

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("connecting", () => {
  it("is asked with a key, approved by an admin with the grants they choose, and learnt by the deployment", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = newKey();
    const code = await askToConnect(key);

    const poll = () => signed(key, { url: `/deployments/connect/${code}` }).send();
    expect((await poll()).json().state).toBe("waiting");

    const read = await as(dana, { url: `/connect-requests/${code.toLowerCase().replace("-", "")}` });
    expect(read.json().request).toMatchObject({
      suggested_name: "Research",
      hosting_words: "the organization's own machines",
      key_id: key.keyId,
      asked_grants: ["read_feed", "report_usage", "publish", "spend", "speak"],
      state: "waiting",
      your_organizations: [{ id: org, name: "Acme Corp" }],
    });

    const approve = await as(dana, {
      method: "POST",
      url: `/connect-requests/${code}/approve`,
      payload: { organization_id: org, name: "Research lab", grants: ["read_feed", "spend"] },
    });
    expect(approve.statusCode, approve.body).toBe(200);

    const learnt = (await poll()).json();
    expect(learnt).toMatchObject({
      state: "approved",
      deployment: { name: "Research lab" },
      organization: { id: org, name: "Acme Corp" },
      grants: ["read_feed", "spend"],
    });
    const again = await as(dana, { method: "POST", url: `/connect-requests/${code}/approve`, payload: { organization_id: org, grants: ["spend"] } });
    expect(again.json().code).toBe("CODE_USED");
    const [logged] = await rawQuery<{ actor_id: string }>(
      `SELECT actor_id FROM organization_log WHERE organization_id = $1 AND kind = 'deployment_approved'`,
      [org]
    );
    expect(logged!.actor_id).toBe(dana.id);
  });

  it("is approved only by an admin of the organization, and only with what was asked", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    const key = newKey();
    const code = await askToConnect(key, ["read_feed"]);
    const byStranger = await as(priya, { method: "POST", url: `/connect-requests/${code}/approve`, payload: { organization_id: org, grants: ["read_feed"] } });
    expect(byStranger.json().code).toBe("ADMIN_REQUIRED");
    const more = await as(dana, { method: "POST", url: `/connect-requests/${code}/approve`, payload: { organization_id: org, grants: ["spend"] } });
    expect(more.json().code).toBe("GRANT_NOT_ASKED");
  });

  it("reads phase 2's act, which a deployment built before the split still asks for, as the four it became", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = newKey();
    const code = await askToConnect(key, ["read_feed", "act"]);
    const read = await as(dana, { url: `/connect-requests/${code}` });
    expect(read.json().request.asked_grants).toEqual(["read_feed", "spend", "speak", "propose", "take_up"]);
    const ok = await as(dana, { method: "POST", url: `/connect-requests/${code}/approve`, payload: { organization_id: org, grants: ["act"] } });
    expect(ok.statusCode, ok.body).toBe(200);
    const learnt = (await signed(key, { url: `/deployments/connect/${code}` }).send()).json();
    expect(learnt.grants).toEqual(["propose", "speak", "spend", "take_up"]);
  });

  it("tells the deployment when it was denied, and when its code has expired", async () => {
    const dana = await signIn("dana");
    await makeOrganization(dana);
    const denied = newKey();
    const code = await askToConnect(denied);
    expect((await as(dana, { method: "POST", url: `/connect-requests/${code}/deny` })).statusCode).toBe(200);
    expect((await signed(denied, { url: `/deployments/connect/${code}` }).send()).json().state).toBe("denied");

    const late = newKey();
    const lateCode = await askToConnect(late);
    await rawQuery(`UPDATE deployment_connect_requests SET expires_at = now() - interval '1 second' WHERE code = $1`, [lateCode]);
    expect((await signed(late, { url: `/deployments/connect/${lateCode}` }).send()).json().state).toBe("expired");
  });

  it("is asked only with a signature by the key it names, and polled only by that key", async () => {
    const key = newKey();
    const other = newKey();
    const res = await signed(other, {
      method: "POST",
      url: "/deployments/connect",
      body: { public_key: key.publicKey, name: "X", hosting: "own_machines", grants: ["read_feed"] },
    }).send();
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SIGNATURE_KEY_MISMATCH");
    const code = await askToConnect(key);
    expect((await signed(other, { url: `/deployments/connect/${code}` }).send()).statusCode).toBe(401);
  });
});

describe("a connected deployment's signed requests", () => {
  it("are its organization's, on the routes its grants open", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = await connected(dana, org, ["read_feed", "spend"]);

    const me = await signed(key, { url: "/organizations/me" }).send();
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ organization: { id: org, name: "Acme Corp" }, deployment: { grants: ["read_feed", "spend"] } });
    expect((await signed(key, { url: "/users/me" }).send()).json().user).toMatchObject({ id: org, kind: "organization" });

    // A body the route's schema takes, so the grant is what refuses it.
    const publish = await signed(key, {
      method: "POST",
      url: "/publishers",
      body: { public_key: key.publicKey, hosting: "own_machines", signature: "x".repeat(88) },
    }).send();
    expect(publish.statusCode, publish.body).toBe(403);
    expect(publish.json()).toMatchObject({ code: "GRANT_NOT_HELD", grant: "publish" });

    const mint = await signed(key, { method: "POST", url: "/api-keys", body: { name: "k" } }).send();
    expect(mint.statusCode).toBe(403);
    expect(mint.json().code).toBe("NOT_A_DEPLOYMENT_ROUTE");
    const invite = await signed(key, { method: "POST", url: `/organizations/${org}/invitations`, body: { role: "admin" } }).send();
    expect(invite.json().code).toBe("NOT_A_DEPLOYMENT_ROUTE");
  });

  it("are refused when signed for another host, another body, or too long ago", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = await connected(dana, org, ["read_feed", "spend"]);
    const url = `/mandates/${randomUUID()}/contribute`;

    const otherHost = await signed(key, { method: "POST", url, body: { owls: 1 } }, { host: "other.example" }).send();
    expect(otherHost.json().code).toBe("SIGNATURE_BAD_SIGNATURE");
    const otherBody = await signed(key, { method: "POST", url, body: { owls: 1 } }, { body: JSON.stringify({ owls: 99 }) }).send();
    expect(otherBody.json().code).toBe("SIGNATURE_BAD_SIGNATURE");
    const stale = await signed(key, { url: "/organizations/me" }, { now: new Date(Date.now() - 10 * 60 * 1000) }).send();
    expect(stale.json().code).toBe("SIGNATURE_STALE");
    const unknown = await signed(newKey(), { url: "/organizations/me" }).send();
    expect(unknown.json().code).toBe("DEPLOYMENT_NOT_CONNECTED");
  });

  it("make a write once, and record it for the organization; a read is neither", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = await connected(dana, org, ["spend"]);
    const write = signed(key, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, body: { owls: 1 } });
    const first = await write.send();
    expect(first.statusCode).not.toBe(401);
    const replay = await write.send();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("SIGNATURE_REPLAYED");

    const read = signed(key, { url: "/organizations/me" });
    expect((await read.send()).statusCode).toBe(200);
    expect((await read.send()).statusCode).toBe(200);

    let writes: Array<{ method: string; route: string }> = [];
    for (let i = 0; i < 50 && writes.length === 0; i++) {
      writes = (await as(dana, { url: `/organizations/${org}/deployments` })).json().deployments[0].recent_writes;
      if (writes.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(writes.map((w) => `${w.method} ${w.route}`)).toEqual(["POST /mandates/:id/contribute"]);
  });

  it("stop when a grant is withdrawn or the deployment retired", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = await connected(dana, org, ["read_feed", "spend"]);
    const grants = (await as(dana, { url: `/organizations/${org}/grants` })).json().grants as Array<{ id: string; permission: string; deployment_id: string | null }>;
    const spend = grants.find((g) => g.permission === "spend" && g.deployment_id);
    expect((await as(dana, { method: "DELETE", url: `/organizations/${org}/grants/${spend!.id}` })).statusCode).toBe(200);
    const act = await signed(key, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, body: { owls: 1 } }).send();
    expect(act.json()).toMatchObject({ code: "GRANT_NOT_HELD", grant: "spend" });
    // Granted again from minerval.ai, it works again at once.
    const deploymentId = spend!.deployment_id!;
    const again = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", deployment_id: deploymentId } });
    expect(again.statusCode, again.body).toBe(201);
    const back = await signed(key, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, body: { owls: 1 } }).send();
    expect(back.statusCode).not.toBe(403);
    const buy = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "buy", deployment_id: deploymentId } });
    expect(buy.json().code).toBe("BAD_PERMISSION");
    await rawQuery(`UPDATE deployments SET retired_at = now() WHERE key_id = $1`, [key.keyId]);
    expect((await signed(key, { url: "/organizations/me" }).send()).json().code).toBe("DEPLOYMENT_NOT_CONNECTED");
  });
});
