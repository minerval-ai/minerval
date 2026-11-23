/**
 * Minerval's releases as a deployment knows them
 * (src/services/product-release-service.ts, src/routes/product-releases.ts;
 * docs/releases.md), against the real app and real tables: the signed list,
 * who may add to it and what is refused, the unsigned read of it, what the
 * deployment says it runs and ran before, what a release asks of it, and
 * that a withdrawn or a security release is said first.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "releases-web-tier-key";
const OPERATOR_KEY = "releases-operator-key-0123456789";
const FIRST_ADMINISTRATOR = "oidc:dbtest-releases-administrator";

// A release key made for this file stands in for Minerval's: the code's own list is empty until Minerval makes its key.
const signing = vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "releases-web-tier-key";
  process.env.MINERVAL_OPERATOR_KEY = "releases-operator-key-0123456789";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-releases-administrator";
  process.env.LOG_LEVEL = "fatal";
  // This deployment runs a release, 0.5.0, and reads the list from elsewhere.
  process.env.MINERVAL_VERSION = "0.5.0";
  process.env.RELEASES_URL = "https://list.example.test";
  process.env.PUBLIC_API_BASE_URL = "https://api.deployment.example.test";
  delete process.env.RELEASES_CHECK;
  delete process.env.TRACE_RETENTION_DAYS;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  const x = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { privateKey: pair.privateKey, publicKey: Buffer.from(x, "base64url").toString("base64") };
});

vi.mock("../../src/release-key.js", () => ({ RELEASE_PUBLIC_KEYS: [signing.publicKey] }));

import { generateKeyPairSync } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { releasePayload, signEntry, type ReleaseEntry, type WithdrawalPayload } from "../../src/release-entries.js";
import type { ReleaseFacts } from "../../src/release-notes.js";
import {
  checkForReleases,
  keptEntries,
  releaseAsks,
  versionPart,
} from "../../src/services/product-release-service.js";
import { recordVersionStarted } from "../../src/services/versions-service.js";
import { evaluatePreflight, gatherPreflightFacts } from "../../src/preflight.js";
import { MCP_EXCLUDED_ROUTES, ROUTE_TOOLS } from "../../src/mcp/route-tools.js";
import type { SetupChecklist } from "../../src/services/setup-checklist-service.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
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

const operator = (entries: unknown[]) =>
  app.inject({ method: "POST", url: "/operator/releases", headers: { "x-operator-key": OPERATOR_KEY }, payload: { entries } });

function facts(version: string, over: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    version,
    date: "2026-12-02",
    security: false,
    upgrades_from: null,
    settings: { added: [], retired: [], defaults_changed: [] },
    operator_steps: [],
    ...over,
  };
}

const release = (version: string, over: Partial<ReleaseFacts> = {}, prose = `Notes of ${version}.`): ReleaseEntry =>
  signEntry(releasePayload(facts(version, over), prose), signing.privateKey, prose);

async function checksOf(name: string) {
  return evaluatePreflight(await gatherPreflightFacts({ callOut: false })).checks.find((c) => c.name === name)!;
}

let admin: Person;
let member: Person;

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`DELETE FROM product_release_entries`);
  await rawQuery(`DELETE FROM release_steps_done`);
  await rawQuery(`DELETE FROM versions_run`);
  await rawQuery(`DELETE FROM platform_flags WHERE key = 'releases_check'`);
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("Releases Administrator", FIRST_ADMINISTRATOR);
  member = await signIn("Releases Member");
});

afterAll(async () => {
  await rawQuery(`DELETE FROM product_release_entries`);
  await rawQuery(`DELETE FROM release_steps_done`);
  await rawQuery(`DELETE FROM versions_run`);
  await app?.close();
});

describe("what a server runs", () => {
  it("is said to anyone, and nothing else is", async () => {
    const res = await app.inject({ url: "/setup/version" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ version: "0.5.0", commit: expect.toSatisfy((c: unknown) => c === null || typeof c === "string") });
    expect((await app.inject({ url: "/health" })).json().version).toBe("0.5.0");
    expect(ROUTE_TOOLS["GET /setup/version"]?.name).toBe("get_version");
  });
});

describe("the list of releases", () => {
  it("takes entries only with the operator key, and only ones the release key signed", async () => {
    const noKey = await app.inject({ method: "POST", url: "/operator/releases", payload: { entries: [release("0.4.0")] } });
    expect(noKey.statusCode).toBe(403);
    expect((await as(admin, { method: "POST", url: "/operator/releases", payload: { entries: [release("0.4.0")] } })).statusCode).toBe(403);

    const other = generateKeyPairSync("ed25519");
    const forged = signEntry(releasePayload(facts("9.9.9"), "Forged."), other.privateKey, "Forged.");
    const changed = { ...release("0.4.0"), payload: { ...release("0.4.0").payload, security: true } };
    const refused = await operator([forged, changed]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ accepted: 0, refused: [{ version: "9.9.9", code: "UNKNOWN_KEY" }, { version: "0.4.0", code: "BAD_SIGNATURE" }] });
    expect(await rawQuery(`SELECT 1 FROM product_release_entries`)).toEqual([]);

    const taken = await operator([
      release("0.4.0", { date: "2026-11-01" }),
      release("0.5.0"),
      release("0.5.1", { date: "2026-12-10", security: true, operator_steps: ["Rotate the sandbox token."] }),
      release("0.6.0", {
        date: "2026-12-20",
        upgrades_from: "0.5.0",
        settings: {
          added: [{ key: "models.redactor", note: "The Redactor's model." }],
          retired: [{ key: "PUBLIC_GRAPH_API_KEY", replaced_by: "the connection to minerval.ai", note: "Delete it from .env." }],
          defaults_changed: [{ key: "run_log.retention_days", from: "30", to: "90", why: "Kept longer." }],
        },
      }),
    ]);
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json()).toMatchObject({ accepted: 4, already: 0, refused: [] });
    // An entry is never changed: the same one again is already there.
    expect((await operator([release("0.5.0")])).json()).toMatchObject({ accepted: 0, already: 1 });
    expect(MCP_EXCLUDED_ROUTES["POST /operator/releases"]).toMatch(/operator/);
  });

  it("is read newest first with its facts and without its prose, with the entries that say so", async () => {
    const res = await as(admin, { url: "/setup/releases" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { releases: Array<{ version: string }>; entries: ReleaseEntry[] };
    expect(body.releases.map((r) => r.version)).toEqual(["0.6.0", "0.5.1", "0.5.0", "0.4.0"]);
    expect(body.entries).toHaveLength(4);
    expect(body.entries.every((e) => e.prose === undefined)).toBe(true);
    expect(res.body).not.toContain("Notes of");

    const one = await as(admin, { url: "/setup/releases/0.5.1" });
    expect(one.json()).toMatchObject({ release: { version: "0.5.1", security: true }, prose: "Notes of 0.5.1." });
    expect((await as(admin, { url: "/setup/releases/7.7.7" })).statusCode).toBe(404);
    expect((await as(admin, { url: "/setup/releases/latest" })).json().release.version).toBe("0.6.0");
    expect(ROUTE_TOOLS["GET /setup/releases"]?.name).toBe("list_product_releases");
    expect(ROUTE_TOOLS["GET /setup/releases/:version"]?.name).toBe("get_product_release");
  });

  it("corrects and withdraws by new entries, never by edits", async () => {
    const corrected = signEntry(
      releasePayload(facts("0.4.0", { date: "2026-11-01", operator_steps: ["Restart the web app after the API."] }), "Notes of 0.4.0, corrected.", 2, {
        what: "Added the restart order.",
        why: "It was left out.",
      }),
      signing.privateKey,
      "Notes of 0.4.0, corrected."
    );
    const withdrawal: WithdrawalPayload = { kind: "withdrawal", version: "0.6.0", date: "2026-12-21", reason: "It loses work at a restart.", move_to: "0.6.1" };
    expect((await operator([corrected, signEntry(withdrawal, signing.privateKey)])).json()).toMatchObject({ accepted: 2 });

    const list = (await as(admin, { url: "/setup/releases" })).json().releases as Array<Record<string, unknown>>;
    expect(list.find((r) => r.version === "0.4.0")).toMatchObject({
      revision: 2,
      operator_steps: ["Restart the web app after the API."],
      corrections: [{ revision: 2, what: "Added the restart order.", why: "It was left out." }],
    });
    expect(list.find((r) => r.version === "0.6.0")).toMatchObject({ withdrawn: { reason: "It loses work at a restart.", move_to: "0.6.1" } });
    // The first revision is kept beside the second.
    expect(await rawQuery(`SELECT revision FROM product_release_entries WHERE version = '0.4.0' AND kind = 'release' ORDER BY revision`)).toEqual([
      { revision: 1 },
      { revision: 2 },
    ]);
    // The newest that is not withdrawn.
    expect((await as(admin, { url: "/setup/releases/latest" })).json().release.version).toBe("0.5.1");
    expect((await as(admin, { url: "/setup/releases/0.4.0" })).json().prose).toBe("Notes of 0.4.0, corrected.");
  });
});

describe("reading the list from the public graph", () => {
  it("asks as any reader would, saying nothing of itself, and keeps only what Minerval signed", async () => {
    await rawQuery(`DELETE FROM product_release_entries WHERE version = '0.6.1'`);
    const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
    const other = generateKeyPairSync("ed25519");
    const fetchList = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          entries: [release("0.6.1", { date: "2026-12-22" }), signEntry(releasePayload(facts("9.9.9"), "Forged."), other.privateKey)],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const check = await checkForReleases({ fetchList });
    expect(check).toMatchObject({ ok: true, error: null });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://list.example.test/setup/releases");
    // No key, no version, no name: one header, saying what it will read.
    expect(asked[0]!.init?.headers).toEqual({ accept: "application/json" });
    expect(asked[0]!.init?.method).toBeUndefined();
    expect(asked[0]!.init?.body).toBeUndefined();

    const kept = (await keptEntries()).map((e) => e.payload.version);
    expect(kept).toContain("0.6.1");
    expect(kept).not.toContain("9.9.9");

    // A copy read lately is left as it is.
    await checkForReleases({ fetchList, maxAgeMs: 60_000 });
    expect(asked).toHaveLength(1);
  });

  it("keeps why a read failed, for Health to say", async () => {
    const fetchList = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    expect(await checkForReleases({ fetchList })).toMatchObject({ ok: false, error: "the list answered 503" });
    const check = await checksOf("releases");
    expect(check.status).toBe("fail");
    expect(check.message).toMatch(/security releases? (is|are) out|could not be read/i);
  });

  it("takes an uploaded file of the list the same way, from an administrator", async () => {
    const file = { entries: [release("0.7.0", { date: "2027-01-05" })] };
    expect((await as(member, { method: "POST", url: "/setup/releases/upload", payload: file })).statusCode).toBe(403);
    const res = await as(admin, { method: "POST", url: "/setup/releases/upload", payload: file });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, refused: [] });
    const forged = { entries: [{ ...release("0.8.0"), signature: release("0.7.0").signature }] };
    expect((await as(admin, { method: "POST", url: "/setup/releases/upload", payload: forged })).json()).toMatchObject({
      accepted: 0,
      refused: [{ version: "0.8.0", code: "BAD_SIGNATURE" }],
    });
  });
});

describe("what Health shows", () => {
  it("says what the deployment runs, what it ran before, and what is newer with what each asks", async () => {
    await rawQuery(
      `INSERT INTO versions_run (version, first_started_at, last_started_at) VALUES ('0.4.0', now() - interval '40 days', now() - interval '3 days')`
    );
    await recordVersionStarted({ version: "0.5.0", commit: null });
    // The deployment still sets a setting 0.6.0 retires, and pins a default 0.6.0 changes.
    process.env.PUBLIC_GRAPH_API_KEY = "old-key";
    process.env.TRACE_RETENTION_DAYS = "30";

    const part = await versionPart("0.5.0");
    expect(part.running).toMatchObject({ version: "0.5.0" });
    expect(part.dev).toBe(false);
    expect(part.before).toMatchObject({ version: "0.4.0" });
    expect(part.parts).toMatchObject({ api: "0.5.0", sandbox: "0.5.0" });
    expect(part.list).toMatchObject({ check: "daily", reads: true, keys: 1 });
    expect(part.withdrawn).toBeNull();

    expect(part.newer.map((r) => r.version)).toEqual(["0.7.0", "0.6.1", "0.6.0", "0.5.1"]);
    expect(part.latest).toBe("0.7.0");
    expect(part.upgrade_commands).toEqual(["git fetch --tags", "git checkout v0.7.0", "docker compose build", "docker compose up -d"]);
    const six = part.newer.find((r) => r.version === "0.6.0")!;
    expect(six.withdrawn).toBe(true);
    expect(six.retired_still_set).toEqual([
      { key: "retired.public_graph_api_key", env: "PUBLIC_GRAPH_API_KEY", where: "environment", replaced_by: "the connection to minerval.ai", note: "Delete it from .env." },
    ]);
    expect(six.defaults_pinned).toEqual([
      { key: "run_log.retention_days", env: "TRACE_RETENTION_DAYS", from: "30", to: "90", why: "Kept longer.", where: "environment" },
    ]);
    expect(six.added).toEqual([{ key: "models.redactor", note: "The Redactor's model.", set: false }]);
    expect(part.newer.find((r) => r.version === "0.5.1")).toMatchObject({
      security: true,
      operator_steps: [{ step: "Rotate the sandbox token.", done: false }],
    });

    delete process.env.PUBLIC_GRAPH_API_KEY;
    delete process.env.TRACE_RETENTION_DAYS;
    // Once the deployment no longer sets them, they are no longer asked of it.
    expect(releaseAsks(facts("0.6.0", six as unknown as Partial<ReleaseFacts>)).retired_still_set).toEqual([]);
  });

  it("carries the same in the setup checklist, without reading the list again when it was read lately", async () => {
    await rawQuery(
      `INSERT INTO platform_flags (key, value) VALUES ('releases_check', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ at: new Date().toISOString(), ok: true, error: null })]
    );
    const res = await as(admin, { url: "/setup/checklist" });
    expect(res.statusCode, res.body).toBe(200);
    const checklist = res.json() as SetupChecklist;
    expect(checklist.version.running.version).toBe("0.5.0");
    expect(checklist.version.latest).toBe("0.7.0");
    expect(checklist.preflight!.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["version", "releases", "settings", "unknown_settings"]));
  });

  it("fails the releases check while a security release is out that it does not run", async () => {
    const check = await checksOf("releases");
    expect(check.status).toBe("fail");
    expect(check.blocking).toBe(false);
    expect(check.message).toMatch(/A security release is out that this deployment does not run: 0\.5\.1/);
  });

  it("marks an operator step done for an administrator, logged, and only a step the release has", async () => {
    const step = { version: "0.5.1", step: "Rotate the sandbox token." };
    expect((await as(member, { method: "POST", url: "/setup/releases/steps", payload: step })).statusCode).toBe(403);
    expect((await as(admin, { method: "POST", url: "/setup/releases/steps", payload: { version: "0.5.1", step: "Something else." } })).statusCode).toBe(404);
    const res = await as(admin, { method: "POST", url: "/setup/releases/steps", payload: step });
    expect(res.statusCode, res.body).toBe(200);
    const part = await versionPart();
    expect(part.newer.find((r) => r.version === "0.5.1")!.operator_steps).toEqual([
      { step: "Rotate the sandbox token.", done: true, done_at: expect.any(String), done_by: "Releases Administrator" },
    ]);
    const [entry] = await rawQuery<{ actor_id: string; detail: Record<string, string> }>(
      `SELECT actor_id, detail FROM administrative_events WHERE action = 'release_step_done'`
    );
    expect(entry).toMatchObject({ actor_id: admin.id, detail: step });
    expect(MCP_EXCLUDED_ROUTES["POST /setup/releases/steps"]).toMatch(/agent cannot know/);
  });

  it("says first that the release it runs was withdrawn", async () => {
    const withdrawal: WithdrawalPayload = { kind: "withdrawal", version: "0.5.0", date: "2026-12-23", reason: "It exposes a label's titles.", move_to: "0.5.1" };
    expect((await operator([signEntry(withdrawal, signing.privateKey)])).statusCode).toBe(200);
    expect((await versionPart()).withdrawn).toEqual({ date: "2026-12-23", reason: "It exposes a label's titles.", move_to: "0.5.1" });
    const check = await checksOf("releases");
    expect(check.status).toBe("fail");
    expect(check.message).toMatch(/^Release 0\.5\.0, which this deployment runs, was withdrawn: It exposes a label's titles\. Move to 0\.5\.1/);
  });

  it("names a release to go through first when the latest cannot be reached from this one", async () => {
    await operator([release("0.8.0", { date: "2027-02-01", upgrades_from: "0.7.0" })]);
    const part = await versionPart();
    expect(part.latest).toBe("0.8.0");
    expect(part.through).toBe("0.7.0");
    expect(part.upgrade_commands![1]).toBe("git checkout v0.7.0");
  });
});

describe("the parts' versions", () => {
  it("passes while every part heard from runs one version, and fails naming each when one does not", async () => {
    const { noteWebVersion } = await import("../../src/version.js");
    noteWebVersion("0.5.0");
    expect((await checksOf("version")).status).toBe("pass");
    noteWebVersion("0.4.0");
    const check = await checksOf("version");
    expect(check.status).toBe("fail");
    expect(check.blocking).toBe(false);
    expect(check.message).toMatch(/the API runs 0\.5\.0, the web app runs 0\.4\.0/);
    noteWebVersion("0.5.0");
  });
});
