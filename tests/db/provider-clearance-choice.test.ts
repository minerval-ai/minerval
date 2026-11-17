/**
 * Clearing providers for a label from the labels page (#1094;
 * services/provider-clearance-service.ts), against the real app and the
 * real tables: the list of what each provider would be sent, the
 * permission it takes, the log entry it leaves, defining a label with
 * providers ticked, the settings fixing the clearance, and a change being
 * in force at the seam that sends text without a restart.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "clearance-web-tier-key";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "clearance-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-clearance-first-administrator";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { assertProviderCleared, resetProviderClearanceForTests } from "../../src/llm/provider-clearance.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { forgetStoredClearance, noteStoredClearance, ProviderNotClearedError } from "../../src/provider-labels.js";
import { STORED_CLEARANCE_RECHECK_MS } from "../../src/services/provider-clearance-service.js";

const FIRST_ADMINISTRATOR = "oidc:dbtest-clearance-first-administrator";

// The deployment's PROVIDER_LABELS as config loading parsed it: one object
// per process, so setting it there is what every reader sees.
const deployment = loadConfig() as unknown as { providerLabels: Record<string, string[]> | undefined };
const loaded = deployment.providerLabels;

let app: FastifyInstance;
interface Person {
  id: string;
  externalId: string;
}
let admin: Person;
const LABEL = `cl${randomUUID().slice(0, 8)}`;
const OTHER = `cl${randomUUID().slice(0, 8)}`;
const definedLabels = [LABEL, OTHER];

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

const atLabel = (label: string, fn: () => Promise<void>) => runWithUsageContext({ label }, fn);

beforeAll(async () => {
  deployment.providerLabels = undefined;
  await rawQuery(`DELETE FROM provider_clearances`);
  await rawQuery(`DELETE FROM permission_grants`);
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("clearance-admin", FIRST_ADMINISTRATOR);
  const res = await as(admin, { method: "POST", url: "/labels", payload: { name: LABEL, description: "For a test." } });
  expect(res.statusCode, res.body).toBe(201);
});

afterEach(() => {
  deployment.providerLabels = undefined;
  resetProviderClearanceForTests();
});

afterAll(async () => {
  deployment.providerLabels = loaded;
  forgetStoredClearance();
  await app?.close();
  await rawQuery(`DELETE FROM provider_clearances`);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [definedLabels]);
});

describe("the first administrator", () => {
  it("holds the permission to clear providers, as every permission with no scope", async () => {
    const mine = await as(admin, { url: "/permissions/mine" });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(JSON.stringify(mine.json())).toContain("clear_providers");
  });
});

describe("GET /labels/providers", () => {
  it("lists every provider with what it is sent, and a new label with nothing cleared", async () => {
    const res = await as(admin, { url: "/labels/providers" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.fixed_by_settings).toBe(false);
    const names = body.providers.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["anthropic", "openai", "openrouter", "embeddings", "web_search", "web_pages"]));
    for (const p of body.providers) expect(p.description.length, p.name).toBeGreaterThan(30);
    expect(body.labels.find((l: { label: string }) => l.label === LABEL)).toEqual({ label: LABEL, cleared: [] });
    expect(body.labels.map((l: { label: string }) => l.label)).not.toContain("public");
  });

  it("is refused to a member who neither administers nor clears providers", async () => {
    const member = await signIn("clearance-reader");
    await as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "fund", account_id: member.id } });
    expect((await as(member, { url: "/labels/providers" })).statusCode).toBe(403);
  });
});

describe("PUT /labels/:label/providers", () => {
  it("clears exactly the providers named, logs the change, and is in force at once", async () => {
    await expect(atLabel(LABEL, () => assertProviderCleared("anthropic"))).rejects.toBeInstanceOf(ProviderNotClearedError);

    const res = await as(admin, {
      method: "PUT",
      url: `/labels/${LABEL}/providers`,
      payload: { providers: ["anthropic", "embeddings"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ cleared: ["anthropic", "embeddings"], no_longer_cleared: [] });
    expect(res.json().labels.find((l: { label: string }) => l.label === LABEL).cleared).toEqual(["anthropic", "embeddings"]);

    await atLabel(LABEL, () => assertProviderCleared("anthropic"));
    await atLabel(LABEL, () => assertProviderCleared("embeddings"));
    await expect(atLabel(LABEL, () => assertProviderCleared("openrouter"))).rejects.toBeInstanceOf(ProviderNotClearedError);

    const [logged] = await rawQuery<{ actor_id: string; detail: Record<string, string> }>(
      `SELECT actor_id, detail FROM administrative_events WHERE action = 'provider_clearance_set' AND detail->>'label' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [LABEL]
    );
    expect(logged).toEqual({ actor_id: admin.id, detail: { label: LABEL, cleared: "anthropic\nembeddings", no_longer_cleared: "" } });

    const narrowed = await as(admin, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["anthropic"] } });
    expect(narrowed.json()).toMatchObject({ cleared: [], no_longer_cleared: ["embeddings"] });
    await expect(atLabel(LABEL, () => assertProviderCleared("embeddings"))).rejects.toBeInstanceOf(ProviderNotClearedError);

    const log = await as(admin, { url: "/permissions/log" });
    const entry = log.json().entries.find((e: { event: string }) => e.event === "provider_clearance_set");
    expect(entry).toMatchObject({ label: LABEL, cleared: [], no_longer_cleared: ["embeddings"] });

    // The same choice again changes nothing and logs nothing.
    const before = await rawQuery(`SELECT 1 FROM administrative_events WHERE action = 'provider_clearance_set'`);
    await as(admin, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["anthropic"] } });
    expect(await rawQuery(`SELECT 1 FROM administrative_events WHERE action = 'provider_clearance_set'`)).toHaveLength(before.length);
  });

  it("is in force in a process that did not make it once its copy is older than the recheck interval", async () => {
    await as(admin, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: [] } });
    // Another process clears a provider: a row this process has not read.
    await rawQuery(`INSERT INTO provider_clearances (provider, label) VALUES ('openai', $1)`, [LABEL]);
    // A copy read just now is relied on until it is old...
    noteStoredClearance({}, Date.now());
    await expect(atLabel(LABEL, () => assertProviderCleared("openai"))).rejects.toBeInstanceOf(ProviderNotClearedError);
    // ...and read again once it is.
    noteStoredClearance({}, Date.now() - STORED_CLEARANCE_RECHECK_MS - 1);
    await atLabel(LABEL, () => assertProviderCleared("openai"));
    // Taken back elsewhere, refused here as soon as the copy is old again.
    await rawQuery(`DELETE FROM provider_clearances WHERE label = $1`, [LABEL]);
    noteStoredClearance({ openai: [LABEL] }, Date.now() - STORED_CLEARANCE_RECHECK_MS - 1);
    await expect(atLabel(LABEL, () => assertProviderCleared("openai"))).rejects.toBeInstanceOf(ProviderNotClearedError);
  });

  it("refuses public, a name that is no provider, and a label nobody defined", async () => {
    const pub = await as(admin, { method: "PUT", url: "/labels/public/providers", payload: { providers: ["anthropic"] } });
    expect(pub.statusCode).toBe(400);
    expect(pub.json().code).toBe("PUBLIC_LABEL");
    const unknown = await as(admin, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["antropic"] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("UNKNOWN_PROVIDER");
    const nobody = await as(admin, { method: "PUT", url: "/labels/never-defined-here/providers", payload: { providers: [] } });
    expect(nobody.statusCode).toBe(404);
    expect(nobody.json().code).toBe("UNKNOWN_LABEL");
  });

  it("needs the permission of its own: administering is not enough", async () => {
    const other = await signIn("clearance-other-admin");
    await as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "administer", account_id: other.id } });
    const refused = await as(other, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["anthropic"] } });
    expect(refused.statusCode).toBe(403);
    // Reading where things stand is open to an administrator.
    expect((await as(other, { url: "/labels/providers" })).statusCode).toBe(200);
    // Defining a label with providers ticked needs it too; defining one without does not.
    const name = `cl${randomUUID().slice(0, 8)}`;
    const ticked = await as(other, { method: "POST", url: "/labels", payload: { name, description: "x", providers: ["anthropic"] } });
    expect(ticked.statusCode).toBe(403);
    expect(await rawQuery(`SELECT 1 FROM labels WHERE name = $1`, [name])).toHaveLength(0);

    const clearer = await signIn("clearance-clearer");
    await as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "clear_providers", account_id: clearer.id } });
    const done = await as(clearer, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["web_pages"] } });
    expect(done.statusCode, done.body).toBe(200);
    expect((await as(clearer, { url: "/labels/providers" })).statusCode).toBe(200);
    // Clearing providers is not administering.
    expect((await as(clearer, { url: "/labels" })).statusCode).toBe(403);
  });

  it("is refused where the deployment's settings fix the clearance, and the stored choice is not read", async () => {
    await rawQuery(`INSERT INTO provider_clearances (provider, label) VALUES ('openrouter', $1) ON CONFLICT DO NOTHING`, [LABEL]);
    deployment.providerLabels = { anthropic: ["public"] };
    const listed = await as(admin, { url: "/labels/providers" });
    expect(listed.json().fixed_by_settings).toBe(true);
    expect(listed.json().labels.find((l: { label: string }) => l.label === LABEL).cleared).toEqual([]);
    const refused = await as(admin, { method: "PUT", url: `/labels/${LABEL}/providers`, payload: { providers: ["anthropic"] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("FIXED_BY_SETTINGS");
    await expect(atLabel(LABEL, () => assertProviderCleared("openrouter"))).rejects.toThrow(/PROVIDER_LABELS/);
  });
});

describe("POST /labels with providers", () => {
  it("defines the label and clears what was ticked, in one act, logged", async () => {
    const res = await as(admin, {
      method: "POST",
      url: "/labels",
      payload: { name: OTHER, description: "Defined with its providers.", providers: ["anthropic", "web_pages"] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const rows = await rawQuery<{ provider: string; cleared_by: string }>(
      `SELECT provider, cleared_by FROM provider_clearances WHERE label = $1 ORDER BY provider`,
      [OTHER]
    );
    expect(rows).toEqual([
      { provider: "anthropic", cleared_by: admin.id },
      { provider: "web_pages", cleared_by: admin.id },
    ]);
    await atLabel(OTHER, () => assertProviderCleared("anthropic"));
    const events = await rawQuery<{ action: string }>(
      `SELECT action FROM administrative_events WHERE detail->>'label' = $1 ORDER BY created_at`,
      [OTHER]
    );
    expect(events.map((e) => e.action)).toEqual(["label_defined", "provider_clearance_set"]);
  });

  it("defines nothing when a provider named is not one", async () => {
    const name = `cl${randomUUID().slice(0, 8)}`;
    const res = await as(admin, { method: "POST", url: "/labels", payload: { name, description: "x", providers: ["nobody"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("UNKNOWN_PROVIDER");
    expect(await rawQuery(`SELECT 1 FROM labels WHERE name = $1`, [name])).toHaveLength(0);
  });
});

describe("the table", () => {
  it("cannot hold a row for public, or for a label nobody defined", async () => {
    await expect(rawQuery(`INSERT INTO provider_clearances (provider, label) VALUES ('anthropic', 'public')`)).rejects.toThrow();
    await expect(
      rawQuery(`INSERT INTO provider_clearances (provider, label) VALUES ('anthropic', 'never-defined-anywhere')`)
    ).rejects.toThrow();
  });
});
