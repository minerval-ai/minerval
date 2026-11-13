/**
 * The setup checklist (src/services/setup-checklist-service.ts,
 * src/routes/setup-checklist.ts), against the real app and real tables in a
 * members-only deployment that creates its own owls: who may read it, what
 * it says of the deployment's own checks, and that each part follows what the
 * deployment holds: grants, labels and the providers cleared for them, the
 * standing mandates, owls, the usage report and the material.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "checklist-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-checklist-administrator";
const LABEL = "checklist-internal";

// Set before any module reads config.
vi.hoisted(() => {
  process.env.READS = "members";
  process.env.OWLS = "created";
  process.env.API_KEYS = "checklist-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-checklist-administrator";
  // Anthropic is cleared for the test's label; embeddings are cleared for a
  // label nobody has defined, which the checklist must name.
  process.env.PROVIDER_LABELS = JSON.stringify({
    anthropic: ["public", "checklist-internal"],
    embeddings: ["public", "checklist-never-defined"],
  });
  process.env.LOG_LEVEL = "fatal";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.USAGE_REPORT_URL;
  delete process.env.USAGE_REPORT_DIR;
});

import { rawQuery } from "../../src/db/client.js";
import { MCP_EXCLUDED_ROUTES, ROUTE_TOOLS } from "../../src/mcp/route-tools.js";
import { PERMISSIONS } from "../../src/permissions.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { PLATFORM_EXTERNAL_ID } from "../../src/services/platform-account.js";
import type { SetupChecklist } from "../../src/services/setup-checklist-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";

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

async function checklist(person: Person): Promise<SetupChecklist> {
  const res = await as(person, { url: "/setup/checklist" });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SetupChecklist;
}

let admin: Person;
const sourceIds: string[] = [];
/** The deployment's own account takes the organization's name here; put back when the file is done. */
let ownAccountNameBefore: string | null = null;

beforeAll(async () => {
  // Start from a deployment that has never had an administrator and has no
  // standing mandate live: the scratch database is shared with every other
  // file in the suite.
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'dbtest') ON CONFLICT DO NOTHING`, [LABEL]);
  // More than one label, so the database holds each request below to its clearance.
  await ensureEnforcement();
  const [own] = await rawQuery<{ display_name: string }>(
    `SELECT display_name FROM contributors WHERE external_id = $1`,
    [PLATFORM_EXTERNAL_ID]
  );
  ownAccountNameBefore = own?.display_name ?? null;

  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("Checklist Administrator", FIRST_ADMINISTRATOR);
});

afterAll(async () => {
  await app?.close();
  if (sourceIds.length > 0) await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[])`, [sourceIds]);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  await rawQuery(`DELETE FROM label_reads WHERE label = $1 OR reads = $1`, [LABEL]);
  await rawQuery(`DELETE FROM labels WHERE name = $1`, [LABEL]);
  if (ownAccountNameBefore !== null) {
    await rawQuery(`UPDATE contributors SET display_name = $2 WHERE external_id = $1`, [
      PLATFORM_EXTERNAL_ID,
      ownAccountNameBefore,
    ]);
  }
});

describe("who may read the checklist", () => {
  it("is not served to someone who is not signed in, or to a member who does not administer", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/setup/checklist" });
    expect(anonymous.statusCode).toBe(401);

    const reader = await signIn("checklist-reader");
    const granted = await as(admin, {
      method: "POST",
      url: "/permissions/grants",
      payload: { permission: "read", account_id: reader.id, label: LABEL },
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const refused = await as(reader, { url: "/setup/checklist" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "administer" });
  });

  it("is an MCP tool, as the administrators' other reads are", () => {
    expect(ROUTE_TOOLS["GET /setup/checklist"]?.name).toBe("get_setup_checklist");
    expect("GET /setup/checklist" in MCP_EXCLUDED_ROUTES).toBe(false);
  });
});

describe("what the checklist says", () => {
  it("carries no report of the deployment's own checks, in a build that has no preflight", async () => {
    // The preflight is a separate change (services/deployment-checks.ts). Until the two meet the part is
    // null, and the page says the checks are not in this build.
    const { preflight } = await checklist(admin);
    expect(preflight).toBeNull();
  });

  it("counts who holds each permission, by label and by party where it is granted at one", async () => {
    const before = await checklist(admin);
    expect(before.permissions.map((p) => p.permission)).toEqual([...PERMISSIONS]);
    // The first administrator holds everything; the reader above holds read at the label.
    const of = (c: SetupChecklist, name: string) => c.permissions.find((p) => p.permission === name)!;
    expect(of(before, "administer")).toMatchObject({ scope: "none", accounts: 1, groups: 0 });
    expect(of(before, "read").by_label!.find((l) => l.label === LABEL)).toMatchObject({ accounts: 2, groups: 0 });
    expect(of(before, "read").by_label!.some((l) => l.label === "public")).toBe(false);
    // The organization itself is a party from setup, and the first administrator holds release for it.
    expect(of(before, "release").by_party).toEqual([
      { party: { id: expect.any(String), name: "This organization" }, accounts: 1, groups: 0 },
    ]);

    const party = await as(admin, { method: "POST", url: "/parties", payload: { name: "Orrin Labs (checklist)" } });
    expect(party.statusCode, party.body).toBe(201);
    const partyId = party.json().party.id as string;
    const group = await as(admin, {
      method: "POST",
      url: "/permissions/grants",
      payload: { permission: "release", group: "orrin-reviewers", party_id: partyId },
    });
    expect(group.statusCode, group.body).toBe(201);

    const after = await checklist(admin);
    expect(of(after, "release")).toMatchObject({ scope: "party", accounts: 1, groups: 1 });
    expect(of(after, "release").by_party!.find((p) => p.party.id === partyId)).toEqual({
      party: { id: partyId, name: "Orrin Labs (checklist)" },
      accounts: 0,
      groups: 1,
    });
    expect(of(after, "release").by_party).toHaveLength(2);
  });

  it("says which providers are cleared for each label, and which roles are left unserved at it", async () => {
    const { labels, undefined_labels_in_provider_setting: undefinedNames } = await checklist(admin);
    const label = labels.find((l) => l.name === LABEL)!;
    expect(labels.some((l) => l.name === "public")).toBe(false);
    expect(label.model_providers_cleared).toEqual(["anthropic"]);
    // Embeddings were cleared for a label that does not exist, not for this one.
    expect(label.outside_services_cleared).toEqual([]);
    for (const role of label.roles_not_served) expect(role.provider).not.toBe("anthropic");
    expect(undefinedNames).toEqual(["checklist-never-defined"]);
  });

  it("follows the standing mandates, the owls and the usage report as they are set up", async () => {
    const before = await checklist(admin);
    expect(before.standing_mandates.map((m) => [m.name, m.mandate])).toEqual([
      ["general", null],
      ["governance", null],
    ]);
    expect(before.owls.created_here).toBe(true);
    expect(before.usage_report).toMatchObject({ price: "metered", reporting: true, destination: "none", destination_ready: false });

    // Set up with no budget, and owls created into a person's balance: the
    // deployment's own account, whose ledger other files in the suite read
    // whole, is left as it was.
    const setUp = await as(admin, {
      method: "POST",
      url: "/standing-mandates/general",
      payload: { daily_owls: 4, label: "public" },
    });
    expect(setUp.statusCode, setUp.body).toBe(201);
    const created = await as(admin, {
      method: "POST",
      url: "/owls/created",
      payload: { amount_owls: 25, account_id: admin.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    const after = await checklist(admin);
    expect(after.standing_mandates.find((m) => m.name === "general")!.mandate).toMatchObject({
      budget_owls: 0,
      daily_owls: 4,
    });
    expect(after.standing_mandates.find((m) => m.name === "governance")!.mandate).toBeNull();
    expect(after.owls.created_total_owls).toBe(before.owls.created_total_owls! + 25);
  });

  it("counts the material by the party it belongs to, and returns no row's label", async () => {
    const before = await checklist(admin);
    const partyId = before.material.sources_by_party[0]!.party.id;
    const source = await getOrCreateSource({
      url: `https://example.org/checklist/${randomUUID()}`,
      title: "A checklist test document",
      content: "Nothing of consequence.",
    });
    sourceIds.push(source.id);
    const unowned = await checklist(admin);
    expect(unowned.material.sources).toBe(before.material.sources + 1);
    expect(unowned.material.sources_with_no_party).toBe(before.material.sources_with_no_party + 1);

    const set = await as(admin, { method: "PUT", url: `/sources/${source.id}/party`, payload: { party_id: partyId } });
    expect(set.statusCode, set.body).toBe(200);
    const owned = await checklist(admin);
    expect(owned.material.sources_with_no_party).toBe(before.material.sources_with_no_party);
    expect(owned.material.sources_by_party.find((p) => p.party.id === partyId)!.sources).toBe(
      before.material.sources_by_party[0]!.sources + 1
    );
    expect(JSON.stringify(owned)).not.toContain("sensitivity_label");
  });

  it("counts the whole deployment's material for an administrator who reads one label, and the connections they are not shown", async () => {
    // Material and a connection at the test's label, which the second administrator does not read.
    const [private_source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A document at the private label', $2) RETURNING id`,
      [`https://example.org/checklist/private/${randomUUID()}`, LABEL]
    );
    sourceIds.push(private_source!.id);
    const whole = await checklist(admin);
    const [party] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    const [connection] = await rawQuery<{ id: string }>(
      `INSERT INTO connections (name, tool_prefix, url, party_id, stake, sensitivity_label)
       VALUES ($1, $2, 'http://127.0.0.1:9/mcp', $3, 'The organization runs it.', $4) RETURNING id`,
      [`Checklist warehouse ${randomUUID().slice(0, 8)}`, `chk_${randomUUID().slice(0, 8)}`, party!.id, LABEL]
    );
    try {
      const second = await signIn("checklist-second-admin");
      const granted = await as(admin, { method: "POST", url: "/permissions/grants", payload: { permission: "administer", account_id: second.id } });
      expect(granted.statusCode, granted.body).toBe(201);
      const seenByFirst = await checklist(admin);
      const seenBySecond = await checklist(second);
      // The same counts of material, whatever labels the administrator reads.
      expect(seenBySecond.material).toEqual(seenByFirst.material);
      expect(seenByFirst.material.sources).toBe(whole.material.sources);
      // The first administrator reads the connection's label; the second is told there is one they are not shown.
      expect(seenByFirst.connections.total).toBe(whole.connections.total + 1);
      expect(seenByFirst.connections.not_shown).toBe(0);
      expect(seenBySecond.connections.total).toBe(seenByFirst.connections.total - 1);
      expect(seenBySecond.connections.not_shown).toBe(1);
      expect(JSON.stringify(seenBySecond)).not.toContain("Checklist warehouse");
    } finally {
      await rawQuery(`DELETE FROM connections WHERE id = $1`, [connection!.id]);
    }
  });
});
