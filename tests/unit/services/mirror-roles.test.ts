/**
 * Which side of the mirror a deployment is on (src/services/mirror-roles.ts),
 * and above all that it is on neither unless configured: with nothing set,
 * nothing about the mirror runs. That is what keeps this code inert on a
 * deployment, minerval.ai included, until someone turns a side on.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateSigningKey } from "../../../src/services/mirror-batch.js";
import { mirrorConfigProblems, mirrorRoles } from "../../../src/services/mirror-roles.js";
import { describeCut } from "../../../src/workers/mirror-publisher.js";
import { describeSync } from "../../../src/workers/mirror-applier.js";
import { MirrorRefusal } from "../../../src/services/mirror-batch.js";

const MIRROR_ENV = [
  "MIRROR_PUBLISH",
  "MIRROR_SIGNING_KEY",
  "MIRROR_PUBLISH_INTERVAL_SECONDS",
  "MIRROR_BATCH_MAX_BYTES",
  "MIRROR_FEED_URL",
  "MIRROR_FEED_DIR",
  "MIRROR_FEED_API_KEY",
  "MIRROR_FEED_PUBLIC_KEYS",
  "MIRROR_APPLY_INTERVAL_SECONDS",
];

afterEach(() => {
  for (const name of MIRROR_ENV) delete process.env[name];
  vi.resetModules();
});

async function configWith(env: Record<string, string>) {
  for (const name of MIRROR_ENV) delete process.env[name];
  Object.assign(process.env, env);
  vi.resetModules();
  const { loadConfig } = await import("../../../src/config.js");
  return loadConfig();
}

describe("a deployment with nothing set for the mirror", () => {
  it("is neither a publisher nor an applier, and has nothing to complain about", async () => {
    const config = await configWith({});
    expect(config).toMatchObject({
      mirrorPublish: false,
      mirrorSigningKey: "",
      mirrorFeedUrl: "",
      mirrorFeedDir: "",
      mirrorFeedApiKey: "",
      mirrorFeedPublicKeys: [],
    });
    expect(mirrorRoles(config)).toEqual({ publisher: false, applier: false });
    expect(mirrorConfigProblems(config)).toEqual([]);
  });

  it("mounts no mirror route", async () => {
    await configWith({});
    process.env.LOG_LEVEL = "fatal";
    const { buildApp } = await import("../../../src/server/app.js");
    const app = await buildApp();
    await app.ready();
    try {
      expect(app.routeCatalog.filter((r) => r.url.startsWith("/mirror"))).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/mirror/status" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/mirror/feed" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("is not made a publisher by a signing key alone, or by anything but the word true", async () => {
    const key = generateSigningKey();
    expect(mirrorRoles(await configWith({ MIRROR_SIGNING_KEY: key.privateKeyPem }))).toEqual({ publisher: false, applier: false });
    expect(mirrorRoles(await configWith({ MIRROR_PUBLISH: "1" })).publisher).toBe(false);
    expect(mirrorRoles(await configWith({ MIRROR_PUBLISH: "false" })).publisher).toBe(false);
  });
});

describe("a deployment configured for the mirror", () => {
  it("is a publisher, an applier, or both, and mounts only its own side", async () => {
    const key = generateSigningKey();
    const publisher = await configWith({ MIRROR_PUBLISH: "true", MIRROR_SIGNING_KEY: key.privateKeyPem });
    expect(mirrorRoles(publisher)).toEqual({ publisher: true, applier: false });
    expect(mirrorConfigProblems(publisher)).toEqual([]);
    process.env.LOG_LEVEL = "fatal";
    let { buildApp } = await import("../../../src/server/app.js");
    let app = await buildApp();
    await app.ready();
    expect(app.routeCatalog.filter((r) => r.url.startsWith("/mirror")).map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      "GET /mirror/feed",
      "GET /mirror/feed/:sequence",
      "GET /mirror/feed/key",
    ]);
    await app.close();

    const applier = await configWith({ MIRROR_FEED_URL: "https://api.public.example", MIRROR_FEED_PUBLIC_KEYS: key.publicKey });
    expect(mirrorRoles(applier)).toEqual({ publisher: false, applier: true });
    expect(mirrorConfigProblems(applier)).toEqual([]);
    ({ buildApp } = await import("../../../src/server/app.js"));
    app = await buildApp();
    await app.ready();
    expect(app.routeCatalog.filter((r) => r.url.startsWith("/mirror")).map((r) => `${r.method} ${r.url}`)).toEqual(["GET /mirror/status"]);
    await app.close();

    const both = await configWith({
      MIRROR_PUBLISH: "true",
      MIRROR_SIGNING_KEY: key.privateKeyPem,
      MIRROR_FEED_DIR: "/var/lib/mirror",
      MIRROR_FEED_PUBLIC_KEYS: `${key.publicKey}, ${generateSigningKey().publicKey}`,
    });
    expect(mirrorRoles(both)).toEqual({ publisher: true, applier: true });
    expect(both.mirrorFeedPublicKeys).toHaveLength(2);
    expect(mirrorConfigProblems(both)).toEqual([]);
  });

  it("says plainly what is missing", async () => {
    expect(mirrorConfigProblems(await configWith({ MIRROR_PUBLISH: "true" }))).toEqual([
      "MIRROR_PUBLISH is true and MIRROR_SIGNING_KEY is empty: a feed cannot be published unsigned. " +
        "Set MIRROR_SIGNING_KEY to an Ed25519 private key in PEM form (`npx tsx scripts/mirror.ts keygen` makes one).",
    ]);
    expect(mirrorConfigProblems(await configWith({ MIRROR_PUBLISH: "true", MIRROR_SIGNING_KEY: "garbage" }))).toEqual([
      "MIRROR_PUBLISH is true and MIRROR_SIGNING_KEY is not a private key in PEM form.",
    ]);
    expect(mirrorConfigProblems(await configWith({ MIRROR_FEED_URL: "https://api.public.example" }))).toEqual([
      "A mirror feed is configured and MIRROR_FEED_PUBLIC_KEYS is empty: no batch could be checked, so none " +
        "would be applied. Set it to the feed's public key, as GET /mirror/feed/key on the publisher gives it, " +
        "confirmed with the publisher by another route.",
    ]);
    const key = generateSigningKey();
    expect(
      mirrorConfigProblems(
        await configWith({ MIRROR_FEED_URL: "https://x.example", MIRROR_FEED_DIR: "/d", MIRROR_FEED_PUBLIC_KEYS: `${key.publicKey},nonsense` })
      )
    ).toEqual([
      "MIRROR_FEED_URL and MIRROR_FEED_DIR are both set: a mirror follows one source. Unset one of them.",
      "MIRROR_FEED_PUBLIC_KEYS: a mirror feed public key must be an Ed25519 key, written as the base64 of its 32 bytes " +
        "(as GET /mirror/feed/key gives it) or as a PEM.",
    ]);
  });
});

describe("what the workers log", () => {
  it("describes a cut, and says nothing when there was none", () => {
    expect(describeCut({ batches: [] })).toBeNull();
    expect(describeCut({ batches: [{ sequence: 7, kind: "changes", rows: 12, removals: 3, bytes: 4096, hash: "h" }] })).toBe(
      "Mirror feed: cut batch 7 (changes; 12 rows, 3 removals, 4096 bytes)"
    );
    expect(
      describeCut({
        batches: [
          { sequence: 1, kind: "snapshot", rows: 100, removals: 0, bytes: 5000, hash: "a" },
          { sequence: 2, kind: "snapshot", rows: 50, removals: 0, bytes: 2500, hash: "b" },
        ],
      })
    ).toBe("Mirror feed: cut batches 1 to 2 (snapshot; 150 rows, 0 removals, 7500 bytes)");
  });

  it("describes a sync by where the mirror now stands, and a refusal by its reason", () => {
    expect(describeSync({ applied: [], refusal: null })).toEqual({ info: null, error: null });
    const applied = (sequence: number, status: "applied" | "already_applied" = "applied") => ({
      status,
      sequence,
      kind: "changes" as const,
      hash: "h",
      cut_at: `2026-11-12T00:0${sequence}:00.000Z`,
      counts: {},
      changed: {},
      notes: {},
    });
    expect(describeSync({ applied: [applied(4), applied(5)], refusal: null }).info).toBe(
      "Mirror: applied 2 batches, now at batch 5: the public graph as of 2026-11-12T00:05:00.000Z"
    );
    expect(describeSync({ applied: [applied(4, "already_applied")], refusal: null }).info).toBeNull();
    const refusal = new MirrorRefusal("bad_signature", "Batch 6 was not applied: its signature does not verify.");
    expect(describeSync({ applied: [applied(5)], refusal })).toEqual({
      info: "Mirror: applied 1 batch, now at batch 5: the public graph as of 2026-11-12T00:05:00.000Z",
      error: "Mirror: Batch 6 was not applied: its signature does not verify.",
    });
  });
});
