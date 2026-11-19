/**
 * Control over connected deployments, the public graph's side
 * (docs/organizations.md, phase 5), against the real app and tables: an admin
 * retiring a deployment; a deployment replacing its key with proof it holds
 * the new one; reading its own standing whatever it holds; "Minerval's
 * machines" accepted only with a hosting token Minerval's operator made; a
 * publishing key registered over the connection naming the deployment; and
 * connecting by hand, with the feed downloaded and usage reports uploaded as
 * files.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";

const SERVICE_KEY = "control-web-tier-key";
const OPERATOR_KEY = "control-operator-key";
const HOST = "api.test";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "control-web-tier-key";
  process.env.MINERVAL_OPERATOR_KEY = "control-operator-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { generateSigningKey, parseSigningKey } from "../../src/services/mirror-batch.js";
import { signRequest } from "../../src/services/request-signature.js";
import { signByHandRequest, signKeyReplacement } from "../../src/services/deployment-service.js";
import { registrationStatement } from "../../src/published-page/verify.js";
import { seedClaim } from "./helpers.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
}

interface Key {
  pem: string;
  privateKey: ReturnType<typeof parseSigningKey>;
  publicKey: string;
  keyId: string;
}

function newKey(): Key {
  const made = generateSigningKey();
  return { pem: made.privateKeyPem, privateKey: parseSigningKey(made.privateKeyPem), publicKey: made.publicKey, keyId: made.keyId };
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

function as(person: Person, request: { method?: string; url: string; payload?: unknown; organization?: string }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: {
      "x-api-key": SERVICE_KEY,
      "x-acting-user": person.externalId,
      ...(request.organization ? { "x-acting-organization": request.organization } : {}),
    },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

function signed(key: Key, request: { method?: string; url: string; body?: unknown }) {
  const method = request.method ?? "GET";
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const authorization = signRequest(key.privateKey, key.publicKey, { host: HOST, method, path: request.url, body });
  return app.inject({
    method: method as "GET",
    url: request.url,
    headers: { host: HOST, authorization, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: body } : {}),
  });
}

async function makeOrganization(admin: Person): Promise<string> {
  const res = await as(admin, { method: "POST", url: "/organizations", payload: { name: "Acme Corp" } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().organization.id;
}

async function ask(key: Key, body: Record<string, unknown> = {}) {
  return signed(key, {
    method: "POST",
    url: "/deployments/connect",
    body: { public_key: key.publicKey, name: "Research", hosting: "own_machines", ...body },
  });
}

/** A deployment connected for an organization with the grants given. */
async function connected(admin: Person, org: string, grants: string[], body: Record<string, unknown> = {}): Promise<{ key: Key; id: string }> {
  const key = newKey();
  const asked = await ask(key, body);
  expect(asked.statusCode, asked.body).toBe(201);
  const ok = await as(admin, { method: "POST", url: `/connect-requests/${asked.json().code}/approve`, payload: { organization_id: org, grants } });
  expect(ok.statusCode, ok.body).toBe(200);
  return { key, id: ok.json().deployment_id };
}

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("retiring a deployment from minerval.ai", () => {
  it("stops its key at once and withdraws its grants, for an admin only", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    const { key, id } = await connected(dana, org, ["read_feed", "spend"]);
    expect((await signed(key, { url: "/organizations/me" })).statusCode).toBe(200);

    const byStranger = await as(priya, { method: "DELETE", url: `/organizations/${org}/deployments/${id}` });
    expect(byStranger.json().code).toBe("ADMIN_REQUIRED");
    const retired = await as(dana, { method: "DELETE", url: `/organizations/${org}/deployments/${id}` });
    expect(retired.statusCode, retired.body).toBe(200);

    const after = await signed(key, { url: "/organizations/me" });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("DEPLOYMENT_NOT_CONNECTED");
    const [{ n }] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM organization_grants WHERE deployment_id = $1 AND withdrawn_at IS NULL`,
      [id]
    );
    expect(n).toBe(0);
    const kinds = (await rawQuery<{ kind: string }>(`SELECT kind FROM organization_log WHERE organization_id = $1`, [org])).map((r) => r.kind);
    expect(kinds).toContain("deployment_retired");
  });

  it("lets a deployment whose every grant was withdrawn still read that it holds none", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const { key, id } = await connected(dana, org, ["read_feed"]);
    const [grant] = await rawQuery<{ id: string }>(`SELECT id FROM organization_grants WHERE deployment_id = $1`, [id]);
    await as(dana, { method: "DELETE", url: `/organizations/${org}/grants/${grant!.id}` });
    const me = await signed(key, { url: "/organizations/me" });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().deployment.grants).toEqual([]);
  });
});

describe("replacing the connection key", () => {
  it("puts the new key in place of the old one, keeping its grants, given the new key's proof", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const { key, id } = await connected(dana, org, ["read_feed", "take_up"]);
    const next = newKey();

    const forged = await signed(key, {
      method: "POST",
      url: "/deployments/me/key",
      body: { public_key: next.publicKey, proof: signKeyReplacement(newKey().pem, id, next.publicKey) },
    });
    expect(forged.json().code).toBe("BAD_PROOF");

    const replaced = await signed(key, {
      method: "POST",
      url: "/deployments/me/key",
      body: { public_key: next.publicKey, proof: signKeyReplacement(next.pem, id, next.publicKey) },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().key_id).toBe(next.keyId);

    expect((await signed(key, { url: "/organizations/me" })).statusCode).toBe(401);
    const me = await signed(next, { url: "/organizations/me" });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().deployment).toMatchObject({ id, grants: ["read_feed", "take_up"] });
    const [logged] = await rawQuery<{ credential: string; detail: { old_key_id: string } }>(
      `SELECT credential, detail FROM organization_log WHERE organization_id = $1 AND kind = 'deployment_key_replaced'`,
      [org]
    );
    expect(logged).toMatchObject({ credential: "deployment", detail: { old_key_id: key.keyId } });
  });
});

describe("Minerval's machines, checked", () => {
  it("is accepted only with a live hosting token, and no other word is accepted with one", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const claimed = await ask(newKey(), { hosting: "minerval" });
    expect(claimed.json().code).toBe("HOSTING_NOT_MINERVAL");

    const made = await app.inject({
      method: "POST",
      url: "/operator/hosted-deployment-tokens",
      headers: { "x-operator-key": OPERATOR_KEY },
      payload: { note: "Acme Corp, eu-west-1" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const token = made.json().token as string;

    expect((await ask(newKey(), { hosting: "own_machines", hosting_token: token })).json().code).toBe("HOSTING_TOKEN_MISMATCH");
    expect((await ask(newKey(), { hosting: "minerval", hosting_token: "mht_nobody" })).json().code).toBe("BAD_HOSTING_TOKEN");

    const first = await connected(dana, org, ["publish"], { hosting: "minerval", hosting_token: token });
    const [row] = await rawQuery<{ hosted: boolean }>(`SELECT hosted_by_minerval AS hosted FROM deployments WHERE id = $1`, [first.id]);
    expect(row!.hosted).toBe(true);

    // A second deployment with the same token waits until the first is retired.
    const second = newKey();
    const asked = await ask(second, { hosting: "minerval", hosting_token: token });
    const refused = await as(dana, { method: "POST", url: `/connect-requests/${asked.json().code}/approve`, payload: { organization_id: org, grants: ["publish"] } });
    expect(refused.json().code).toBe("HOSTING_TOKEN_IN_USE");

    const listed = await app.inject({ method: "GET", url: "/operator/hosted-deployment-tokens", headers: { "x-operator-key": OPERATOR_KEY } });
    expect(JSON.stringify(listed.json())).not.toContain(token);
  });
});

describe("a publishing key registered over the connection", () => {
  it("names the deployment, says the hosting it connected with, and is refused saying another", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const { key, id } = await connected(dana, org, ["publish"]);
    const [account] = await rawQuery<{ external_id: string }>(`SELECT external_id FROM contributors WHERE id = $1`, [org]);
    const publishing = newKey();
    const statement = (hosting: string, deploymentId: string | null) =>
      cryptoSign(
        null,
        Buffer.from(registrationStatement({ account: account!.external_id, publicKey: publishing.publicKey, hosting, deploymentId }), "utf8"),
        createPrivateKey(publishing.pem)
      ).toString("base64");

    const otherWord = await signed(key, {
      method: "POST",
      url: "/publishers",
      body: { public_key: publishing.publicKey, hosting: "third_party", signature: statement("third_party", id) },
    });
    expect(otherWord.json().error.code).toBe("HOSTING_DIFFERS");
    // A statement that does not name this deployment is not taken over its connection.
    const unnamed = await signed(key, {
      method: "POST",
      url: "/publishers",
      body: { public_key: publishing.publicKey, hosting: "own_machines", signature: statement("own_machines", null) },
    });
    expect(unnamed.json().error.code).toBe("NOT_SIGNED_BY_THE_KEY");

    const ok = await signed(key, {
      method: "POST",
      url: "/publishers",
      body: { public_key: publishing.publicKey, hosting: "own_machines", signature: statement("own_machines", id) },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().in_words).toMatch(/its deployment Research/);
    const record = await app.inject({ method: "GET", url: `/publishers/${org}` });
    expect(record.json().registrations[0].deployment).toMatchObject({ id, name: "Research" });
  });

  it("refuses Minerval's machines from an account key, which no deployment's connection checked", async () => {
    const dana = await signIn("dana");
    const publishing = newKey();
    const signature = cryptoSign(
      null,
      Buffer.from(registrationStatement({ account: dana.externalId, publicKey: publishing.publicKey, hosting: "minerval" }), "utf8"),
      createPrivateKey(publishing.pem)
    ).toString("base64");
    const res = await as(dana, { method: "POST", url: "/publishers", payload: { public_key: publishing.publicKey, hosting: "minerval", signature } });
    expect(res.json().error.code).toBe("HOSTING_NOT_MINERVAL");
  });
});

describe("connecting by hand", () => {
  it("approves a deployment from the signed request it showed, and refuses one changed or stale", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const key = newKey();
    const request = signByHandRequest(key.pem, {
      public_key: key.publicKey,
      name: "Offline lab",
      hosting: "own_machines",
      needs: [{ grant: "read_feed", why: "It follows the public graph from files." }],
    });

    const changed = request.replace("Offline lab", "Someone else");
    const tampered = await as(dana, { method: "POST", url: `/organizations/${org}/deployments/by-hand`, payload: { request: changed, grants: ["read_feed"] } });
    expect(tampered.json().code).toBe("NOT_SIGNED_BY_THE_KEY");
    const garbage = await as(dana, { method: "POST", url: `/organizations/${org}/deployments/by-hand`, payload: { request: "hello", grants: ["read_feed"] } });
    expect(garbage.json().code).toBe("NOT_A_REQUEST");

    const ok = await as(dana, {
      method: "POST",
      url: `/organizations/${org}/deployments/by-hand`,
      payload: { request, grants: ["read_feed", "report_usage"] },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().key_id).toBe(key.keyId);
    const listed = (await as(dana, { url: `/organizations/${org}/deployments` })).json().deployments;
    expect(listed[0]).toMatchObject({ name: "Offline lab", grants: ["read_feed", "report_usage"] });

    // The same request twice is the same key: refused.
    const again = await as(dana, { method: "POST", url: `/organizations/${org}/deployments/by-hand`, payload: { request, grants: ["read_feed"] } });
    expect(again.json().code).toBe("KEY_ALREADY_CONNECTED");
  });

  it("hands a member the next feed batch to carry, logged as a pull, for a deployment holding read_feed", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const { id } = await connected(dana, org, ["read_feed"]);
    const { id: without } = await connected(dana, org, ["report_usage"]);
    const [top] = await rawQuery<{ n: string | null }>(`SELECT max(sequence)::text AS n FROM mirror_feed_batches`);
    const sequence = Number(top?.n ?? 0) + 1;
    await rawQuery(
      `INSERT INTO mirror_feed_batches (sequence, feed_id, kind, part_first, part_last, migration_number, migration_tag, shape, cut_at,
         previous_hash, batch_hash, key_id, row_count, removal_count, body)
       VALUES ($1, $2, 'changes', $1, true, 1, 'x', 'shape', now(), 'prev', $3, 'key', 0, 0, '{"a batch":true}')`,
      [sequence, randomUUID(), `hash-${randomUUID()}`]
    );
    const got = await as(dana, { url: `/organizations/${org}/deployments/${id}/feed?after=${sequence - 1}` });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.body).toBe('{"a batch":true}');
    expect(got.headers["content-disposition"]).toContain(`mirror-batch-${String(sequence).padStart(12, "0")}.json`);
    expect((await as(dana, { url: `/organizations/${org}/deployments/${id}/feed?after=${sequence}` })).statusCode).toBe(204);
    const refused = await as(dana, { url: `/organizations/${org}/deployments/${without}/feed?after=0` });
    expect(refused.json().code).toBe("GRANT_NOT_HELD");
    const [pulled] = await rawQuery<{ detail: { sequence: number } }>(
      `SELECT detail FROM organization_log WHERE organization_id = $1 AND kind = 'feed_downloaded'`,
      [org]
    );
    expect(pulled!.detail.sequence).toBe(sequence);
  });

  it("records a usage report an admin uploads against the organization, as if sent", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    const report = { format: 1, kind: "minerval-usage-report", deployment: randomUUID(), period: "2026-11-01", revision: 0, owls_spent: "3.250000" };
    const byStranger = await as(priya, { method: "POST", url: `/organizations/${org}/usage-reports`, payload: { report: JSON.stringify(report) } });
    expect(byStranger.json().code).toBe("ADMIN_REQUIRED");
    const up = await as(dana, { method: "POST", url: `/organizations/${org}/usage-reports`, payload: { report: JSON.stringify(report) } });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json()).toMatchObject({ recorded: true, period: "2026-11-01", revision: 0 });
    const [kept] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM usage_reports_received WHERE account_id = $1`, [org]);
    expect(kept!.n).toBe(1);
  });
});

describe("billing on the organization", () => {
  const report = (deployment: string, period = "2026-11-02", owls = "1.000000") =>
    ({ format: 1, kind: "minerval-usage-report", deployment, period, revision: 0, owls_spent: owls });

  it("records a signed report against the organization and its deployment, and its admins read it back", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    const identifier = randomUUID();
    const { key, id } = await connected(dana, org, ["report_usage"], { report_identifier: identifier });
    const sent = await signed(key, { method: "POST", url: "/usage-reports", body: report(identifier) });
    expect(sent.statusCode, sent.body).toBe(201);

    const read = await as(dana, { url: `/organizations/${org}/usage-reports` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().reports[0]).toMatchObject({
      period: "2026-11-02",
      owls_spent: "1.000000",
      deployment_identifier: identifier,
      deployment: { id, name: "Research" },
      via: "signed",
    });
    const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
    await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` });
    expect((await as(priya, { url: `/organizations/${org}/usage-reports` })).json().code).toBe("ADMIN_REQUIRED");
  });

  it("refuses a report under another deployment's identifier, and ties a first identifier to a deployment that had none", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const mine = randomUUID();
    const { key } = await connected(dana, org, ["report_usage"], { report_identifier: mine });
    const differs = await signed(key, { method: "POST", url: "/usage-reports", body: report(randomUUID()) });
    expect(differs.statusCode).toBe(409);
    expect(differs.json().code).toBe("IDENTIFIER_DIFFERS");

    // Connected before it made a report: the first it sends names it, and the next must match.
    const { key: fresh, id } = await connected(dana, org, ["report_usage"]);
    const first = randomUUID();
    expect((await signed(fresh, { method: "POST", url: "/usage-reports", body: report(first) })).statusCode).toBe(201);
    const [row] = await rawQuery<{ report_identifier: string }>(`SELECT report_identifier FROM deployments WHERE id = $1`, [id]);
    expect(row!.report_identifier).toBe(first);
    expect((await signed(fresh, { method: "POST", url: "/usage-reports", body: report(randomUUID(), "2026-11-03") })).json().code).toBe("IDENTIFIER_DIFFERS");
  });

  it("keeps one organization's identifier its own, connecting and uploading", async () => {
    const dana = await signIn("dana");
    const omar = await signIn("omar");
    const acme = await makeOrganization(dana);
    const other = (await as(omar, { method: "POST", url: "/organizations", payload: { name: "Other Inc" } })).json().organization.id;
    const identifier = randomUUID();
    await connected(dana, acme, ["report_usage"], { report_identifier: identifier });

    const asked = await ask(newKey(), { report_identifier: identifier });
    const refused = await as(omar, { method: "POST", url: `/connect-requests/${asked.json().code}/approve`, payload: { organization_id: other, grants: ["report_usage"] } });
    expect(refused.json().code).toBe("IDENTIFIER_HELD");

    const upload = await as(omar, { method: "POST", url: `/organizations/${other}/usage-reports`, payload: { report: JSON.stringify(report(identifier)) } });
    expect(upload.json().code).toBe("IDENTIFIER_HELD");
    const ok = await as(dana, { method: "POST", url: `/organizations/${acme}/usage-reports`, payload: { report: JSON.stringify(report(identifier, "2026-11-04")) } });
    expect(ok.statusCode, ok.body).toBe(200);
    const [via] = await rawQuery<{ received_via: string; uploaded_by: string }>(
      `SELECT received_via, uploaded_by FROM usage_reports_received WHERE account_id = $1 AND period = '2026-11-04'`,
      [acme]
    );
    expect(via).toEqual({ received_via: "uploaded", uploaded_by: dana.id });
  });
});

describe("naming the person who acted", () => {
  it("names a member on what they put on the record as the organization, only once an admin chose it", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("Priya Raman");
    const org = await makeOrganization(dana);
    const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
    await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` });
    await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "speak", account_id: priya.id } });
    const contribute = async () =>
      as(priya, {
        method: "POST",
        url: "/contributions",
        organization: org,
        payload: { claim_id: await seedClaim("naming"), contribution_type: "challenge", content: "A challenge, made for the organization." },
      });

    const quiet = await contribute();
    expect(quiet.statusCode, quiet.body).toBe(201);
    const read = async (id: string) => (await app.inject({ method: "GET", url: `/contributions/${id}` })).json().contribution;
    expect((await read(quiet.json().contribution.id)).named_person).toBeNull();

    expect((await as(priya, { method: "PUT", url: `/organizations/${org}/naming`, payload: { names_people: true } })).json().code).toBe("ADMIN_REQUIRED");
    expect((await as(dana, { method: "PUT", url: `/organizations/${org}/naming`, payload: { names_people: true } })).json()).toEqual({ names_people: true });
    const named = await contribute();
    const c = await read(named.json().contribution.id);
    expect(c).toMatchObject({ contributor_id: org, named_person: "Priya Raman" });
  });

  it("names the person a deployment sends, in any script", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const { key } = await connected(dana, org, ["speak"]);
    const body = { claim_id: await seedClaim("naming-deployment"), contribution_type: "challenge", content: "A challenge from the deployment." };
    const authorization = signRequest(key.privateKey, key.publicKey, { host: HOST, method: "POST", path: "/contributions", body: JSON.stringify(body) });
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      headers: { host: HOST, authorization, "content-type": "application/json", "x-acting-person-name": encodeURIComponent("Zoë Ångström") },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode, res.body).toBe(201);
    const c = (await app.inject({ method: "GET", url: `/contributions/${res.json().contribution.id}` })).json().contribution;
    expect(c.named_person).toBe("Zoë Ångström");
  });
});

