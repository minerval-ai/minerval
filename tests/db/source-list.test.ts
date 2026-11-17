/**
 * The list of sources (GET /sources, services/source-list-service.ts),
 * against the real app and real tables in a members-only deployment with
 * more than one label: who may read it, that a source at a label the caller
 * does not read is neither listed nor counted, where each source stands as
 * the data records it, who added it, and the filters and paging.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "source-list-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-source-list-administrator";
const OURS = "sl-ours";
const THEIRS = "sl-theirs";

// Set before any module reads config.
vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "source-list-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-source-list-administrator";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { ROUTE_TOOLS } from "../../src/mcp/route-tools.js";
import type { SourceList, SourceListItem } from "../../src/services/source-list-service.js";

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

async function grant(body: Record<string, unknown>) {
  const res = await as(admin, { method: "POST", url: "/permissions/grants", payload: body });
  expect(res.statusCode, res.body).toBe(201);
}

async function list(person: Person, query = ""): Promise<SourceList> {
  const res = await as(person, { url: `/sources${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SourceList;
}

/** Every source the person is listed, page by page. */
async function everything(person: Person, query = ""): Promise<SourceListItem[]> {
  const all: SourceListItem[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await list(person, `?limit=100&offset=${offset}${query}`);
    all.push(...page.sources);
    if (page.sources.length < 100) return all;
  }
}

let admin: Person;
let director: Person;
let reader: Person;
let partyId: string;
const ids: Record<string, string> = {};

async function source(key: string, label: string, at: string, party: string | null = null): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, sensitivity_label, retrieved_at, party_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`https://example.org/source-list/${key}/${randomUUID()}`, `Source ${key}`, label, at, party]
  );
  ids[key] = row!.id;
  return row!.id;
}

async function submission(sourceId: string, label: string, by: Person, status: string, at: string) {
  await rawQuery(
    `INSERT INTO contributions (contributor_id, contribution_type, content, source_id, review_status, submitted_at, sensitivity_label)
     VALUES ($1, 'propose_source', 'https://example.org', $2, $3, $4, $5)`,
    [by.id, sourceId, status, at, label]
  );
}

async function reading(sourceId: string, label: string, status: string) {
  await rawQuery(
    `INSERT INTO jobs (type, status, input, sensitivity_label) VALUES ('url_extraction', $1, $2, $3)`,
    [status, JSON.stringify({ sourceId, url: "https://example.org" }), label]
  );
}

async function cleanUp() {
  await rawQuery(`DELETE FROM jobs WHERE type = 'url_extraction' AND sensitivity_label = ANY($1::text[])`, [[OURS, THEIRS]]);
  await rawQuery(`DELETE FROM contributions WHERE sensitivity_label = ANY($1::text[])`, [[OURS, THEIRS]]);
  await rawQuery(`DELETE FROM sources WHERE sensitivity_label = ANY($1::text[])`, [[OURS, THEIRS]]);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM connection_calls`);
  await rawQuery(`DELETE FROM connections`);
  await rawQuery(`DELETE FROM parties`);
}

beforeAll(async () => {
  await cleanUp();
  await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'dbtest'), ($2, 'dbtest') ON CONFLICT DO NOTHING`, [
    OURS,
    THEIRS,
  ]);
  // More than one label, so the database holds each request below to its clearance.
  await ensureEnforcement();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();

  // The first administrator reads every label the deployment had when it was established.
  admin = await signIn("Source List Administrator", FIRST_ADMINISTRATOR);
  const party = await as(admin, { method: "POST", url: "/parties", payload: { name: "Halden", is_own_organization: true } });
  expect(party.statusCode, party.body).toBe(201);
  partyId = party.json().party.id;

  director = await signIn("Dana Director");
  await grant({ permission: "direct", account_id: director.id });
  await grant({ permission: "read", account_id: director.id, label: OURS });
  reader = await signIn("Rhys Reader");
  await grant({ permission: "read", account_id: reader.id, label: OURS });

  // Oldest first.
  await submission(await source("rejected", OURS, "2026-11-01T09:00:00Z"), OURS, director, "rejected", "2026-11-01T09:00:00Z");
  const extracted = await source("extracted", OURS, "2026-11-05T09:00:00Z", partyId);
  await submission(extracted, OURS, director, "accepted", "2026-11-02T09:00:00Z");
  await reading(extracted, OURS, "completed");
  const kept = await source("kept", OURS, "2026-11-03T09:00:00Z");
  void kept;
  const theirs = await source("theirs", THEIRS, "2026-11-04T09:00:00Z");
  await submission(theirs, THEIRS, admin, "pending", "2026-11-04T09:00:00Z");
  await submission(await source("waiting", OURS, "2026-11-06T09:00:00Z"), OURS, director, "pending", "2026-11-06T09:00:00Z");
  const queued = await source("queued", OURS, "2026-11-07T09:00:00Z");
  await submission(queued, OURS, director, "accepted", "2026-11-07T09:00:00Z");
  await reading(queued, OURS, "pending");
});

afterAll(async () => {
  await app?.close();
  await cleanUp();
  await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[OURS, THEIRS]]);
});

describe("who may list the sources", () => {
  it("is an MCP tool", () => {
    expect(ROUTE_TOOLS["GET /sources"]?.name).toBe("list_sources");
  });

  it("takes the permission to direct or to administer: a member who only reads is refused", async () => {
    const res = await as(reader, { url: "/sources" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_REQUIRED" });
    expect((await as(director, { url: "/sources" })).statusCode).toBe(200);
    expect((await as(admin, { url: "/sources" })).statusCode).toBe(200);
  });
});

describe("what a caller is listed", () => {
  it("lists a source at a label the caller does not read nowhere, and does not count it", async () => {
    const mine = await everything(director);
    expect(mine.map((s) => s.id)).not.toContain(ids.theirs);
    for (const s of mine) expect([OURS, "public"]).toContain(s.label);
    expect((await list(director, `?at_label=${THEIRS}`)).total).toBe(0);

    const all = await everything(admin);
    expect(all.map((s) => s.id)).toContain(ids.theirs);
    // The counts cover the whole deployment, which other test files add to
    // at the same time, so they are compared as at least: the administrator,
    // who reads the other label, counts its source; the director does not.
    const [seen, whole] = [await list(director), await list(admin)];
    expect(whole.counts.sources - seen.counts.sources).toBeGreaterThanOrEqual(1);
    expect(whole.counts.pending_review - seen.counts.pending_review).toBeGreaterThanOrEqual(1);
    expect((await list(admin, `?at_label=${THEIRS}`)).total).toBe(1);
    expect(JSON.stringify(mine)).not.toContain("Source theirs");
  });

  it("says where each stands, who added it and when, newest first", async () => {
    const page = await list(director, `?at_label=${OURS}`);
    expect(page.total).toBe(5);
    const by = (key: string) => page.sources.find((s) => s.id === ids[key])!;
    expect(page.sources.map((s) => s.id)).toEqual(["queued", "waiting", "kept", "extracted", "rejected"].map((k) => ids[k]));
    expect(by("queued")).toMatchObject({ status: "queued", added_by: "Dana Director", added_at: "2026-11-07T09:00:00.000Z" });
    expect(by("waiting")).toMatchObject({ status: "pending_review", label: OURS, party: null });
    expect(by("extracted")).toMatchObject({
      status: "extracted",
      party: { id: partyId, name: "Halden" },
      // When it was submitted, not when its text was later fetched.
      added_at: "2026-11-02T09:00:00.000Z",
    });
    expect(by("rejected").status).toBe("not_admitted");
    expect(by("kept")).toMatchObject({ status: "recorded", added_by: null, contribution_id: null });
    expect(by("waiting").contribution_id).toEqual(expect.any(String));
    expect(JSON.stringify(page)).not.toContain("raw_content");
  });

  it("filters by party, and pages", async () => {
    const none = await everything(director, `&at_label=${OURS}&party=none`);
    expect(none.map((s) => s.id).sort()).toEqual(["queued", "waiting", "kept", "rejected"].map((k) => ids[k]!).sort());
    const halden = await list(director, `?party=${partyId}`);
    expect(halden.sources.map((s) => s.id)).toEqual([ids.extracted]);

    const first = await list(director, `?at_label=${OURS}&limit=2`);
    const second = await list(director, `?at_label=${OURS}&limit=2&offset=2`);
    expect(first.total).toBe(5);
    expect([...first.sources, ...second.sources].map((s) => s.id)).toEqual(
      ["queued", "waiting", "kept", "extracted"].map((k) => ids[k])
    );
    expect((await as(director, { url: "/sources?party=nobody" })).statusCode).toBe(400);
  });
});
