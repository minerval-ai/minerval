/**
 * A verified domain (docs/organizations.md, "A verified domain"), against
 * the real app and tables, with DNS answered by the test: an admin adds a
 * domain and is shown the TXT record; a check that finds it confirms it,
 * and it is shown beside the organization's name; a failing check marks it
 * unconfirmed for seven days, then it is not shown; and one organization
 * holds a domain at a time.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = "domains-web-tier-key";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "domains-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import { checkDueDomains, normalizeDomain, setTxtResolver } from "../../src/services/organization-domains.js";

let app: FastifyInstance;
/** What DNS answers, by record name. */
const dns = new Map<string, string[][]>();

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
    payload: { external_id: externalId, display_name: name },
  });
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

async function organization(admin: Person, name = "Acme Corp"): Promise<string> {
  return (await as(admin, { method: "POST", url: "/organizations", payload: { name } })).json().organization.id;
}

beforeAll(async () => {
  setTxtResolver(async (name) => {
    const found = dns.get(name);
    if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found;
  });
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterEach(() => dns.clear());

afterAll(async () => {
  setTxtResolver(null);
  await app?.close();
});

describe("a domain", () => {
  it("is read as written by a person, and refused where it is not one", () => {
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
    expect(normalizeDomain("research.acme.co.uk.")).toBe("research.acme.co.uk");
    expect(normalizeDomain("192.168.0.1")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("bad_name.com")).toBeNull();
  });

  it("is confirmed by its TXT record, shown beside the name, and shown as unconfirmed for seven days after it goes", async () => {
    const dana = await signIn("dana");
    const priya = await signIn("priya");
    const org = await organization(dana);
    const domain = `acme-${randomUUID().slice(0, 8)}.com`;

    expect((await as(priya, { method: "POST", url: `/organizations/${org}/domains`, payload: { domain } })).statusCode).toBe(403);
    const added = await as(dana, { method: "POST", url: `/organizations/${org}/domains`, payload: { domain: `https://${domain}/` } });
    expect(added.statusCode, added.body).toBe(201);
    const d = added.json().domain;
    expect(d).toMatchObject({ domain, state: "waiting", record: { name: `_minerval.${domain}`, type: "TXT" } });
    expect(d.record.value).toMatch(/^minerval-organization=/);

    // Not there yet.
    const missing = await as(dana, { method: "POST", url: `/organizations/${org}/domains/${d.id}/check` });
    expect(missing.json().domain).toMatchObject({ state: "waiting", last_error: `No TXT record at _minerval.${domain}.` });

    dns.set(`_minerval.${domain}`, [["v=spf1 -all"], [d.record.value.slice(0, 10), d.record.value.slice(10)]]);
    const found = await as(dana, { method: "POST", url: `/organizations/${org}/domains/${d.id}/check` });
    expect(found.json().domain.state).toBe("confirmed");
    expect((await app.inject({ method: "GET", url: `/contributors/${org}` })).json().contributor.domain).toMatchObject({ domain, unconfirmed_since: null });
    expect((await as(dana, { url: `/organizations/${org}` })).json().organization.domain).toMatchObject({ domain });

    // The record goes: the daily check marks it unconfirmed, and it is still shown.
    dns.clear();
    await rawQuery(`UPDATE organization_domains SET last_checked_at = now() - interval '25 hours' WHERE id = $1`, [d.id]);
    expect(await checkDueDomains()).toBeGreaterThanOrEqual(1);
    const shown = (await app.inject({ method: "GET", url: `/contributors/${org}` })).json().contributor.domain;
    expect(shown.domain).toBe(domain);
    expect(shown.unconfirmed_since).not.toBeNull();

    // Seven days of failures: it is no longer shown, and the record of when it was verified stays.
    await rawQuery(`UPDATE organization_domains SET failing_since = now() - interval '8 days' WHERE id = $1`, [d.id]);
    expect((await app.inject({ method: "GET", url: `/contributors/${org}` })).json().contributor.domain).toBeNull();
    const listed = (await as(priya, { url: `/organizations/${org}/domains` })).statusCode;
    // Not a member: the organization is not found, as for its other reads.
    expect(listed).toBe(404);
    const [kept] = await rawQuery<{ verified_at: Date | null }>(`SELECT verified_at FROM organization_domains WHERE id = $1`, [d.id]);
    expect(kept!.verified_at).not.toBeNull();
    const kinds = (await rawQuery<{ kind: string }>(`SELECT kind FROM organization_log WHERE organization_id = $1`, [org])).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["domain_added", "domain_confirmed", "domain_unconfirmed"]));
  });

  it("is held by one organization at a time", async () => {
    const dana = await signIn("dana");
    const omar = await signIn("omar");
    const first = await organization(dana, "Acme Corp");
    const second = await organization(omar, "Acme Impostors");
    const domain = `shared-${randomUUID().slice(0, 8)}.org`;
    const a = (await as(dana, { method: "POST", url: `/organizations/${first}/domains`, payload: { domain } })).json().domain;
    const b = (await as(omar, { method: "POST", url: `/organizations/${second}/domains`, payload: { domain } })).json().domain;
    dns.set(`_minerval.${domain}`, [[a.record.value], [b.record.value]]);
    expect((await as(dana, { method: "POST", url: `/organizations/${first}/domains/${a.id}/check` })).json().domain.state).toBe("confirmed");
    const refused = (await as(omar, { method: "POST", url: `/organizations/${second}/domains/${b.id}/check` })).json().domain;
    expect(refused.state).toBe("waiting");
    expect(refused.last_error).toMatch(/shown for another organization, Acme Corp/);
  });
});
