/**
 * Organizations on minerval.ai (docs/organizations.md; src/services/
 * organization-service.ts, src/routes/organizations.ts), against the real
 * app and tables: making one, who may see it, invitations, the rule that an
 * organization always has an admin (concurrent changes included), an admin
 * acting for it from a session and nowhere else, a shared login converted
 * in place, the old keys it keeps, and the operator's way back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "organizations-web-tier-key";
const OPERATOR_KEY = "organizations-operator-key";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "organizations-web-tier-key";
  process.env.MINERVAL_OPERATOR_KEY = "organizations-operator-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { createApiKey } from "../../src/services/api-key-service.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
}

async function signIn(name: string, externalId = `github:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name, email: `${name}-${randomUUID()}@example.org` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId };
}

function as(
  person: Person,
  request: { method?: string; url: string; payload?: unknown; organization?: string }
) {
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

async function makeOrganization(admin: Person, name = "Acme Corp"): Promise<string> {
  const res = await as(admin, { method: "POST", url: "/organizations", payload: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().organization.id as string;
}

async function invite(admin: Person, org: string, role: "admin" | "member"): Promise<string> {
  const res = await as(admin, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

async function join(person: Person, token: string) {
  return as(person, { method: "POST", url: `/organization-invitations/${token}/accept` });
}

async function logKinds(org: string): Promise<string[]> {
  const rows = await rawQuery<{ kind: string }>(
    `SELECT kind FROM organization_log WHERE organization_id = $1 ORDER BY created_at, id`,
    [org]
  );
  return rows.map((r) => r.kind);
}

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("making an organization", () => {
  it("is an account of its own kind, which nobody signs in as, with its maker as first admin", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const [row] = await rawQuery<{ kind: string; external_id: string; display_name: string }>(
      `SELECT kind, external_id, display_name FROM contributors WHERE id = $1`,
      [org]
    );
    expect(row).toEqual({ kind: "organization", external_id: `org:${org}`, display_name: "Acme Corp" });

    const members = await as(dana, { url: `/organizations/${org}/members` });
    expect(members.json().members.map((m: { account_id: string; role: string }) => [m.account_id, m.role])).toEqual([[dana.id, "admin"]]);
    expect(await logKinds(org)).toEqual(["created"]);

    // No sign-in makes its identity, and the web tier cannot act as it.
    const provision = await app.inject({
      method: "POST",
      url: "/users/provision",
      headers: { "x-api-key": SERVICE_KEY },
      payload: { external_id: `org:${org}`, display_name: "Imposter" },
    });
    expect(provision.statusCode).toBe(422);
    expect(provision.json().code).toBe("NOT_A_SIGN_IN_IDENTITY");
    const actingAs = await app.inject({
      method: "GET",
      url: "/users/me",
      headers: { "x-api-key": SERVICE_KEY, "x-acting-user": `org:${org}` },
    });
    expect(actingAs.statusCode).toBe(403);
    expect(actingAs.json().code).toBe("ORGANIZATION_NOT_ACTABLE");
  });

  it("is shown to its members and is not there for anyone else", async () => {
    const dana = await signIn("dana");
    const stranger = await signIn("stranger");
    const org = await makeOrganization(dana);
    expect((await as(dana, { url: `/organizations/${org}` })).json().organization.role).toBe("admin");
    for (const url of [`/organizations/${org}`, `/organizations/${org}/members`, `/organizations/${org}/log`]) {
      const res = await as(stranger, { url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code).toBe("ORGANIZATION_NOT_FOUND");
    }
    const mine = await as(stranger, { url: "/organizations" });
    expect(mine.json().organizations).toEqual([]);
  });

  it("takes a change only from a session, not from a person's own key", async () => {
    const dana = await signIn("dana");
    const key = await createApiKey({ userId: dana.id, name: "mine" });
    const res = await app.inject({
      method: "POST",
      url: "/organizations",
      headers: { "x-api-key": key.plaintext },
      payload: { name: "Keyed" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("SESSION_REQUIRED");
  });
});

describe("invitations", () => {
  it("add the person who accepts, once, with the role the link names", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const lee = await signIn("lee");
    const org = await makeOrganization(dana);
    const token = await invite(dana, org, "member");

    const read = await as(priya, { url: `/organization-invitations/${token}` });
    expect(read.json().invitation).toMatchObject({ organization: { id: org, name: "Acme Corp" }, role: "member", state: "open" });

    expect((await join(priya, token)).statusCode).toBe(200);
    const again = await join(lee, token);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("INVITATION_USED");

    const roles = (await as(dana, { url: `/organizations/${org}/members` })).json().members.map((m: { account_id: string; role: string }) => [m.account_id, m.role]);
    expect(roles).toContainEqual([priya.id, "member"]);
    expect(roles).not.toContainEqual([lee.id, expect.anything()]);
    expect(await logKinds(org)).toEqual(["created", "invited", "joined"]);
  });

  it("are made and cancelled by admins only, and a cancelled or expired one adds nobody", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const lee = await signIn("lee");
    const org = await makeOrganization(dana);
    expect((await join(priya, await invite(dana, org, "member"))).statusCode).toBe(200);

    const byMember = await as(priya, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "admin" } });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().code).toBe("ADMIN_REQUIRED");

    const made = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
    const { token, invitation } = made.json();
    expect((await as(dana, { method: "DELETE", url: `/organizations/${org}/invitations/${invitation.id}` })).statusCode).toBe(200);
    expect((await join(lee, token)).json().code).toBe("INVITATION_CANCELLED");

    const stale = await invite(dana, org, "member");
    await rawQuery(`UPDATE organization_invitations SET expires_at = now() - interval '1 minute' WHERE organization_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL`, [org]);
    expect((await join(lee, stale)).json().code).toBe("INVITATION_EXPIRED");
  });
});

describe("an organization always has an admin", () => {
  it("refuses to demote, remove or let leave the last admin", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    expect((await join(priya, await invite(dana, org, "member"))).statusCode).toBe(200);

    for (const res of [
      await as(dana, { method: "PUT", url: `/organizations/${org}/members/${dana.id}`, payload: { role: "member" } }),
      await as(dana, { method: "DELETE", url: `/organizations/${org}/members/${dana.id}` }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("LAST_ADMIN");
    }
    // A member may leave; a member may not remove anyone else.
    const lee = await signIn("lee");
    expect((await join(lee, await invite(dana, org, "member"))).statusCode).toBe(200);
    expect((await as(priya, { method: "DELETE", url: `/organizations/${org}/members/${lee.id}` })).json().code).toBe("ADMIN_REQUIRED");
    expect((await as(priya, { method: "DELETE", url: `/organizations/${org}/members/${priya.id}` })).statusCode).toBe(200);
    // Once there is a second admin, the first may step down.
    expect((await as(dana, { method: "PUT", url: `/organizations/${org}/members/${lee.id}`, payload: { role: "admin" } })).statusCode).toBe(200);
    expect((await as(dana, { method: "PUT", url: `/organizations/${org}/members/${dana.id}`, payload: { role: "member" } })).statusCode).toBe(200);
    // A removal keeps the row.
    const [kept] = await rawQuery<{ removed_by: string }>(
      `SELECT removed_by FROM organization_members WHERE organization_id = $1 AND account_id = $2`,
      [org, priya.id]
    );
    expect(kept!.removed_by).toBe(priya.id);
  });

  it("holds when two admins remove each other at once", async () => {
    const dana = await signIn("dana");
    const lee = await signIn("lee");
    const org = await makeOrganization(dana);
    expect((await join(lee, await invite(dana, org, "admin"))).statusCode).toBe(200);
    const [a, b] = await Promise.all([
      as(dana, { method: "DELETE", url: `/organizations/${org}/members/${lee.id}` }),
      as(lee, { method: "DELETE", url: `/organizations/${org}/members/${dana.id}` }),
    ]);
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 404]);
    const [n] = await rawQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM organization_members WHERE organization_id = $1 AND role = 'admin' AND removed_at IS NULL`,
      [org]
    );
    expect(n!.n).toBe("1");
  });

  it("comes back through the operator key when every admin is gone", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    await rawQuery(`DELETE FROM contributors WHERE id = $1`, [dana.id]);

    const without = await app.inject({ method: "POST", url: `/operator/organizations/${org}/admins`, payload: { account_id: priya.id } });
    expect(without.statusCode).toBe(403);
    const res = await app.inject({
      method: "POST",
      url: `/operator/organizations/${org}/admins`,
      headers: { "x-operator-key": OPERATOR_KEY },
      payload: { account_id: priya.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await as(priya, { url: `/organizations/${org}` })).json().organization.role).toBe("admin");
    const [entry] = await rawQuery<{ credential: string; actor_id: string | null }>(
      `SELECT credential, actor_id FROM organization_log WHERE organization_id = $1 AND kind = 'admin_added_by_operator'`,
      [org]
    );
    expect(entry).toEqual({ credential: "operator", actor_id: null });
  });
});

describe("acting for an organization from minerval.ai", () => {
  it("is the organization's request, for a live admin in a session, and is logged under the admin", async () => {
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    const me = await as(dana, { url: "/users/me", organization: org });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user).toMatchObject({ id: org, kind: "organization", display_name: "Acme Corp" });

    const act = await as(dana, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, payload: { owls: 1 }, organization: org });
    expect(act.statusCode).not.toBe(403);
    // The act is logged once the response has gone, so it may land a moment after inject returns.
    let entry: { actor_id: string; detail: { route: string; status: number } } | undefined;
    for (let i = 0; i < 50 && !entry; i++) {
      [entry] = await rawQuery<{ actor_id: string; detail: { route: string; status: number } }>(
        `SELECT actor_id, detail FROM organization_log WHERE organization_id = $1 AND kind = 'acted'`,
        [org]
      );
      if (!entry) await new Promise((r) => setTimeout(r, 20));
    }
    expect(entry).toMatchObject({ actor_id: dana.id, detail: { route: "/mandates/:id/contribute", status: act.statusCode } });
  });

  it("is refused to someone who is not a member, on a person's own route, and without a session", async () => {
    const dana = await signIn("dana");
    const stranger = await signIn("stranger");
    const org = await makeOrganization(dana);

    const outsider = await as(stranger, { url: "/users/me", organization: org });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().code).toBe("NOT_A_MEMBER");

    const mint = await as(dana, { method: "POST", url: "/api-keys", payload: { name: "org key" }, organization: org });
    expect(mint.statusCode).toBe(403);
    expect(mint.json().code).toBe("NOT_AN_ORGANIZATION_ACT");

    // A deployment's own work, which no person does as the organization, even an admin.
    const retire = await as(dana, { method: "POST", url: "/deployments/me/retire", organization: org });
    expect(retire.statusCode).toBe(403);
    expect(retire.json().code).toBe("NOT_AN_ORGANIZATION_ACT");

    const key = await createApiKey({ userId: dana.id, name: "dana's key" });
    const keyed = await app.inject({
      method: "GET",
      url: "/users/me",
      headers: { "x-api-key": key.plaintext, "x-acting-organization": org },
    });
    expect(keyed.statusCode).toBe(403);
    expect(keyed.json().code).toBe("ORGANIZATION_SESSION_REQUIRED");
  });
});

describe("what a member may do as the organization", () => {
  async function withMember() {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await makeOrganization(dana);
    expect((await join(priya, await invite(dana, org, "member"))).statusCode).toBe(200);
    return { dana, priya, org };
  }

  it("reads as the organization, and acts only under the permissions granted, each separately", async () => {
    const { dana, priya, org } = await withMember();
    const me = await as(priya, { url: "/users/me", organization: org });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user).toMatchObject({ id: org, kind: "organization" });

    const before = await as(priya, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, payload: { owls: 1 }, organization: org });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toMatchObject({ code: "PERMISSION_NOT_HELD", permission: "spend" });
    expect(before.json().error).toMatch(/needs spend.*Members tab/);

    const grant = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "speak", account_id: priya.id } });
    expect(grant.statusCode, grant.body).toBe(201);
    const stillNot = await as(priya, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, payload: { owls: 1 }, organization: org });
    expect(stillNot.json()).toMatchObject({ code: "PERMISSION_NOT_HELD", permission: "spend" });

    const spend = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", account_id: priya.id } });
    expect(spend.statusCode, spend.body).toBe(201);
    const after = await as(priya, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, payload: { owls: 1 }, organization: org });
    expect(after.statusCode).not.toBe(403);

    const members = await as(priya, { url: `/organizations/${org}/members` });
    const row = members.json().members.find((m: { account_id: string }) => m.account_id === priya.id);
    expect(row.permissions).toEqual(["speak", "spend"]);
    const mine = await as(priya, { url: `/organizations/${org}` });
    expect(mine.json().organization.permissions).toEqual(["speak", "spend"]);
  });

  it("is granted and withdrawn by admins only, and withdrawing takes effect at once", async () => {
    const { dana, priya, org } = await withMember();
    const byMember = await as(priya, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", account_id: priya.id } });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().code).toBe("ADMIN_REQUIRED");

    const given = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", account_id: priya.id } });
    const grantId = given.json().grants.find((g: { account_id: string }) => g.account_id === priya.id).id as string;
    const gone = await as(dana, { method: "DELETE", url: `/organizations/${org}/grants/${grantId}` });
    expect(gone.statusCode, gone.body).toBe(200);
    const refused = await as(priya, { method: "POST", url: `/mandates/${randomUUID()}/contribute`, payload: { owls: 1 }, organization: org });
    expect(refused.json().code).toBe("PERMISSION_NOT_HELD");
    expect(await logKinds(org)).toEqual(expect.arrayContaining(["granted", "withdrew"]));
  });

  it("gives a member only a member's permissions, and an admin nothing, since they hold all", async () => {
    const { dana, priya, org } = await withMember();
    const publish = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "publish", account_id: priya.id } });
    expect(publish.statusCode).toBe(422);
    expect(publish.json().code).toBe("BAD_PERMISSION");
    const toAdmin = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "spend", account_id: dana.id } });
    expect(toAdmin.json().code).toBe("ADMIN_HOLDS_ALL");
  });

  it("are withdrawn when the member leaves, so one added again starts with none", async () => {
    const { dana, priya, org } = await withMember();
    await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission: "speak", account_id: priya.id } });
    expect((await as(priya, { method: "DELETE", url: `/organizations/${org}/members/${priya.id}` })).statusCode).toBe(200);
    expect((await join(priya, await invite(dana, org, "member"))).statusCode).toBe(200);
    const mine = await as(priya, { url: `/organizations/${org}` });
    expect(mine.json().organization.permissions).toEqual([]);
  });
});

describe("converting a shared account", () => {
  it("keeps the account's id and keys, and the shared login no longer reaches it", async () => {
    const shared = await signIn("acme-research");
    const dana = await signIn("dana");
    const key = await createApiKey({ userId: shared.id, name: "deploy" });

    const ask = await as(shared, { method: "POST", url: "/account-conversion", payload: { name: "Acme Corp", first_admin_id: dana.id } });
    expect(ask.statusCode, ask.body).toBe(201);
    expect(ask.json().conversion.keeps.live_api_keys).toBe(1);
    // Nothing has changed yet.
    expect((await as(shared, { url: "/users/me" })).json().user.kind).toBe("person");

    const forDana = await as(dana, { url: "/account-conversions/for-me" });
    const [conversion] = forDana.json().conversions;
    // Only the person it names can accept.
    const stranger = await signIn("stranger");
    expect((await as(stranger, { method: "POST", url: `/account-conversions/${conversion.id}/accept` })).statusCode).toBe(404);
    const accept = await as(dana, { method: "POST", url: `/account-conversions/${conversion.id}/accept` });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().organization).toMatchObject({ id: shared.id, name: "Acme Corp", role: "admin" });

    const [row] = await rawQuery<{ kind: string; external_id: string; email: string | null }>(
      `SELECT kind, external_id, email FROM contributors WHERE id = $1`,
      [shared.id]
    );
    expect(row).toEqual({ kind: "organization", external_id: `org:${shared.id}`, email: null });

    // The old key still works, and is listed for the admins to revoke.
    const withKey = await app.inject({ method: "GET", url: "/users/me", headers: { "x-api-key": key.plaintext } });
    expect(withKey.json().user.id).toBe(shared.id);
    const old = await as(dana, { url: `/organizations/${shared.id}/old-keys` });
    expect(old.json().keys.map((k: { id: string }) => k.id)).toEqual([key.key.id]);
    expect((await as(dana, { method: "DELETE", url: `/organizations/${shared.id}/old-keys/${key.key.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/users/me", headers: { "x-api-key": key.plaintext } })).statusCode).toBe(401);

    // Signing in with the shared login again makes a new, empty person account.
    const again = await signIn("acme-research", shared.externalId);
    expect(again.id).not.toBe(shared.id);
    expect(await logKinds(shared.id)).toEqual(["converted", "old_key_revoked"]);
  });

  it("refuses a first admin who is not another person's own account", async () => {
    const shared = await signIn("shared");
    const dana = await signIn("dana");
    const org = await makeOrganization(dana);
    for (const first of [shared.id, org]) {
      const res = await as(shared, { method: "POST", url: "/account-conversion", payload: { name: "X", first_admin_id: first } });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});
