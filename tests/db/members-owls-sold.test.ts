/**
 * A members-only deployment whose owls are sold, not created (READS=members
 * with OWLS unset): the routes for created owls are absent, a signup grant
 * is given only because this deployment sets one, and a standing mandate
 * is set up without a budget and funded from a balance like any mandate.
 * The deployment that creates its own is in tests/db/created-owls.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "owls-sold-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-owls-sold-administrator";

vi.hoisted(() => {
  process.env.READS = "members";
  delete process.env.OWLS;
  process.env.API_KEYS = "owls-sold-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-owls-sold-administrator";
  // This deployment's administrators set a signup grant, and no monthly owl.
  process.env.SIGNUP_GRANT_OWLS = "3";
  delete process.env.MONTHLY_GRANT_OWLS;
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { PLATFORM_EXTERNAL_ID } from "../../src/services/platform-account.js";
import { OWL, creditOwls, ledgerRows, owlBalance } from "./helpers.js";

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

let admin: Person;
let ownAccountNameBefore: string | null = null;

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  const [own] = await rawQuery<{ display_name: string }>(
    `SELECT display_name FROM contributors WHERE external_id = $1`,
    [PLATFORM_EXTERNAL_ID]
  );
  ownAccountNameBefore = own?.display_name ?? null;
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("sold-admin", FIRST_ADMINISTRATOR);
});

afterAll(async () => {
  await app?.close();
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  // The organization's own party, made when this file's first administrator signed in.
  await rawQuery(`DELETE FROM parties`);
  await rawQuery(
    `UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  if (ownAccountNameBefore !== null) {
    await rawQuery(`UPDATE contributors SET display_name = $2 WHERE external_id = $1`, [
      PLATFORM_EXTERNAL_ID,
      ownAccountNameBefore,
    ]);
  }
});

describe("a members-only deployment that sells its owls", () => {
  it("has no route for creating them", async () => {
    expect((await as(admin, { url: "/owls/created" })).statusCode).toBe(404);
    const created = await as(admin, { method: "POST", url: "/owls/created", payload: { amount_owls: 5, account_id: admin.id } });
    expect(created.statusCode).toBe(404);
    expect(await owlBalance(admin.id)).toBe(0);
    // The routes that sell owls are mounted, as on the public graph.
    expect((await as(admin, { url: "/billing/packs" })).statusCode).toBe(200);
  });

  it("gives a new account the signup grant its administrators set, and no monthly owl", async () => {
    const newcomer = await signIn("sold-newcomer");
    await as(admin, {
      method: "POST",
      url: "/permissions/grants",
      payload: { permission: "fund", account_id: newcomer.id },
    });
    const me = (await as(newcomer, { url: "/users/me" })).json();
    expect(me.entitlement).toMatchObject({ owl_balance: 3, signup_grant_owls: 3, monthly_grant_owls: 0 });
    expect(me.entitlement.owls_created_here).toBeUndefined();
    expect((await ledgerRows(newcomer.id)).map((r) => r.reason)).toEqual(["signup_grant"]);
  });

  it("sets a standing mandate up without a budget, and funds it from a balance", async () => {
    const withBudget = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { label: "public", budget_owls: 100 } });
    expect(withBudget.statusCode).toBe(400);
    expect(withBudget.json()).toEqual({
      error:
        "This deployment sells its owls, so a mandate's budget comes from an account's " +
        "balance. Set the mandate up without a budget, then fund it as any mandate is funded " +
        "(POST /mandates/:id/contribute).",
      code: "BUDGET_FROM_A_BALANCE",
    });

    const createdOwlRows = async () =>
      (await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM owl_ledger WHERE reason = 'owl_created'`))[0]!.n;
    const createdBefore = await createdOwlRows();
    const res = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { label: "public" } });
    expect(res.statusCode, res.body).toBe(201);
    const mandate = res.json().standing_mandate.mandate as { id: string; budget_owls: number; running: boolean };
    expect(mandate).toMatchObject({ budget_owls: 0, running: false, daily_owls: 30 });
    // The mandate is the organization's own, and its page does not name Minerval as its funder.
    const page = await as(admin, { url: `/mandates/${mandate.id}` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().mandate?.funder?.shown_as ?? page.json().funder?.shown_as).toBe("This organization");
    expect(JSON.stringify(page.json())).not.toContain("Minerval");
    // Nothing entered the ledger: no owl was created here.
    expect(await createdOwlRows()).toBe(createdBefore);

    // The first administrator holds `fund`; owls they bought fund it.
    await creditOwls(admin.id, 50 * OWL);
    const contributed = await as(admin, { method: "POST", url: `/mandates/${mandate.id}/contribute`, payload: { owls: 40 } });
    expect(contributed.statusCode, contributed.body).toBe(200);
    const after = (await as(admin, { url: "/standing-mandates" })).json().standing_mandates as Array<{
      name: string;
      mandate: { budget_owls: number; running: boolean } | null;
    }>;
    expect(after.find((m) => m.name === "general")!.mandate).toMatchObject({ budget_owls: 40, running: true });
    expect(after.find((m) => m.name === "governance")!.mandate).toBeNull();
  });
});
