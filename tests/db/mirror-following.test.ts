/**
 * Following the public graph from the app (docs/organizations.md, "The
 * mirror"; services/mirror-following.ts, the /mirror/setup routes): against
 * the real members-only app and tables, with minerval.ai played by a fake
 * that checks every signature with the public graph's own check and serves a
 * feed signed with a key of its own.
 *
 * Connecting with read_feed reads the feed's key; nothing is followed until
 * an administrator accepts that key and starts following; once following, the
 * applier's own steps fetch and apply a batch signed with the accepted key and
 * refuse one signed with another, naming who fixes it; pausing stops it. Each
 * act is on the activity log, and a batch's notes go to administrators.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateKeyPairSync, randomUUID } from "node:crypto";

const SERVICE_KEY = "mirror-following-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-mirror-following-administrator";
const MEMBER = "oidc:dbtest-mirror-following-member";
const API = "https://api.fake-minerval-feed.test";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "mirror-following-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-mirror-following-administrator";
  process.env.DEPLOYMENT_HOSTING = "own_machines";
  for (const name of [
    "PUBLIC_GRAPH_API_URL",
    "PUBLIC_GRAPH_API_KEY",
    "MIRROR_FEED_URL",
    "MIRROR_FEED_DIR",
    "MIRROR_FEED_PUBLIC_KEYS",
    "MIRROR_FEED_API_KEY",
    "MIRROR_PUBLISH",
  ]) {
    delete process.env[name];
  }
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { migrationHead } from "../../src/db/migration-head.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../src/services/embedding-model.js";
import { syncMirror } from "../../src/services/mirror-apply-service.js";
import { feedGenesisHash, keyIdOf, publicKeyString, signBatch, type MirrorBatch } from "../../src/services/mirror-batch.js";
import { followedSource, trustedKeys } from "../../src/services/mirror-following.js";
import { replicatedShape } from "../../src/services/mirror-manifest.js";
import { forgetConnection, setPublicGraphFetch } from "../../src/services/public-graph-client.js";
import { setConnectionFetch } from "../../src/services/public-graph-connection.js";
import { checkSignature, parseSignatureHeader, sha256Hex, EMPTY_BODY_HASH } from "../../src/services/request-signature.js";

let app: FastifyInstance;

const feedSigning = generateKeyPairSync("ed25519");
const feedKey = publicKeyString(feedSigning.publicKey);
const feedId = randomUUID();

/** A batch of the fake feed: an empty snapshot is enough to be applied, and to be refused. */
function batch(sequence: number, signingKey = feedSigning.privateKey, publicKey = feedKey): MirrorBatch {
  return signBatch(
    {
      format: 1,
      feed_id: feedId,
      sequence,
      kind: "snapshot",
      part: { first: sequence, last: true },
      cut_at: new Date(Date.UTC(2026, 10, 1, 0, sequence)).toISOString(),
      migration: migrationHead(),
      shape: replicatedShape(),
      embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS },
      publisher: { web_base_url: "https://fake-minerval-feed.test" },
      previous_hash: feedGenesisHash(feedId),
      rows: [],
      deletions: [],
      retractions: [],
      key_id: keyIdOf(publicKey),
      public_key: publicKey,
    },
    signingKey
  );
}

const fake = {
  key: null as string | null,
  code: "BCDF-GHJK",
  batches: [] as MirrorBatch[],
  seen: [] as Array<{ path: string; signed: boolean }>,
};

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = typeof init?.body === "string" ? init.body : null;
  const presented = parseSignatureHeader(headers.authorization ?? "");
  fake.seen.push({ path: url.pathname, signed: !!presented });
  if (url.pathname === "/deployments/connect" && method === "POST") {
    const asked = JSON.parse(body ?? "{}") as { public_key: string };
    if (!presented || checkSignature(presented, asked.public_key, { host: url.host, method, path: url.pathname, bodyHash: sha256Hex(body ?? "") })) {
      return answer(401, { error: "bad signature" });
    }
    fake.key = asked.public_key;
    return answer(201, {
      code: fake.code,
      key_id: presented.keyId,
      verification_uri: "https://fake-minerval-feed.test/connect",
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      expires_in: 900,
      interval: 5,
    });
  }
  if (!presented || !fake.key) return answer(401, { error: "unsigned" });
  const fault = checkSignature(presented, fake.key, {
    host: url.host,
    method,
    path: `${url.pathname}${url.search}`,
    bodyHash: body === null ? EMPTY_BODY_HASH : sha256Hex(body),
  });
  if (fault) return answer(401, { error: fault });
  if (url.pathname === `/deployments/connect/${fake.code}`) {
    return answer(200, {
      state: "approved",
      deployment: { id: randomUUID(), name: "Research" },
      organization: { id: randomUUID(), name: "Acme Corp" },
      grants: ["read_feed"],
    });
  }
  if (url.pathname === "/organizations/me") {
    return answer(200, { organization: { name: "Acme Corp" }, deployment: { name: "Research", grants: ["read_feed"] } });
  }
  if (url.pathname === "/mirror/feed/key") {
    return answer(200, { algorithm: "ed25519", public_key: feedKey, key_id: keyIdOf(feedKey), feed_id: feedId, keys: [{ public_key: feedKey, key_id: keyIdOf(feedKey) }] });
  }
  if (url.pathname === "/mirror/feed") {
    const head = fake.batches.at(-1)?.sequence ?? null;
    return answer(200, {
      feed_id: feedId,
      head,
      latest_snapshot: fake.batches.find((b) => b.kind === "snapshot")?.sequence ?? null,
      batches: [],
      has_more: false,
      cuts_in: { shape: replicatedShape(), embedding: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS } },
    });
  }
  const one = /^\/mirror\/feed\/(\d+)$/.exec(url.pathname);
  if (one) {
    const found = fake.batches.find((b) => b.sequence === Number(one[1]));
    return found ? answer(200, JSON.stringify(found)) : answer(404, { error: "no such batch" });
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

function as(externalId: string, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}
const asAdmin = (request: { method?: string; url: string; payload?: unknown }) => as(FIRST_ADMINISTRATOR, request);

/** What the applier does on its turn (workers/mirror-applier.ts). */
async function appliersTurn() {
  const source = await followedSource();
  if (!source) return null;
  return syncMirror(source, { trustedKeys: await trustedKeys() });
}

async function clearMirror() {
  await rawQuery(`DELETE FROM mirror_applied_batches`);
  await rawQuery(`DELETE FROM mirror_refusals`);
  await rawQuery(`DELETE FROM mirror_snapshot_rows`);
  await rawQuery(`DELETE FROM mirror_following`);
  await rawQuery(`DELETE FROM mirror_feed_keys`);
  await rawQuery(`DELETE FROM public_graph_connection`);
  forgetConnection();
}

beforeAll(async () => {
  setConnectionFetch(fakeFetch);
  setPublicGraphFetch(fakeFetch);
  await clearMirror();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  await signIn(FIRST_ADMINISTRATOR, "Dana");
  const member = await signIn(MEMBER, "Robin");
  const granted = await asAdmin({ method: "POST", url: "/permissions/grants", payload: { permission: "read", account_id: member, label: "public" } });
  expect(granted.statusCode, granted.body).toBe(201);
});

afterAll(async () => {
  await clearMirror().catch(() => undefined);
  setConnectionFetch(null);
  setPublicGraphFetch(null);
  await app?.close();
});

describe("following the public graph from the app", () => {
  it("says what must hold first, and refuses to start until it does", async () => {
    const res = await asAdmin({ url: "/mirror/setup" });
    expect(res.statusCode, res.body).toBe(200);
    const m = res.json().mirror;
    expect(m).toMatchObject({ in_app: true, state: "not_started", source: { kind: "network", set_by: "app" } });
    expect(m.checks.map((c: { key: string; status: string }) => [c.key, c.status])).toEqual([
      ["connected", "fail"],
      ["feed_key", "fail"],
    ]);

    const refused = await asAdmin({ method: "POST", url: "/mirror/follow" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("SETUP_INCOMPLETE");
    expect(await followedSource()).toBeNull();
  });

  it("reads the feed's key when the deployment connects with read_feed, and holds it until an administrator accepts it", async () => {
    const start = await asAdmin({ method: "POST", url: "/outside/connection", payload: { name: "Research", grants: ["read_feed"], api_url: API } });
    expect(start.statusCode, start.body).toBe(201);
    const approved = await asAdmin({ method: "POST", url: "/outside/connection/check" });
    expect(approved.json().connection.state).toBe("connected");

    const m = (await asAdmin({ url: "/mirror/setup" })).json().mirror;
    expect(m.keys).toEqual([expect.objectContaining({ key_id: keyIdOf(feedKey), public_key: feedKey, accepted: false, current: true })]);
    const checks = Object.fromEntries(m.checks.map((c: { key: string; status: string }) => [c.key, c.status]));
    expect(checks).toEqual({ connected: "pass", feed_key: "fail", embedding: "pass", shape: "pass" });
    // Nothing is trusted yet.
    expect(await trustedKeys()).toEqual([]);

    const checklist = (await asAdmin({ url: "/setup/checklist" })).json();
    expect(checklist.mirror).toMatchObject({ state: "not_started", key_waiting: true, refusal: null });
  });

  it("is accepted by an administrator only, from a session, and logged", async () => {
    const byMember = await as(MEMBER, { method: "POST", url: `/mirror/feed-keys/${keyIdOf(feedKey)}/accept` });
    expect(byMember.statusCode).toBe(403);
    const unknown = await asAdmin({ method: "POST", url: `/mirror/feed-keys/${"0".repeat(64)}/accept` });
    expect(unknown.statusCode).toBe(404);

    const accepted = await asAdmin({ method: "POST", url: `/mirror/feed-keys/${keyIdOf(feedKey)}/accept` });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().mirror.keys[0]).toMatchObject({ accepted: true, accepted_by: "Dana" });
    expect(await trustedKeys()).toHaveLength(1);
    const [logged] = await rawQuery<{ action: string; detail: { key_id: string } }>(
      `SELECT action, detail FROM administrative_events WHERE action = 'mirror_feed_key_accepted' ORDER BY created_at DESC LIMIT 1`
    );
    expect(logged).toEqual({ action: "mirror_feed_key_accepted", detail: { key_id: keyIdOf(feedKey) } });
  });

  it("follows once started, applying a batch signed with the accepted key", async () => {
    fake.batches = [batch(1)];
    // Not started yet: the applier's turn does nothing.
    expect(await appliersTurn()).toBeNull();

    const started = await asAdmin({ method: "POST", url: "/mirror/follow" });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().mirror).toMatchObject({ state: "following", started_by: "Dana", check_requested: true });

    const turn = await appliersTurn();
    expect(turn?.refusal).toBeNull();
    expect(turn?.applied.map((a) => a.sequence)).toEqual([1]);

    const m = (await asAdmin({ url: "/mirror/setup" })).json().mirror;
    expect(m.status).toMatchObject({ applied: true, sequence: 1, complete: true });
    expect(m.feed).toMatchObject({ head: 1 });
    expect(m.batches).toEqual([expect.objectContaining({ sequence: 1, kind: "snapshot", notes: expect.objectContaining({ kept_claims: 0 }) })]);
    // Fetched over the connection, signed.
    expect(fake.seen.filter((s) => s.path.startsWith("/mirror/feed/")).every((s) => s.signed)).toBe(true);

    // A member reads the page, without the batches' notes.
    const member = await as(MEMBER, { url: "/mirror/setup" });
    expect(member.statusCode, member.body).toBe(200);
    expect(member.json().mirror.batches[0].notes).toBeNull();
    // and may not start, pause or check it.
    expect((await as(MEMBER, { method: "POST", url: "/mirror/check" })).statusCode).toBe(403);
  });

  it("refuses a batch signed with a key nobody accepted, and says an administrator fixes it", async () => {
    const other = generateKeyPairSync("ed25519");
    fake.batches = [batch(1), batch(2, other.privateKey, publicKeyString(other.publicKey))];
    const turn = await appliersTurn();
    expect(turn?.refusal?.code).toBe("unknown_key");

    const m = (await asAdmin({ url: "/mirror/setup" })).json().mirror;
    expect(m.status.last_refusal).toMatchObject({ sequence: 2, code: "unknown_key" });
    expect(m.refusal_owner).toBe("admin");
    const checklist = (await asAdmin({ url: "/setup/checklist" })).json();
    expect(checklist.mirror.refusal).toMatchObject({ code: "unknown_key", owner: "admin" });
  });

  it("pauses, and the applier's turn then fetches nothing", async () => {
    const check = await asAdmin({ method: "POST", url: "/mirror/check" });
    expect(check.statusCode, check.body).toBe(200);
    const paused = await asAdmin({ method: "POST", url: "/mirror/pause" });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().mirror).toMatchObject({ state: "paused", paused_by: "Dana" });
    expect(await appliersTurn()).toBeNull();
    expect((await asAdmin({ method: "POST", url: "/mirror/pause" })).statusCode).toBe(409);

    const actions = await rawQuery<{ action: string }>(
      `SELECT action FROM administrative_events WHERE action LIKE 'mirror_%' ORDER BY created_at`
    );
    expect(actions.map((a) => a.action)).toEqual(["mirror_feed_key_accepted", "mirror_followed", "mirror_check_requested", "mirror_paused"]);
    const log = (await asAdmin({ url: "/permissions/log?type=mirror" })).json();
    expect(log.entries.map((e: { event: string }) => e.event)).toEqual(["mirror_paused", "mirror_check_requested", "mirror_followed", "mirror_feed_key_accepted"]);
  });
});
