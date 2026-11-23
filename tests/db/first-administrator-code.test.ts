/**
 * The one-time code that makes the first administrator
 * (src/services/first-administrator-code.ts; docs/accounts.md, "The first
 * administrator"), and giving a party another name
 * (src/services/party-service.ts), against the real app in a members-only
 * deployment that names nobody in FIRST_ADMINISTRATOR.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "first-admin-web-tier-key";

vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "first-admin-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
  delete process.env.FIRST_ADMINISTRATOR;
});

import { rawQuery } from "../../src/db/client.js";
import {
  firstAdministratorCodeLines,
  issueFirstAdministratorCode,
} from "../../src/services/first-administrator-code.js";
import { PERMISSIONS } from "../../src/permissions.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
}

async function signIn(name: string): Promise<Person> {
  const externalId = `oidc:${name}-${randomUUID()}`;
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

const give = (person: Person, code: string) =>
  as(person, { method: "POST", url: "/setup/first-administrator", payload: { code } });

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`DELETE FROM first_administrator_codes`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await rawQuery(`DELETE FROM first_administrator_codes`);
  await app?.close();
});

describe("the first administrator's code", () => {
  let first: Person;
  let second: Person;
  let code: string;

  it("is printed at a start with no administrator, and only its hash is kept", async () => {
    first = await signIn("First");
    second = await signIn("Second");
    // Nobody is waited for until a code exists.
    expect((await as(first, { url: "/permissions/mine" })).json()).toMatchObject({
      member: false,
      awaiting_first_administrator: false,
    });

    const issued = await issueFirstAdministratorCode();
    expect(issued).not.toBeNull();
    code = issued!.code;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(firstAdministratorCodeLines(issued!).join("\n")).toContain(code);
    const rows = await rawQuery<{ code_hash: string }>(`SELECT code_hash FROM first_administrator_codes`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).not.toContain(code.replace(/-/g, ""));

    expect((await as(first, { url: "/permissions/mine" })).json()).toMatchObject({ awaiting_first_administrator: true });
  });

  it("refuses a wrong code and a request with no session", async () => {
    const wrong = await give(first, "AAAA-BBBB-CCCC");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: "WRONG_CODE" });
    const bare = await app.inject({ method: "POST", url: "/setup/first-administrator", payload: { code } });
    expect(bare.statusCode).toBe(401);
    expect(await rawQuery(`SELECT 1 FROM permission_grants`)).toEqual([]);
  });

  it("makes the first person to give it the first administrator, with every permission, however it is typed", async () => {
    const res = await give(first, ` ${code.toLowerCase().replace(/-/g, " ")} `);
    expect(res.statusCode, res.body).toBe(200);
    const mine = (await as(first, { url: "/permissions/mine" })).json();
    expect(mine).toMatchObject({ member: true, awaiting_first_administrator: false });
    for (const permission of PERMISSIONS.filter((p) => !["read", "read_sources", "consent"].includes(p))) {
      expect(mine.permissions, permission).toContain(permission);
    }
    const grants = await rawQuery<{ granted_via: string }>(`SELECT DISTINCT granted_via FROM permission_grants`);
    expect(grants).toEqual([{ granted_via: "first_administrator" }]);
    // The organization itself is a party from this moment.
    expect(await rawQuery(`SELECT 1 FROM parties WHERE is_own_organization`)).toHaveLength(1);
  });

  it("works once: the same code, or a new one, makes nobody an administrator after that", async () => {
    const again = await give(second, code);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "NOT_AWAITED" });
    expect(await issueFirstAdministratorCode()).toBeNull();
    expect((await as(second, { url: "/permissions/mine" })).json()).toMatchObject({
      member: false,
      awaiting_first_administrator: false,
    });
  });

  it("lets the administrator give the organization's own party its name, logged with the name it had", async () => {
    const parties = (await as(first, { url: "/parties" })).json().parties as Array<{ id: string; name: string; is_own_organization: boolean }>;
    const own = parties.find((p) => p.is_own_organization)!;
    expect(own.name).toBe("This organization");

    const renamed = await as(first, { method: "PATCH", url: `/parties/${own.id}`, payload: { name: "  Acme   Research " } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().party).toMatchObject({ id: own.id, name: "Acme Research", is_own_organization: true });

    const [entry] = await rawQuery<{ actor_id: string; detail: Record<string, string> }>(
      `SELECT actor_id, detail FROM administrative_events WHERE action = 'party_renamed'`
    );
    expect(entry).toMatchObject({ actor_id: first.id, detail: { party_id: own.id, previous_name: "This organization" } });

    expect((await as(second, { method: "PATCH", url: `/parties/${own.id}`, payload: { name: "Mine" } })).statusCode).toBe(403);
    expect((await as(first, { method: "PATCH", url: `/parties/${randomUUID()}`, payload: { name: "Nobody" } })).statusCode).toBe(404);

    const other = await as(first, { method: "POST", url: "/parties", payload: { name: "A Supplier" } });
    expect(other.statusCode, other.body).toBe(201);
    const taken = await as(first, { method: "PATCH", url: `/parties/${other.json().party.id}`, payload: { name: "Acme Research" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "NAME_TAKEN" });

    const log = await as(first, { url: "/permissions/log?type=parties" });
    expect(JSON.stringify(log.json())).toContain("This organization");
  });
});
