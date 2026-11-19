/**
 * Allowances on spend (docs/organizations.md, "What an organization grants":
 * money, not counts), against real Postgres and the real app: what a member
 * spends of the organization's owls counts against the allowance an admin
 * set on their grant; a spend that would pass it is refused with the figures
 * and nothing moves; an admin raises it; an admin spends from the whole
 * balance; and the member is told what is left.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const SERVICE_KEY = "organization-allowance-web-tier-key";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "organization-allowance-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { creditOwls, owlBalance, seedClaim, OWL } from "./helpers.js";
import { chargeMetered } from "../../src/services/owl-ledger-service.js";
import { runAsSpender } from "../../src/services/organization-spending.js";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

interface Person {
  id: string;
  externalId: string;
}

async function signIn(name: string): Promise<Person> {
  const externalId = `github:${name}-${randomUUID()}`;
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name, email: `${name}-${randomUUID()}@example.org` },
  });
  return { id: res.json().user.id, externalId };
}

function as(person: Person, request: { method?: string; url: string; payload?: unknown; organization?: string }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: {
      "x-api-key": SERVICE_KEY,
      "x-acting-user": person.externalId,
      ...(request.organization ? { "x-acting-organization": request.organization } : {}),
    },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

async function setup() {
  const dana = await signIn("dana");
  const priya = await signIn("priya");
  const org = (await as(dana, { method: "POST", url: "/organizations", payload: { name: "Acme Corp" } })).json().organization.id as string;
  const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
  await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` });
  const given = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", account_id: priya.id } });
  const grant = (given.json().grants as Array<{ id: string; account_id: string | null }>).find((g) => g.account_id === priya.id)!.id;
  await creditOwls(org, 10 * OWL);
  // A claim of its own for each payment: one already paid for is refused as covered.
  const fund = async (person: Person, owls: number) =>
    as(person, { method: "POST", url: `/claims/${await seedClaim("allowance")}/contribute`, payload: { owls }, organization: org });
  return { dana, priya, org, grant, fund };
}

describe("an allowance on spend", () => {
  it("counts what the member spends of the organization's owls, and refuses what would pass it", async () => {
    const { dana, priya, org, grant, fund } = await setup();
    const set = await as(dana, { method: "PUT", url: `/organizations/${org}/grants/${grant}/allowance`, payload: { allowance_owls: 2 } });
    expect(set.statusCode, set.body).toBe(200);

    const first = await fund(priya, 1.5);
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(await owlBalance(org)).toBe(8.5 * OWL);
    const [row] = await rawQuery<{ spent: string }>(`SELECT allowance_spent_micro_usd AS spent FROM organization_grants WHERE id = $1`, [grant]);
    expect(Number(row!.spent)).toBe(1.5 * OWL);

    const over = await fund(priya, 1);
    expect(over.statusCode, over.body).toBe(402);
    expect(over.json()).toMatchObject({ code: "ALLOWANCE_EXCEEDED", allowance_micro_usd: 2 * OWL, allowance_spent_micro_usd: 1.5 * OWL });
    expect(over.json().error).toMatch(/leaves 0\.5 owls of 2 owls/);
    // Nothing moved.
    expect(await owlBalance(org)).toBe(8.5 * OWL);

    const mine = await as(priya, { url: `/organizations/${org}` });
    expect(mine.json().organization.allowance_left_micro_usd).toBe(0.5 * OWL);
  });

  it("is raised by an admin, and binds only the member it is on", async () => {
    const { dana, priya, org, grant, fund } = await setup();
    await as(dana, { method: "PUT", url: `/organizations/${org}/grants/${grant}/allowance`, payload: { allowance_owls: 1 } });
    expect((await fund(priya, 1)).statusCode).toBeLessThan(300);
    expect((await fund(priya, 1)).statusCode).toBe(402);

    await as(dana, { method: "PUT", url: `/organizations/${org}/grants/${grant}/allowance`, payload: { allowance_owls: 3 } });
    expect((await fund(priya, 1)).statusCode).toBeLessThan(300);

    // An admin holds no grant to count against: the whole balance.
    expect((await fund(dana, 4)).statusCode).toBeLessThan(300);
    expect(await owlBalance(org)).toBe(4 * OWL);
    const kinds = (await rawQuery<{ kind: string }>(`SELECT kind FROM organization_log WHERE organization_id = $1`, [org])).map((r) => r.kind);
    expect(kinds).toContain("allowance_set");
  });

  it("is set by admins only, on spend only", async () => {
    const { dana, priya, org, grant } = await setup();
    const byMember = await as(priya, { method: "PUT", url: `/organizations/${org}/grants/${grant}/allowance`, payload: { allowance_owls: 100 } });
    expect(byMember.json().code).toBe("ADMIN_REQUIRED");
    const speak = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "speak", account_id: priya.id } });
    const speakGrant = (speak.json().grants as Array<{ id: string; permission: string }>).find((g) => g.permission === "speak")!.id;
    const onSpeak = await as(dana, { method: "PUT", url: `/organizations/${org}/grants/${speakGrant}/allowance`, payload: { allowance_owls: 1 } });
    expect(onSpeak.statusCode).toBe(404);
  });

  it("bounds a metered charge, which takes what is left and no more, as the balance does", async () => {
    const { dana, org, grant } = await setup();
    await as(dana, { method: "PUT", url: `/organizations/${org}/grants/${grant}/allowance`, payload: { allowance_owls: 1 } });
    const charged = await runAsSpender({ organizationId: org, grantId: grant }, () =>
      chargeMetered({ userId: org, microUsd: 3 * OWL, op: "assistant" })
    );
    expect(charged.chargedMicroUsd).toBe(OWL);
    expect(await owlBalance(org)).toBe(9 * OWL);
    const after = await runAsSpender({ organizationId: org, grantId: grant }, () =>
      chargeMetered({ userId: org, microUsd: OWL, op: "assistant" })
    );
    expect(after.chargedMicroUsd).toBe(0);
  });
});
