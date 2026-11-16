/**
 * A members-only deployment that creates its own owls (OWLS=created;
 * src/services/owl-creation-service.ts, src/routes/owls.ts), against the
 * real app and real tables: who may create owls and from where, what is
 * logged and what any member can read, that nothing sells owls or grants
 * them unasked, the two standing mandates set up through routes and able
 * to commission a run, and a holder of `fund` putting created owls behind
 * a mandate as on the public graph.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "created-owls-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-created-owls-administrator";

// Set before any module reads config.
vi.hoisted(() => {
  process.env.READS = "members";
  process.env.OWLS = "created";
  process.env.API_KEYS = "created-owls-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-created-owls-administrator";
  process.env.MODEL_PRICES = '[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';
  process.env.LOG_LEVEL = "fatal";
  delete process.env.SIGNUP_GRANT_OWLS;
  delete process.env.MONTHLY_GRANT_OWLS;
  delete process.env.STRIPE_SECRET_KEY;
});

import { rawQuery } from "../../src/db/client.js";
import { checkAgenticQuota } from "../../src/server/plugins/quota.js";
import {
  getGeneralMandate,
  resetAllocationPolicyCache,
} from "../../src/services/allocation-policy-service.js";
import { createApiKey } from "../../src/services/api-key-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { ASK_AN_ADMINISTRATOR_FOR_OWLS, CREATED_OWLS_STATEMENT } from "../../src/services/owl.js";
import { PLATFORM_EXTERNAL_ID } from "../../src/services/platform-account.js";
import { OWL, ledgerRows, owlBalance, seedClaim, seedGrantWithJob } from "./helpers.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
  name: string;
}

/** Sign a person in the way the web tier does: provision with the service key. */
async function signIn(name: string, externalId = `oidc:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId, name };
}

/** A request from the web tier acting for a signed-in person: session trust. */
function as(person: Person, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

async function grant(admin: Person, body: Record<string, unknown>) {
  const res = await as(admin, { method: "POST", url: "/permissions/grants", payload: body });
  expect(res.statusCode, res.body).toBe(201);
}

const create = (who: Person, payload: Record<string, unknown>) =>
  as(who, { method: "POST", url: "/owls/created", payload });

let admin: Person;
let member: Person;
let funder: Person;
let ownAccountNameBefore: string | null = null;
/** Metered cost this file seeds, removed again when it is done. */
const USAGE_REQUEST_ID = `dbtest-created-owls-${randomUUID()}`;

beforeAll(async () => {
  // Start from a deployment that has never had an administrator, and with
  // no standing mandate live: the scratch database is shared with every
  // other file, several of which leave platform mandates behind.
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`UPDATE sources SET party_id = NULL WHERE party_id IS NOT NULL`);
  await rawQuery(`DELETE FROM parties`);
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

  admin = await signIn("Ada Administrator", FIRST_ADMINISTRATOR);
  member = await signIn("Mel Member");
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ('internal', 'dbtest') ON CONFLICT DO NOTHING`
  );
  await grant(admin, { permission: "read", account_id: member.id, label: "internal" });
  funder = await signIn("Fay Funder");
  await grant(admin, { permission: "fund", account_id: funder.id });
});

afterAll(async () => {
  await app?.close();
  // Leave the shared tables as an open deployment has them.
  await rawQuery(`DELETE FROM llm_usage WHERE request_id = $1`, [USAGE_REQUEST_ID]);
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
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

describe("creating owls", () => {
  it("needs the permission to administer", async () => {
    const res = await create(member, { amount_owls: 10, account_id: member.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "administer" });
    // Holding `fund` is not holding `administer`.
    const byFunder = await create(funder, { amount_owls: 10, account_id: funder.id });
    expect(byFunder.statusCode).toBe(403);
    expect(await owlBalance(member.id)).toBe(0);
    expect(await owlBalance(funder.id)).toBe(0);
  });

  it("needs a signed-in session: an administrator's own API key cannot create owls", async () => {
    const key = await createApiKey({ userId: admin.id, name: "dbtest admin key" });
    const res = await app.inject({
      method: "POST",
      url: "/owls/created",
      headers: { "x-api-key": key.plaintext },
      payload: { amount_owls: 10, account_id: admin.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("SESSION_REQUIRED");
    expect(await owlBalance(admin.id)).toBe(0);
  });

  it("puts owls in an account's balance and logs the amount and the recipient", async () => {
    const res = await create(admin, { amount_owls: 120, account_id: funder.id, note: "Research team, November" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      created_owls: 120,
      account: { id: funder.id, display_name: "Fay Funder", balance_owls: 120 },
    });
    expect(await owlBalance(funder.id)).toBe(120 * OWL);
    const rows = await ledgerRows(funder.id);
    expect(rows.map((r) => r.reason)).toEqual(["owl_created"]);

    const [event] = await rawQuery<{ action: string; actor_id: string; detail: Record<string, string> }>(
      `SELECT action, actor_id, detail FROM administrative_events WHERE action = 'owls_created'`
    );
    expect(event).toEqual({
      action: "owls_created",
      actor_id: admin.id,
      detail: { amount_micro_usd: String(120 * OWL), account_id: funder.id, note: "Research team, November" },
    });
  });

  it("puts owls straight into a mandate's budget, held in the organization's own name", async () => {
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder.id, budgetMicroUsd: 0, jobStatus: "paused_budget" });
    const res = await create(admin, { amount_owls: 40.5, mandate_id: grantId });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ created_owls: 40.5, mandate: { id: grantId, budget_owls: 40.5 } });

    // The mandate's budget grew and a job that was waiting for one runs.
    const [job] = await rawQuery<{ budget: string; status: string }>(
      `SELECT budget_micro_usd::bigint AS budget, status FROM budget_jobs WHERE id = $1`,
      [jobId]
    );
    expect(job).toEqual({ budget: String(40.5 * OWL), status: "running" });

    // The two rows a contribution writes, in the deployment's own account,
    // which is named for the organization and never for Minerval.
    const [own] = await rawQuery<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM contributors WHERE external_id = $1`,
      [PLATFORM_EXTERNAL_ID]
    );
    expect(own!.display_name).toBe("This organization");
    const rows = await rawQuery<{ reason: string; amount: string; job_id: string | null }>(
      `SELECT reason, amount_micro_usd::bigint AS amount, job_id FROM owl_ledger
        WHERE user_id = $1 AND (job_id = $2 OR reason = 'owl_created')
        ORDER BY amount_micro_usd DESC`,
      [own!.id, jobId]
    );
    expect(rows).toEqual([
      { reason: "owl_created", amount: String(40.5 * OWL), job_id: null },
      { reason: "escrow_hold", amount: String(-40.5 * OWL), job_id: jobId },
    ]);
    const [event] = await rawQuery<{ detail: Record<string, string | null> }>(
      `SELECT detail FROM administrative_events WHERE action = 'owls_created' AND detail->>'grant_id' = $1`,
      [grantId]
    );
    expect(event!.detail).toEqual({ amount_micro_usd: String(40.5 * OWL), grant_id: grantId, note: null });
  });

  it("names the organization once the administrators have said who it is", async () => {
    const party = await as(admin, { method: "POST", url: "/parties", payload: { name: "Acme Research", is_own_organization: true } });
    expect(party.statusCode, party.body).toBe(201);
    const { grantId } = await seedGrantWithJob({ funderId: funder.id, budgetMicroUsd: 0, jobStatus: "paused_budget" });
    expect((await create(admin, { amount_owls: 1, mandate_id: grantId })).statusCode).toBe(201);
    const [own] = await rawQuery<{ display_name: string }>(
      `SELECT display_name FROM contributors WHERE external_id = $1`,
      [PLATFORM_EXTERNAL_ID]
    );
    expect(own!.display_name).toBe("Acme Research");
  });

  it("has no cap, and refuses what is not an act: no recipient, two, an unknown one, a closed mandate", async () => {
    const big = await create(admin, { amount_owls: 250_000, account_id: admin.id });
    expect(big.statusCode, big.body).toBe(201);
    expect(await owlBalance(admin.id)).toBe(250_000 * OWL);

    const neither = await create(admin, { amount_owls: 5 });
    expect(neither.statusCode).toBe(400);
    expect(neither.json()).toEqual({
      error:
        "Owls are created into one account's balance (account_id) or one mandate's budget " +
        "(mandate_id): name one of the two.",
      code: "ONE_RECIPIENT",
    });
    const { grantId } = await seedGrantWithJob({ funderId: funder.id, budgetMicroUsd: OWL });
    const both = await create(admin, { amount_owls: 5, account_id: member.id, mandate_id: grantId });
    expect(both.json().code).toBe("ONE_RECIPIENT");
    expect((await create(admin, { amount_owls: 0, account_id: member.id })).statusCode).toBe(400);
    expect((await create(admin, { amount_owls: -3, account_id: member.id })).statusCode).toBe(400);
    expect((await create(admin, { amount_owls: 5, account_id: randomUUID() })).statusCode).toBe(404);
    expect((await create(admin, { amount_owls: 5, mandate_id: randomUUID() })).statusCode).toBe(404);

    const closed = await seedGrantWithJob({ funderId: funder.id, budgetMicroUsd: OWL, grantStatus: "cancelled" });
    const intoClosed = await create(admin, { amount_owls: 5, mandate_id: closed.grantId });
    expect(intoClosed.statusCode).toBe(409);
    expect(intoClosed.json()).toEqual({
      error: "This mandate is cancelled and no longer taking money. No owls were created.",
      code: "MANDATE_NOT_OPEN",
    });
    // A job that stopped while its mandate still reads active takes nothing either.
    const stopped = await seedGrantWithJob({ funderId: funder.id, budgetMicroUsd: OWL, jobStatus: "completed" });
    const before = await rawQuery(`SELECT id FROM administrative_events`);
    expect((await create(admin, { amount_owls: 5, mandate_id: stopped.grantId })).statusCode).toBe(409);
    expect((await rawQuery(`SELECT id FROM administrative_events`)).length).toBe(before.length);
    expect(await owlBalance(member.id)).toBe(0);
  });
});

describe("what any member can read", () => {
  it("is how much has been created, by whom, and how much has been spent", async () => {
    // A second administrator, so "by whom" has two answers.
    const second = await signIn("Bo Administrator");
    await grant(admin, { permission: "administer", account_id: second.id });
    expect((await create(second, { amount_owls: 7, account_id: member.id })).statusCode).toBe(201);

    const [spentBefore] = await rawQuery<{ total: string }>(
      `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS total FROM llm_usage`
    );
    await rawQuery(
      `INSERT INTO llm_usage (agent, model, cost_micro_usd, request_id) VALUES ('steward', 'gpt-oss-120b', $1, $2)`,
      [2.25 * OWL, USAGE_REQUEST_ID]
    );

    const res = await as(member, { url: "/owls/created" });
    expect(res.statusCode, res.body).toBe(200);
    const summary = res.json();
    expect(summary.statement).toBe(CREATED_OWLS_STATEMENT);
    expect(summary.created).toEqual({
      total_owls: 120 + 40.5 + 1 + 250_000 + 7,
      into_accounts_owls: 120 + 250_000 + 7,
      into_mandates_owls: 41.5,
      by_administrator: [
        { administrator: "Ada Administrator", owls: 120 + 40.5 + 1 + 250_000, acts: 4 },
        { administrator: "Bo Administrator", owls: 7, acts: 1 },
      ],
    });
    // Owls that entered by a setting are listed apart, by the ledger's reason. This deployment
    // set none, so the figure is whatever the shared scratch ledger already held from other files.
    const grants = await rawQuery<{ reason: string; total: string }>(
      `SELECT reason, SUM(amount_micro_usd)::bigint AS total FROM owl_ledger
        WHERE reason IN ('signup_grant', 'monthly_grant') AND amount_micro_usd > 0 GROUP BY reason`
    );
    for (const row of grants) {
      expect(summary.entered_by_setting).toContainEqual({ reason: row.reason, owls: Number(row.total) / OWL });
    }
    expect(summary.entered_by_setting.some((e: { reason: string }) => e.reason === "owl_created")).toBe(false);
    expect(summary.spent.total_owls).toBeCloseTo((Number(spentBefore!.total) + 2.25 * OWL) / OWL, 3);
    expect(summary.recent[0]).toMatchObject({ by: "Bo Administrator", amount_owls: 7, account: "Mel Member" });
    expect(summary.recent.at(-1)).toMatchObject({
      by: "Ada Administrator",
      amount_owls: 120,
      account: "Fay Funder",
      note: "Research team, November",
    });
    expect(summary.prices.stated).toEqual([
      { model: "gpt-oss-120b", input_usd_per_mtok: 0.5, output_usd_per_mtok: 1.5 },
    ]);
    expect(summary.prices.unpriced_models).toEqual([]);
  });

  it("is in the log every member reads, with the amount and the recipient", async () => {
    const res = await as(member, { url: "/permissions/log?limit=500" });
    expect(res.statusCode).toBe(200);
    const created = (res.json().entries as Array<Record<string, unknown>>).filter((e) => e.event === "owls_created");
    expect(created).toHaveLength(5);
    expect(created.at(-1)).toMatchObject({
      event: "owls_created",
      by: "Ada Administrator",
      amount_owls: 120,
      account: "Fay Funder",
      note: "Research team, November",
    });
    expect(created.find((e) => e.amount_owls === 40.5)).toMatchObject({
      by: "Ada Administrator",
      mandate: { title: expect.stringMatching(/^DB-test mandate/) },
    });
  });

  it("is not served to someone who is not a member", async () => {
    const stranger = await signIn("Sam Stranger");
    expect((await as(stranger, { url: "/owls/created" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/owls/created" })).statusCode).toBe(401);
  });
});

describe("nothing sells owls here, and nothing grants them unasked", () => {
  it("mounts no Stripe route and offers no pack", async () => {
    expect((await as(member, { url: "/billing/packs" })).statusCode).toBe(404);
    expect((await as(admin, { method: "POST", url: "/billing/checkout", payload: { pack_id: "clutch" } })).statusCode).toBe(404);
    const webhook = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "stripe-signature": "t=1,v1=0", "x-api-key": SERVICE_KEY, "x-acting-user": admin.externalId },
      payload: {},
    });
    expect(webhook.statusCode).toBe(404);
    const routes = app.routeCatalog.map((r) => `${r.method} ${r.url}`);
    expect(routes.filter((r) => /\/billing\/(packs|checkout|webhook)/.test(r))).toEqual([]);
    // An account's own owl history is still served.
    expect((await as(funder, { url: "/billing/ledger" })).statusCode).toBe(200);
  });

  it("tells an account what its owls are, with no price to buy them at", async () => {
    const me = (await as(funder, { url: "/users/me" })).json();
    expect(me.packs).toEqual([]);
    expect(me.entitlement).toMatchObject({
      credits_enabled: false,
      owls_created_here: true,
      owls_statement: CREATED_OWLS_STATEMENT,
      signup_grant_owls: 0,
      monthly_grant_owls: 0,
      // One owl, one dollar of metered cost: there is no purchase price.
      owl_price_micro_usd: OWL,
      owl_cost_micro_usd: OWL,
    });
  });

  it("gives a new account no signup grant and no monthly owl", async () => {
    const newcomer = await signIn("Nia Newcomer");
    await grant(admin, { permission: "read", account_id: newcomer.id, label: "internal" });
    // The entitlement read is what would land the grants on the public graph.
    const me = await as(newcomer, { url: "/users/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json().entitlement.owl_balance).toBe(0);
    expect(await ledgerRows(newcomer.id)).toEqual([]);
  });

  it("says who to ask when a balance cannot cover something", async () => {
    const decision = await checkAgenticQuota(
      { userId: member.id, apiKeyId: null, method: "api_key" } as Parameters<typeof checkAgenticQuota>[0],
      "claim_proposal"
    );
    // Seven owls were created for this member above; drain them first.
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason) VALUES ($1, $2, 'charge')`,
      [member.id, -(await owlBalance(member.id))]
    );
    const refused = await checkAgenticQuota(
      { userId: member.id, apiKeyId: null, method: "api_key" } as Parameters<typeof checkAgenticQuota>[0],
      "claim_proposal"
    );
    expect(decision.allowed).toBe(true);
    expect(refused).toMatchObject({ allowed: false, code: "INSUFFICIENT_OWLS" });
    expect(refused.message).toContain(ASK_AN_ADMINISTRATOR_FOR_OWLS);
    expect(refused.message).not.toMatch(/buy|purchas|monthly/i);
    expect(refused.packs).toEqual([]);
  });
});

describe("a person who holds fund", () => {
  it("puts created owls behind a mandate exactly as on the public graph", async () => {
    const { grantId, jobId } = await seedGrantWithJob({ funderId: admin.id, budgetMicroUsd: OWL });
    const before = await owlBalance(funder.id);
    const res = await as(funder, { method: "POST", url: `/mandates/${grantId}/contribute`, payload: { owls: 20 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await owlBalance(funder.id)).toBe(before - 20 * OWL);
    const [job] = await rawQuery<{ budget: string }>(
      `SELECT budget_micro_usd::bigint AS budget FROM budget_jobs WHERE id = $1`,
      [jobId]
    );
    expect(Number(job!.budget)).toBe(21 * OWL);

    // A member who was given owls and does not hold `fund` cannot.
    expect((await create(admin, { amount_owls: 5, account_id: member.id })).statusCode).toBe(201);
    const refused = await as(member, { method: "POST", url: `/mandates/${grantId}/contribute`, payload: { owls: 5 } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "fund" });
  });
});

describe("the standing mandates", () => {
  it("is listed for any member before it exists: General, and no other since Governance was folded into it", async () => {
    const res = await as(member, { url: "/standing-mandates" });
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json().standing_mandates;
    expect(list.map((m: { name: string }) => m.name)).toEqual(["general"]);
    expect(list.map((m: { mandate: unknown }) => m.mandate)).toEqual([null]);
    expect(list[0].title).toBe("General maintenance");
    // The words say whose mandate it is: the deployment's, never Minerval's.
    expect(list[0].objective).toContain(
      "This is the deployment's own standing mandate: its budget is what the organization that runs it puts into the graph's upkeep"
    );
    expect(list[0].objective).toContain("consistency sweeps, curation, audits");
    expect(JSON.stringify(list)).not.toMatch(/Minerval|platform/);
  });

  it("are set up by an administrator from a session, and by nobody else", async () => {
    const byMember = await as(member, { method: "POST", url: "/standing-mandates/general", payload: { label: "public", budget_owls: 10 } });
    expect(byMember.statusCode).toBe(403);
    const key = await createApiKey({ userId: admin.id, name: "dbtest admin key 2" });
    const byKey = await app.inject({
      method: "POST",
      url: "/standing-mandates/general",
      headers: { "x-api-key": key.plaintext },
      payload: { label: "public", budget_owls: 10 },
    });
    expect(byKey.statusCode).toBe(403);
    expect(byKey.json().code).toBe("SESSION_REQUIRED");
    expect((await as(admin, { method: "POST", url: "/standing-mandates/mathematics", payload: {} })).statusCode).toBe(400);
  });

  it("General is created with its budget, its starting policy and its lookouts, and the act is logged", async () => {
    const res = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { label: "public", budget_owls: 300 } });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json().standing_mandate;
    expect(view).toMatchObject({
      name: "general",
      title: "General maintenance",
      mandate: { status: "active", budget_owls: 300, daily_owls: 30, running: true },
    });
    const grantId = view.mandate.id as string;

    const [row] = await rawQuery<{
      is_platform: boolean;
      policy: string;
      funder: string;
      funder_name: string;
      mandate: Record<string, unknown>;
      held: string;
    }>(
      `SELECT g.is_platform, g.policy, c.external_id AS funder, c.display_name AS funder_name, g.mandate,
              (SELECT -SUM(amount_micro_usd)::bigint FROM owl_ledger
                WHERE job_id = g.budget_job_id AND reason = 'escrow_hold') AS held
         FROM grants g JOIN contributors c ON c.id = g.funder_user_id WHERE g.id = $1`,
      [grantId]
    );
    expect(row).toMatchObject({
      is_platform: true,
      policy: "general",
      funder: PLATFORM_EXTERNAL_ID,
      funder_name: "Acme Research",
      held: String(300 * OWL),
    });
    expect(row!.mandate.seed_key).toBe("general-assessment");
    expect(row!.mandate.notes).toBe(
      "A standing mandate of this deployment, set up by its administrators. Its plan grows " +
        "as the Grantmaker surveys the scope; contributions extend how far it reaches."
    );
    expect((row!.mandate.operating_policy as { officer_limit_owls: number }).officer_limit_owls).toBe(5);
    const lookouts = await rawQuery<{ title: string }>(`SELECT title FROM lookouts WHERE grant_id = $1`, [grantId]);
    expect(lookouts.map((l) => l.title).sort()).toEqual(["Known problems", "Upkeep"]);

    // Its page shows the organization as its funder.
    const page = await as(member, { url: `/mandates/${grantId}` });
    expect(page.statusCode, page.body).toBe(200);
    expect(JSON.stringify(page.json())).not.toContain("Minerval");

    const log = (await as(member, { url: "/permissions/log?limit=500" })).json().entries as Array<Record<string, unknown>>;
    expect(log.find((e) => e.event === "standing_mandate_created")).toMatchObject({
      by: "Ada Administrator",
      amount_owls: 300,
      mandate: { id: grantId, title: "General maintenance" },
    });
    // The budget counts among the owls created.
    const summary = (await as(member, { url: "/owls/created" })).json();
    expect(summary.recent.find((r: { standing_mandate?: string }) => r.standing_mandate === "general")).toMatchObject({
      amount_owls: 300,
      by: "Ada Administrator",
    });
  });

  it("is set up once: a second request is refused and creates nothing", async () => {
    const before = await rawQuery(`SELECT id FROM grants WHERE is_platform = true AND status = 'active'`);
    const again = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { label: "public", budget_owls: 50 } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error:
        "The General maintenance mandate is already set up. Its budget is added to like any " +
        "mandate's, and its Grantmaker revises its policy from there.",
      code: "ALREADY_SET_UP",
    });
    expect((await rawQuery(`SELECT id FROM grants WHERE is_platform = true AND status = 'active'`)).length).toBe(before.length);
  });

  it("has no Governance to set up: audits are General's to pay for", async () => {
    const res = await as(admin, {
      method: "POST",
      url: "/standing-mandates/governance",
      payload: { label: "public", budget_owls: 60, daily_owls: 8 },
    });
    expect(res.statusCode, res.body).toBe(400);
    const list = (await as(member, { url: "/standing-mandates" })).json().standing_mandates;
    expect(list.map((m: { mandate: { status: string } | null }) => m.mandate?.status)).toEqual(["active"]);
  });

  it("is the mandate the allocation engine finds, and it can commission a run", async () => {
    const list = (await as(member, { url: "/standing-mandates" })).json().standing_mandates as Array<{
      name: string;
      mandate: { id: string };
    }>;
    const general = list.find((m) => m.name === "general")!.mandate.id;
    resetAllocationPolicyCache();
    expect((await getGeneralMandate())?.grantId).toBe(general);

    for (const [grantId, label] of [[general, "upkeep"]] as const) {
      const claim = await seedClaim(`standing ${label}`);
      const commissioned = await commissionNodePass({
        payer: { kind: "grant", grantId },
        claimId: claim,
        budgetMicroUsd: 2 * OWL,
        brief: "Look at this node again.",
        commissionedBy: "program_officer",
      });
      expect(commissioned, label).toMatchObject({ ok: true, status: "commissioned", budgetMicroUsd: 2 * OWL });
      const [held] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM action_allocations
          WHERE grant_id = $1 AND commissioned_by IS NOT NULL AND released_at IS NULL`,
        [grantId]
      );
      expect(held!.n, label).toBe(1);
    }
  });

  it("takes more budget like any mandate: created into it, or contributed from a balance", async () => {
    const list = (await as(member, { url: "/standing-mandates" })).json().standing_mandates as Array<{
      name: string;
      mandate: { id: string };
    }>;
    const general = list.find((m) => m.name === "general")!.mandate.id;
    expect((await create(admin, { amount_owls: 100, mandate_id: general })).statusCode).toBe(201);
    const contributed = await as(funder, { method: "POST", url: `/mandates/${general}/contribute`, payload: { owls: 10 } });
    expect(contributed.statusCode, contributed.body).toBe(200);
    const after = (await as(member, { url: "/standing-mandates" })).json().standing_mandates as Array<{
      name: string;
      mandate: { budget_owls: number };
    }>;
    expect(after.find((m) => m.name === "general")!.mandate.budget_owls).toBe(410);
  });

  it("can be set up again once the first has been closed, with a budget of its own", async () => {
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE policy = 'general' AND is_platform = true AND sensitivity_label = 'public'`);
    const res = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { label: "public", budget_owls: 25 } });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().standing_mandate.mandate.id as string;
    const [held] = await rawQuery<{ held: string }>(
      `SELECT -SUM(l.amount_micro_usd)::bigint AS held
         FROM owl_ledger l JOIN grants g ON g.budget_job_id = l.job_id
        WHERE g.id = $1 AND l.reason = 'escrow_hold'`,
      [id]
    );
    expect(held!.held).toBe(String(25 * OWL));
  });

  it("is one for each label, named by the administrator: a mandate's work runs at its label", async () => {
    // The deployment holds material at more than one label, so the request says which label the mandate is for.
    const unnamed = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { budget_owls: 5 } });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().code).toBe("LABEL_REQUIRED");

    // General is set up at `public` already. One at `internal` is a second mandate, for upkeep at that label.
    await grant(admin, { permission: "read", account_id: admin.id, label: "internal" }).catch(() => undefined);
    const res = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { budget_owls: 40, label: "internal" } });
    expect(res.statusCode, res.body).toBe(201);
    const general = res.json().standing_mandate as { by_label: Array<{ label: string; mandate: { id: string; budget_owls: number } | null }> };
    // One entry for each label the administrator reads (a shared scratch database may hold other files' labels too).
    const here = general.by_label.filter((l) => l.label === "internal" || l.label === "public");
    expect(here.map((l) => [l.label, l.mandate?.budget_owls ?? null])).toEqual([
      ["internal", 40],
      ["public", expect.any(Number)],
    ]);
    const internalId = here[0]!.mandate!.id;
    const [stamped] = await rawQuery<{ grant_label: string; job_label: string }>(
      `SELECT g.sensitivity_label AS grant_label, j.sensitivity_label AS job_label
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
      [internalId]
    );
    expect(stamped).toEqual({ grant_label: "internal", job_label: "internal" });
    // Once at each label.
    const again = await as(admin, { method: "POST", url: "/standing-mandates/general", payload: { budget_owls: 1, label: "internal" } });
    expect(again.statusCode).toBe(409);

    // A member is shown the labels they read, and no other: the funder reads `public` alone.
    const forFunder = (await as(funder, { url: "/standing-mandates" })).json().standing_mandates as Array<{ name: string; by_label: Array<{ label: string }> }>;
    expect(forFunder.find((m) => m.name === "general")!.by_label.map((l) => l.label)).toEqual(["public"]);
    expect(JSON.stringify(forFunder)).not.toContain(internalId);
    const forMember = (await as(member, { url: "/standing-mandates" })).json().standing_mandates as Array<{ name: string; by_label: Array<{ label: string; mandate: { id: string } | null }> }>;
    expect(forMember.find((m) => m.name === "general")!.by_label.find((l) => l.label === "internal")!.mandate!.id).toBe(internalId);

    // Owls created into it are named in the log to a reader of its label, and by id alone to one who is not.
    const created = await as(admin, { method: "POST", url: "/owls/created", payload: { amount_owls: 3, mandate_id: internalId, note: "more upkeep" } });
    expect(created.statusCode, created.body).toBe(201);
    const seenBy = async (person: Person) =>
      ((await as(person, { url: "/owls/created" })).json().recent as Array<{ mandate?: { id: string; title: string; withheld?: true } }>).find(
        (act) => act.mandate?.id === internalId
      )!.mandate;
    expect(await seenBy(member)).toEqual({ id: internalId, title: "General maintenance" });
    expect(await seenBy(funder)).toEqual({ id: internalId, title: "", withheld: true });
  });
});
