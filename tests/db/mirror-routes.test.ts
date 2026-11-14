/**
 * The mirror feed over HTTP (src/routes/mirror.ts): a publisher's routes as
 * a caller sees them, and a private deployment fed from them.
 *
 * This file's app database is the publisher's, and the private side is
 * another, reached through its own pool, which fetches through the
 * publisher's real routes. They are this file's own pair ("f" and "g" of
 * the copies the global setup makes, tests/db/urls.ts). This file used to
 * share "a" and "b" with mirror-round-trip.test.ts and was written to work
 * after it. The round trip was not written to work after this file: it
 * expects a publisher that has cut nothing and a mirror that has applied
 * nothing, and the suite's files are not run in a fixed order (a file that
 * failed last time, or took longer, runs first). When this file ran first
 * the round trip failed 21 tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const base = process.env.TEST_DATABASE_URL ?? "postgresql://episteme:episteme@localhost:5432/episteme_dbtest";
  const url = new URL(base);
  url.pathname = `${url.pathname}_mirror_f`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64");
  process.env.DATABASE_URL = url.toString();
  process.env.MIRROR_PUBLISH = "true";
  process.env.MIRROR_SIGNING_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  // An applier too, so that the status route is mounted here.
  process.env.MIRROR_FEED_DIR = "/var/empty/mirror-batches";
  process.env.MIRROR_FEED_PUBLIC_KEYS = publicKeyRaw;
  process.env.API_KEYS = "mirror-routes-test-key";
  process.env.LOG_LEVEL = "fatal";
  return { publicKeyRaw };
});

import { rawQuery } from "../../src/db/client.js";
import { keyIdOf, parsePublicKey, readBatch, verifyBatch } from "../../src/services/mirror-batch.js";
import { mirrorStatus, syncMirror, urlSource } from "../../src/services/mirror-apply-service.js";
import { poolDb, type MirrorDb } from "../../src/services/mirror-db.js";
import { cutBatches, getBatchText } from "../../src/services/mirror-feed-service.js";
import { mirrorConfigProblems, mirrorRoles } from "../../src/services/mirror-roles.js";
import { mirrorDatabaseUrl } from "./urls.js";

const KEY = { "x-api-key": "mirror-routes-test-key" };

let app: FastifyInstance;
let privPool: pg.Pool;
let priv: MirrorDb;
let claimId: string;
let head: number;

/** `fetch`, answered by this app's own routes. */
const viaApp: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const res = await app.inject({
    method: "GET",
    url: url.pathname + url.search,
    headers: (init?.headers ?? {}) as Record<string, string>,
  });
  return new Response(res.body, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "") } });
};

beforeAll(async () => {
  privPool = new pg.Pool({ connectionString: mirrorDatabaseUrl("g"), max: 4 });
  priv = poolDb(privPool);
  claimId = randomUUID();
  await rawQuery(`INSERT INTO claims (id, text, steward_state) VALUES ($1, $2, 'done')`, [
    claimId,
    `A claim published over HTTP (${claimId.slice(0, 8)})`,
  ]);
  // The cut the worker would make, by this deployment's own configuration.
  const cut = await cutBatches();
  head = cut.batches.at(-1)!.sequence;
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await privPool?.end();
});

describe("a publisher's routes", () => {
  it("is configured as both sides, with nothing wrong", () => {
    expect(mirrorRoles()).toEqual({ publisher: true, applier: true });
    expect(mirrorConfigProblems()).toEqual([]);
  });

  it("serves its public key to anyone", async () => {
    const res = await app.inject({ method: "GET", url: "/mirror/feed/key" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { algorithm: string; public_key: string; key_id: string; feed_id: string };
    expect(body).toMatchObject({ algorithm: "ed25519", public_key: env.publicKeyRaw, key_id: keyIdOf(env.publicKeyRaw) });
    expect(body.feed_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists its batches without their rows, and says where a new mirror starts", async () => {
    const res = await app.inject({ method: "GET", url: `/mirror/feed?after=${head - 1}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { head: number; latest_snapshot: number; batches: Array<Record<string, unknown>>; has_more: boolean };
    expect(body.head).toBe(head);
    expect(body.latest_snapshot).toBeGreaterThanOrEqual(1);
    expect(body.has_more).toBe(false);
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]).toMatchObject({ sequence: head, key_id: keyIdOf(env.publicKeyRaw), part: { last: true } });
    expect(Object.keys(body.batches[0]!).sort()).toEqual(
      ["bytes", "cut_at", "hash", "key_id", "kind", "migration", "part", "previous_hash", "removals", "rows", "sequence", "shape"].sort()
    );
    // `fields` trims it like any GET.
    const trimmed = await app.inject({ method: "GET", url: `/mirror/feed?fields=head` });
    expect(trimmed.json()).toEqual({ head });
  });

  it("serves a batch only to a caller with a key, as the very text that was signed", async () => {
    const anonymous = await app.inject({ method: "GET", url: `/mirror/feed/${head}` });
    expect(anonymous.statusCode).toBe(401);

    const res = await app.inject({ method: "GET", url: `/mirror/feed/${head}`, headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toBe(await getBatchText(head));
    const batch = readBatch(res.body);
    expect(() => verifyBatch(batch, [parsePublicKey(env.publicKeyRaw)])).not.toThrow();
    expect(batch.rows.find((r) => r.table === "claims")!.rows.map((r) => r.id)).toContain(claimId);
    // Never cached where another caller could be handed it.
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 404 for a batch it does not have, and 400 for what is not a sequence", async () => {
    const missing = await app.inject({ method: "GET", url: `/mirror/feed/${head + 1000}`, headers: KEY });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({
      code: "NO_SUCH_BATCH",
      message: `The feed has no batch ${head + 1000}. GET /mirror/feed lists the batches it has.`,
    });
    expect((await app.inject({ method: "GET", url: `/mirror/feed/latest`, headers: KEY })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/mirror/feed/0`, headers: KEY })).statusCode).toBe(400);
  });
});

describe("a private deployment fed from those routes", () => {
  it("needs the key the publisher asks for, and says so when it lacks it", async () => {
    const [before] = await priv.query<{ n: number }>(`SELECT count(*)::int AS n FROM mirror_applied_batches`);
    await expect(
      syncMirror(urlSource("https://api.public.example", "", viaApp), { db: priv, trustedKeys: [parsePublicKey(env.publicKeyRaw)] })
    ).rejects.toThrow(/answered 401 to GET \/mirror\/feed\/\d+ \(check MIRROR_FEED_API_KEY\)\./);
    const [after] = await priv.query<{ n: number }>(`SELECT count(*)::int AS n FROM mirror_applied_batches`);
    expect(after!.n).toBe(before!.n);
  });

  it("comes up to the feed and then shows the public graph as of its last batch", async () => {
    const source = urlSource("https://api.public.example/", "mirror-routes-test-key", viaApp);
    const result = await syncMirror(source, { db: priv, trustedKeys: [parsePublicKey(env.publicKeyRaw)] });
    expect(result.refusal).toBeNull();
    expect(result.applied.at(-1)!.sequence).toBe(head);
    const [mirrored] = await priv.query<{ text: string; origin: string; steward_state: string }>(
      `SELECT text, origin, steward_state FROM claims WHERE id = $1`,
      [claimId]
    );
    expect(mirrored).toEqual({
      text: `A claim published over HTTP (${claimId.slice(0, 8)})`,
      origin: "mirror",
      steward_state: "deferred",
    });
    const status = await mirrorStatus(priv);
    expect(status).toMatchObject({ applied: true, complete: true, sequence: head, last_refusal: null });
    expect(status.public_graph_as_of).toBe(readBatch((await getBatchText(head))!).cut_at);
    // Nothing new: a second sync applies nothing.
    expect((await syncMirror(source, { db: priv, trustedKeys: [parsePublicKey(env.publicKeyRaw)] })).applied).toEqual([]);
  });

  it("reports how current a mirror is at /mirror/status", async () => {
    // This app's own database has applied nothing: it is the publisher.
    const res = await app.inject({ method: "GET", url: "/mirror/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      applied: false,
      public_graph_as_of: null,
      complete: false,
      sequence: null,
      batch_hash: null,
      applied_at: null,
      feed_id: null,
      key_id: null,
      public_web_base_url: null,
      searchable_claims: 0,
      last_refusal: null,
    });
  });
});
