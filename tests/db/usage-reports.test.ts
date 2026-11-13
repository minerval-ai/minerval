/**
 * The usage report (docs/usage-report.md; src/services/usage-report-service.ts),
 * against the real app and real tables: a day's total against seeded spend,
 * that preparing twice writes once, that a report says nothing but its
 * total, late sending, a correction as a new entry, handing reports over as
 * files, the flat price sending nothing, and the receiving route.
 *
 * One app plays both parts here: the private deployment that reports, and
 * the public graph that receives. The "network" between them is a fetch
 * the test supplies, which delivers into the same app.
 *
 * The test's days are in March 2001, far from anything else in the scratch
 * database, and the clock is passed in.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVICE_KEY = "usage-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-usage-administrator";
const PUBLIC_GRAPH = "https://public-graph.example/usage-reports";

vi.hoisted(() => {
  process.env.READS = "members";
  delete process.env.OWLS;
  delete process.env.PUBLIC_GRAPH_PRICE;
  delete process.env.USAGE_REPORT_URL;
  delete process.env.USAGE_REPORT_API_KEY;
  delete process.env.USAGE_REPORT_DIR;
  process.env.USAGE_REPORT_FROM = "2001-03-05";
  process.env.API_KEYS = "usage-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-usage-administrator";
  process.env.LOG_LEVEL = "fatal";
});

import { loadConfig } from "../../src/config.js";
import { rawQuery } from "../../src/db/client.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { createApiKey } from "../../src/services/api-key-service.js";
import {
  FLAT_PRICE_SENDS_NOTHING,
  WHAT_IS_NEVER_SENT,
  WHAT_IS_SENT,
  prepareUsageReports,
  sendUsageReports,
} from "../../src/services/usage-report-service.js";
import { usageReportTick } from "../../src/workers/usage-reports.js";
import { OWL, seedClaim } from "./helpers.js";

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

/** Post a report as an account does: with its own API key. */
function report(key: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/usage-reports",
    headers: { "x-api-key": key, "content-type": "application/json" },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const REQUEST_ID = `dbtest-usage-${randomUUID()}`;
/** One metered call at a moment, carrying everything a report must never carry. */
async function meter(at: string, costMicroUsd: number, claimId: string | null = null, label = "public") {
  await rawQuery(
    `INSERT INTO llm_usage (agent, model, provider, cost_micro_usd, claim_id, request_id, created_at, sensitivity_label)
     VALUES ('steward', 'claude-opus-5-5', 'anthropic', $1, $2, $3, $4::timestamptz, $5)`,
    [costMicroUsd, claimId, REQUEST_ID, at, label]
  );
}

/** The cached config, changed in place: how a test moves the deployment between settings. */
const set = (change: Record<string, unknown>) => Object.assign(loadConfig(), change);

const stored = () =>
  rawQuery<{
    period: string;
    revision: number;
    body: string;
    spent: string;
    sent_at: Date | null;
    sent_via: string | null;
    receipt: unknown;
    last_error: string | null;
  }>(
    `SELECT to_char(period, 'YYYY-MM-DD') AS period, revision, body, spent_micro_owls::bigint AS spent,
            sent_at, sent_via, receipt, last_error
       FROM usage_reports ORDER BY period, revision`
  );

/** The network to the public graph: deliver into this same app, and keep what crossed. */
const crossed: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
const deliver = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = init!.headers as Record<string, string>;
  crossed.push({ url: String(url), headers, body: String(init!.body) });
  const res = await app.inject({ method: "POST", url: "/usage-reports", headers, payload: String(init!.body) });
  return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const offline = (async () => {
  throw new Error("connect ECONNREFUSED public-graph.example:443");
}) as typeof fetch;

// Noon on 9 March 2001: the closed days are up to the 8th.
const NOW = new Date("2001-03-09T12:00:00Z");

let admin: Person;
let member: Person;
let organization: Person;
let organizationKey: string;
let otherOrganizationKey: string;
let claimId: string;

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`DELETE FROM usage_reports`);
  await rawQuery(`DELETE FROM usage_reports_received`);
  await rawQuery(`INSERT INTO labels (name, description) VALUES ('internal', 'dbtest') ON CONFLICT DO NOTHING`);
  // More than one label, so the database holds each connection to a clearance: the report must count past it.
  await ensureEnforcement();

  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();

  admin = await signIn("usage-admin", FIRST_ADMINISTRATOR);
  member = await signIn("usage-member");
  // The organization's account on the "public graph", and another organization's.
  organization = await signIn("Acme Research");
  const other = await signIn("Other Organization");
  for (const who of [member, organization, other]) {
    const res = await as(admin, {
      method: "POST",
      url: "/permissions/grants",
      payload: { permission: "read", account_id: who.id, label: "internal" },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  organizationKey = (await createApiKey({ userId: organization.id, name: "usage reports" })).plaintext;
  otherOrganizationKey = (await createApiKey({ userId: other.id, name: "usage reports" })).plaintext;

  claimId = await seedClaim("a claim the organization cares about");
  // Before the first day reported: never counted.
  await meter("2001-03-04T23:59:59Z", 9 * OWL, claimId);
  // 5 March: three calls, the first and last at the day's edges.
  await meter("2001-03-05T00:00:00Z", 1.5 * OWL, claimId);
  // (This one by a run at a label only some members read.)
  await meter("2001-03-05T13:00:00Z", 2 * OWL, claimId, "internal");
  await meter("2001-03-05T23:59:59.999Z", 0.25 * OWL);
  // 6 March: one call. 7 March: none. 8 March: a fraction of an owl.
  await meter("2001-03-06T08:00:00Z", 10 * OWL, claimId);
  await meter("2001-03-08T08:00:00Z", 123_457, claimId);
  // 9 March is today: not closed, not reported.
  await meter("2001-03-09T01:00:00Z", 50 * OWL, claimId);
});

afterAll(async () => {
  await app?.close();
  await rawQuery(`DELETE FROM llm_usage WHERE request_id = $1`, [REQUEST_ID]);
  await rawQuery(`DELETE FROM usage_reports`);
  await rawQuery(`DELETE FROM usage_reports_received`);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
});

describe("preparing", () => {
  it("writes one report for each closed UTC day, with that day's total and nothing else", async () => {
    // Prepared as a worker or a person who reads `public` alone would: the
    // report is of every run, whatever its label, so the 5th counts the call
    // made at `internal` all the same.
    const written = await runWithUsageContext({ clearance: ["public"] }, () => prepareUsageReports(NOW));
    expect(written.map((r) => [r.period, r.revision])).toEqual([
      ["2001-03-05", 0],
      ["2001-03-06", 0],
      ["2001-03-07", 0],
      ["2001-03-08", 0],
    ]);
    const rows = await stored();
    expect(rows.map((r) => [r.period, Number(r.spent)])).toEqual([
      ["2001-03-05", 3.75 * OWL],
      ["2001-03-06", 10 * OWL],
      // A day with no spend is reported as none, so the record has no gap.
      ["2001-03-07", 0],
      ["2001-03-08", 123_457],
    ]);
    const deployment = JSON.parse(rows[0]!.body).deployment as string;
    expect(rows.map((r) => r.body)).toEqual([
      `{"deployment":"${deployment}","format":1,"kind":"minerval-usage-report","owls_spent":"3.750000","period":"2001-03-05","revision":0}`,
      `{"deployment":"${deployment}","format":1,"kind":"minerval-usage-report","owls_spent":"10.000000","period":"2001-03-06","revision":0}`,
      `{"deployment":"${deployment}","format":1,"kind":"minerval-usage-report","owls_spent":"0.000000","period":"2001-03-07","revision":0}`,
      `{"deployment":"${deployment}","format":1,"kind":"minerval-usage-report","owls_spent":"0.123457","period":"2001-03-08","revision":0}`,
    ]);
    expect(rows.every((r) => r.sent_at === null)).toBe(true);
  });

  it("says nothing of which claims, agents or models the work was for", async () => {
    for (const row of await stored()) {
      expect(Object.keys(JSON.parse(row.body)).sort()).toEqual([
        "deployment",
        "format",
        "kind",
        "owls_spent",
        "period",
        "revision",
      ]);
      expect(row.body).not.toContain(claimId);
      expect(row.body).not.toMatch(/steward|claude|anthropic|Acme/);
    }
  });

  it("is idempotent by period: preparing again writes nothing and changes nothing", async () => {
    const before = await stored();
    expect(await prepareUsageReports(NOW)).toEqual([]);
    expect(await prepareUsageReports(new Date("2001-03-09T23:59:59Z"))).toEqual([]);
    const [a, b] = await Promise.all([prepareUsageReports(NOW), prepareUsageReports(NOW)]);
    expect([...a, ...b]).toEqual([]);
    expect(await stored()).toEqual(before);
  });
});

describe("what the administrators read", () => {
  it("is every report exactly as it will be sent, before it is sent", async () => {
    const res = await as(admin, { url: "/usage-reports/outgoing" });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json();
    expect(page).toMatchObject({
      price: "metered",
      reporting: true,
      what_is_sent: WHAT_IS_SENT,
      what_is_never_sent: WHAT_IS_NEVER_SENT,
      destination: { kind: "none" },
    });
    const rows = await stored();
    expect(page.reports.map((r: { period: string }) => r.period)).toEqual([
      "2001-03-08",
      "2001-03-07",
      "2001-03-06",
      "2001-03-05",
    ]);
    expect(page.reports.map((r: { body: string }) => r.body).reverse()).toEqual(rows.map((r) => r.body));
    expect(page.reports.every((r: { sent_at: string | null }) => r.sent_at === null)).toBe(true);
  });

  it("is for administrators: a member without the permission is refused", async () => {
    const res = await as(member, { url: "/usage-reports/outgoing" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "administer" });
    const send = await as(member, { method: "POST", url: "/usage-reports/outgoing/send", payload: {} });
    expect(send.statusCode).toBe(403);
  });
});

describe("sending", () => {
  it("keeps the reports when no destination is set, and says so", async () => {
    const outcome = await sendUsageReports({ fetch: deliver });
    expect(outcome.sent).toBe(0);
    expect(outcome.stopped).toMatch(/No destination is set/);
    expect(crossed).toEqual([]);
  });

  it("keeps them while the deployment is offline, and records the failed attempt", async () => {
    set({ usageReportUrl: PUBLIC_GRAPH, usageReportApiKey: organizationKey });
    const outcome = await sendUsageReports({ fetch: offline });
    expect(outcome).toEqual({ sent: 0, stopped: "connect ECONNREFUSED public-graph.example:443" });
    const rows = await stored();
    expect(rows.every((r) => r.sent_at === null)).toBe(true);
    // It stopped at the first, oldest report and left the rest for later.
    expect(rows.map((r) => r.last_error)).toEqual([
      "connect ECONNREFUSED public-graph.example:443",
      null,
      null,
      null,
    ]);
  });

  it("sends late, oldest first, each report exactly as it was prepared", async () => {
    const prepared = await stored();
    const outcome = await sendUsageReports({ fetch: deliver });
    expect(outcome).toEqual({ sent: 4, stopped: null });
    expect(crossed.map((c) => c.url)).toEqual([PUBLIC_GRAPH, PUBLIC_GRAPH, PUBLIC_GRAPH, PUBLIC_GRAPH]);
    expect(crossed.every((c) => c.headers["x-api-key"] === organizationKey)).toBe(true);
    // What crossed the network is the stored text, character for character.
    expect(crossed.map((c) => c.body)).toEqual(prepared.map((r) => r.body));

    const rows = await stored();
    expect(rows.map((r) => r.body)).toEqual(prepared.map((r) => r.body));
    expect(rows.every((r) => r.sent_at !== null && r.sent_via === "online" && r.last_error === null)).toBe(true);
    expect(rows[0]!.receipt).toMatchObject({ recorded: true, period: "2001-03-05", revision: 0, charged: false });

    // The public graph holds each against the organization's account, as sent.
    const received = await rawQuery<{ account_id: string; body: string }>(
      `SELECT account_id, body FROM usage_reports_received ORDER BY period, revision`
    );
    expect(received.map((r) => r.account_id)).toEqual([organization.id, organization.id, organization.id, organization.id]);
    expect(received.map((r) => r.body)).toEqual(prepared.map((r) => r.body));
  });

  it("sends each report once: a later pass has nothing to send", async () => {
    crossed.length = 0;
    expect(await sendUsageReports({ fetch: deliver })).toEqual({ sent: 0, stopped: null });
    expect(crossed).toEqual([]);
    const page = (await as(admin, { url: "/usage-reports/outgoing" })).json();
    expect(page.destination).toEqual({ kind: "online", url: PUBLIC_GRAPH, ready: true });
    expect(page.reports.every((r: { sent_via: string }) => r.sent_via === "online")).toBe(true);
  });
});

describe("a correction", () => {
  it("is a new entry: the report that was sent is not changed", async () => {
    const before = await stored();
    // A call metered late into a day already reported.
    await meter("2001-03-06T21:00:00Z", 0.5 * OWL, claimId);
    const written = await prepareUsageReports(NOW);
    expect(written.map((r) => [r.period, r.revision])).toEqual([["2001-03-06", 1]]);
    expect(JSON.parse(written[0]!.body)).toMatchObject({ period: "2001-03-06", revision: 1, owls_spent: "10.500000" });

    const rows = await stored();
    expect(rows).toHaveLength(5);
    const original = rows.find((r) => r.period === "2001-03-06" && r.revision === 0)!;
    expect(original).toEqual(before.find((r) => r.period === "2001-03-06"));
    // Preparing again does not correct the correction.
    expect(await prepareUsageReports(NOW)).toEqual([]);

    crossed.length = 0;
    expect(await sendUsageReports({ fetch: deliver })).toEqual({ sent: 1, stopped: null });
    const received = await rawQuery<{ revision: number; spent: string }>(
      `SELECT revision, spent_micro_owls::bigint AS spent FROM usage_reports_received
        WHERE period = '2001-03-06' ORDER BY revision`
    );
    expect(received).toEqual([
      { revision: 0, spent: String(10 * OWL) },
      { revision: 1, spent: String(10.5 * OWL) },
    ]);
  });

  it("is made for an older day when an administrator asks for a recount", async () => {
    // Ten days on, the 5th is outside the week a pass recounts by itself.
    const later = new Date("2001-03-19T12:00:00Z");
    await meter("2001-03-05T22:00:00Z", 1 * OWL);
    const routine = await prepareUsageReports(later);
    expect(routine.filter((r) => r.period === "2001-03-05")).toEqual([]);
    // The days since are reported, each with no spend but the 9th's.
    expect(routine.map((r) => r.period)).toEqual([
      "2001-03-09", "2001-03-10", "2001-03-11", "2001-03-12", "2001-03-13",
      "2001-03-14", "2001-03-15", "2001-03-16", "2001-03-17", "2001-03-18",
    ]);
    expect(JSON.parse(routine[0]!.body).owls_spent).toBe("50.000000");

    const asked = await prepareUsageReports(later, { recountFrom: "2001-03-01" });
    expect(asked.map((r) => [r.period, r.revision])).toEqual([["2001-03-05", 1]]);
    expect(JSON.parse(asked[0]!.body).owls_spent).toBe("4.750000");
  });
});

describe("handing reports over as files", () => {
  it("writes each unsent report to the directory, exactly as prepared, and records where", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usage-reports-"));
    try {
      set({ usageReportUrl: "", usageReportApiKey: "", usageReportDir: directory });
      const unsent = (await stored()).filter((r) => r.sent_at === null);
      expect(unsent.length).toBe(11);
      crossed.length = 0;
      const outcome = await sendUsageReports({ fetch: deliver });
      expect(outcome).toEqual({ sent: 11, stopped: null });
      // Nothing went over the network.
      expect(crossed).toEqual([]);

      const files = (await readdir(directory)).sort();
      expect(files).toHaveLength(11);
      expect(files).toContain("usage-report-2001-03-05-r1.json");
      expect(files).toContain("usage-report-2001-03-18-r0.json");
      for (const row of unsent) {
        const file = `usage-report-${row.period}-r${row.revision}.json`;
        expect(await readFile(path.join(directory, file), "utf8")).toBe(row.body);
      }
      const rows = await stored();
      const corrected = rows.find((r) => r.period === "2001-03-05" && r.revision === 1)!;
      expect(corrected).toMatchObject({ sent_via: "file", receipt: { file: "usage-report-2001-03-05-r1.json" } });

      // The file is what the person handing it over posts, under the organization's key.
      const handed = await report(organizationKey, await readFile(path.join(directory, "usage-report-2001-03-05-r1.json"), "utf8"));
      expect(handed.statusCode, handed.body).toBe(201);
      expect(handed.json()).toMatchObject({ recorded: true, period: "2001-03-05", revision: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
      set({ usageReportDir: "" });
    }
  });
});

describe("the flat price", () => {
  it("prepares nothing and sends nothing, and the page says so", async () => {
    set({ publicGraphPrice: "flat", usageReportUrl: PUBLIC_GRAPH, usageReportApiKey: organizationKey });
    try {
      const before = await stored();
      // Days have closed since the last report, with spend in them.
      const muchLater = new Date("2001-04-02T12:00:00Z");
      await meter("2001-03-25T10:00:00Z", 30 * OWL, claimId);
      expect(await prepareUsageReports(muchLater)).toEqual([]);
      crossed.length = 0;
      expect(await sendUsageReports({ fetch: deliver })).toEqual({ sent: 0, stopped: null });
      expect(await usageReportTick(muchLater)).toEqual({ prepared: 0, sent: 0, stopped: null });
      expect(crossed).toEqual([]);
      expect(await stored()).toEqual(before);

      const page = (await as(admin, { url: "/usage-reports/outgoing" })).json();
      expect(page).toMatchObject({
        price: "flat",
        reporting: false,
        what_is_sent: FLAT_PRICE_SENDS_NOTHING,
        what_is_never_sent: null,
      });
      const send = await as(admin, { method: "POST", url: "/usage-reports/outgoing/send", payload: {} });
      expect(send.statusCode).toBe(200);
      expect(send.json()).toMatchObject({ prepared: 0, sent: 0, reporting: false });
      expect(await stored()).toEqual(before);
    } finally {
      set({ publicGraphPrice: "metered", usageReportUrl: "", usageReportApiKey: "" });
    }
  });

  it("is left behind by naming the first metered day, so flat days are not reported", async () => {
    // Back on the metered price from 1 April: the flat days of late March stay unreported.
    set({ usageReportFrom: "2001-04-01" });
    try {
      const written = await prepareUsageReports(new Date("2001-04-03T00:00:01Z"));
      expect(written.map((r) => r.period)).toEqual(["2001-04-01", "2001-04-02"]);
      const [late] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM usage_reports WHERE period BETWEEN '2001-03-19' AND '2001-03-31'`
      );
      expect(late!.n).toBe(0);
    } finally {
      set({ usageReportFrom: "2001-03-05" });
    }
  });
});

describe("the receiving route", () => {
  const deployment = randomUUID();
  const body = (change: Record<string, unknown> = {}) => ({
    format: 1,
    kind: "minerval-usage-report",
    deployment,
    period: "2026-11-01",
    revision: 0,
    owls_spent: "18.250000",
    ...change,
  });
  const recordedFor = (accountId: string) =>
    rawQuery<{ period: string; revision: number; body: string; spent: string }>(
      `SELECT to_char(period, 'YYYY-MM-DD') AS period, revision, body, spent_micro_owls::bigint AS spent
         FROM usage_reports_received WHERE account_id = $1 AND deployment_id = $2 ORDER BY period, revision`,
      [accountId, deployment]
    );

  it("stores a report against the account that sent it, and charges nothing", async () => {
    const res = await report(organizationKey, body());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ recorded: true, period: "2026-11-01", revision: 0, charged: false });
    const rows = await recordedFor(organization.id);
    expect(rows).toEqual([
      {
        period: "2026-11-01",
        revision: 0,
        body: `{"deployment":"${deployment}","format":1,"kind":"minerval-usage-report","owls_spent":"18.250000","period":"2026-11-01","revision":0}`,
        spent: String(18.25 * OWL),
      },
    ]);
    // Recording a report moved no owls.
    const [ledger] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM owl_ledger WHERE user_id = $1`,
      [organization.id]
    );
    expect(ledger!.n).toBe(0);
  });

  it("takes the same report twice as one", async () => {
    const again = await report(organizationKey, body());
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ recorded: false, period: "2026-11-01", revision: 0 });
    expect(await recordedFor(organization.id)).toHaveLength(1);
  });

  it("refuses a different report for a period already recorded, and takes the next revision", async () => {
    const before = await recordedFor(organization.id);
    const changed = await report(organizationKey, body({ owls_spent: "1.000000" }));
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({
      error:
        "A different report for 2026-11-01, revision 0, is already recorded for this deployment " +
        "under this account, and a recorded report is not changed. Send a correction as the " +
        "next revision.",
      code: "REPORT_DIFFERS",
    });
    expect(await recordedFor(organization.id)).toEqual(before);

    const correction = await report(organizationKey, body({ owls_spent: "1.000000", revision: 1 }));
    expect(correction.statusCode, correction.body).toBe(201);
    expect((await recordedFor(organization.id)).map((r) => [r.revision, r.spent])).toEqual([
      [0, String(18.25 * OWL)],
      [1, String(1 * OWL)],
    ]);
  });

  it("keeps each account's reports apart: another account's report for the same period touches nothing of the first's", async () => {
    const before = await recordedFor(organization.id);
    // The same deployment identifier and day, a different figure, from another account.
    const other = await report(otherOrganizationKey, body({ owls_spent: "999.000000" }));
    expect(other.statusCode, other.body).toBe(201);
    expect(await recordedFor(organization.id)).toEqual(before);
    const [others] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM usage_reports_received WHERE deployment_id = $1 AND account_id <> $2`,
      [deployment, organization.id]
    );
    expect(others!.n).toBe(1);
    // And that account cannot send its own period twice with a different figure either.
    const twice = await report(otherOrganizationKey, body({ owls_spent: "5.000000" }));
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("REPORT_DIFFERS");
  });

  it("refuses a day that has not ended, and a body that is not a usage report", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const open = await report(organizationKey, body({ period: today }));
    expect(open.statusCode).toBe(400);
    expect(open.json().code).toBe("PERIOD_NOT_CLOSED");

    const extra = await report(organizationKey, body({ period: "2026-11-02", claims: [claimId] }));
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toEqual({
      error:
        "A usage report carries format, kind, deployment, period, revision, owls_spent and nothing " +
        'else. This one also has "claims".',
      code: "NOT_A_USAGE_REPORT",
    });
    expect((await report(organizationKey, body({ period: "2026-11-02", owls_spent: "12.5" }))).statusCode).toBe(400);
    expect((await report(organizationKey, { period: "2026-11-02" })).statusCode).toBe(400);
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM usage_reports_received WHERE deployment_id = $1 AND period = '2026-11-02'`,
      [deployment]
    );
    expect(n!.n).toBe(0);
  });

  it("takes a report only from an account", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/usage-reports", payload: body({ period: "2026-11-03" }) });
    expect(anonymous.statusCode).toBe(401);
    const unknown = await report("epk_not-a-key", body({ period: "2026-11-03" }));
    expect(unknown.statusCode).toBe(401);
  });
});

describe("the first day reported", () => {
  it("is the first day anything was metered, where the deployment names none", async () => {
    await rawQuery(`DELETE FROM usage_reports`);
    set({ usageReportFrom: "" });
    try {
      const [meterStart] = await rawQuery<{ day: string }>(
        `SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM llm_usage`
      );
      // This file's own earliest call, unless another file's is earlier still.
      expect(meterStart!.day <= "2001-03-04").toBe(true);
      const written = await prepareUsageReports(new Date("2001-03-06T12:00:00Z"));
      expect(written[0]!.period).toBe(meterStart!.day);
      expect(written.at(-1)!.period).toBe("2001-03-05");
      const fourth = written.find((r) => r.period === "2001-03-04")!;
      expect(JSON.parse(fourth.body)).toMatchObject({ revision: 0, owls_spent: "9.000000" });
    } finally {
      set({ usageReportFrom: "2001-03-05" });
    }
  });
});
