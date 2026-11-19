/**
 * Credentials made to act as an organization (docs/organizations.md, "Other
 * credentials"), against real Postgres and the real app: a key or an MCP
 * client's consent is made for one identity; one made for an organization
 * acts as its person acting as it, under their permissions there at each
 * request; only someone who may act for the organization can make one; its
 * refreshed tokens act for it still; admins see and revoke them; and leaving
 * the organization revokes what the person made for it.
 */
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const SERVICE_KEY = "organization-credentials-web-tier-key";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "organization-credentials-web-tier-key";
  process.env.LOG_LEVEL = "fatal";
});

import { rawQuery } from "../../src/db/client.js";
import {
  approveAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
} from "../../src/services/oauth-service.js";

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

function withKey(key: string, request: { method?: string; url: string }) {
  return app.inject({ method: (request.method ?? "GET") as "GET", url: request.url, headers: { "x-api-key": key } });
}

/** An organization, its admin, and a member holding `permissions`. */
async function organization(permissions: string[]) {
  const dana = await signIn("dana");
  const priya = await signIn("priya");
  const made = await as(dana, { method: "POST", url: "/organizations", payload: { name: "Acme Corp" } });
  const org = made.json().organization.id as string;
  const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
  expect((await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` })).statusCode).toBe(200);
  for (const permission of permissions) {
    const given = await as(dana, { method: "POST", url: `/organizations/${org}/grants`, payload: { permission, account_id: priya.id } });
    expect(given.statusCode, given.body).toBe(201);
  }
  return { dana, priya, org };
}

async function keyFor(person: Person, org: string | null) {
  const res = await as(person, { method: "POST", url: "/api-keys", payload: { name: "agent", ...(org ? { acting_for: org } : {}) } });
  return res;
}

describe("an API key made to act as an organization", () => {
  it("acts as the organization, under its person's permissions there at each request", async () => {
    const { org, priya } = await organization(["speak"]);
    const made = await keyFor(priya, org);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().acting_for).toBe(org);
    const key = made.json().key as string;

    const me = await withKey(key, { url: "/users/me" });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user).toMatchObject({ id: org, kind: "organization" });

    // spend is not hers: refused, naming it, before the route runs.
    const approve = await withKey(key, { method: "POST", url: `/grants/${randomUUID()}/approve` });
    expect(approve.statusCode).toBe(403);
    expect(approve.json()).toMatchObject({ code: "PERMISSION_NOT_HELD", permission: "spend" });

    // A person's own routes are never the organization's.
    const keys = await withKey(key, { url: "/api-keys" });
    expect(keys.json().code).toBe("NOT_AN_ORGANIZATION_ACT");
  });

  it("is made only by someone who may act for the organization", async () => {
    const { org } = await organization([]);
    const stranger = await signIn("stranger");
    const refused = await keyFor(stranger, org);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("CANNOT_ACT_AS");
  });

  it("stops when its person holds nothing there, and is revoked when they leave", async () => {
    const { dana, org, priya } = await organization(["speak"]);
    const key = (await keyFor(priya, org)).json().key as string;
    const grants = (await as(dana, { url: `/organizations/${org}/grants` })).json().grants as Array<{ id: string; account_id: string | null }>;
    await as(dana, { method: "DELETE", url: `/organizations/${org}/grants/${grants.find((g) => g.account_id === priya.id)!.id}` });
    const left = await withKey(key, { url: "/users/me" });
    expect(left.statusCode).toBe(403);
    expect(left.json().code).toBe("CREDENTIAL_ORGANIZATION_LEFT");

    expect((await as(priya, { method: "DELETE", url: `/organizations/${org}/members/${priya.id}` })).statusCode).toBe(200);
    expect((await withKey(key, { url: "/users/me" })).statusCode).toBe(401);
    // Added again, she starts with no credential for it.
    const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
    await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` });
    expect((await withKey(key, { url: "/users/me" })).statusCode).toBe(401);
  });

  it("is listed for the organization's members and revoked by an admin", async () => {
    const { dana, org, priya } = await organization(["speak"]);
    const key = (await keyFor(priya, org)).json().key as string;
    const own = await keyFor(priya, null);
    expect(own.json().acting_for).toBeNull();

    const listed = await as(priya, { url: `/organizations/${org}/credentials` });
    expect(listed.json().credentials).toEqual([
      expect.objectContaining({ kind: "api_key", name: "agent", account_id: priya.id }),
    ]);
    const id = listed.json().credentials[0].id as string;
    const revoked = await as(dana, { method: "DELETE", url: `/organizations/${org}/credentials/api_key/${id}` });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().credentials).toEqual([]);
    expect((await withKey(key, { url: "/users/me" })).statusCode).toBe(401);
    // Her own key is hers, untouched.
    expect((await withKey(own.json().key, { url: "/users/me" })).json().user.id).toBe(priya.id);
  });
});

describe("an MCP client approved to act as an organization", () => {
  it("acts for it on every token, refreshed ones included", async () => {
    const { org, priya } = await organization(["speak"]);
    const redirectUri = "https://client.example/callback";
    const { client } = await registerClient({ name: "Desk agent", redirectUris: [redirectUri], tokenEndpointAuthMethod: "none" });
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    const request = await createAuthorizationRequest({
      client,
      redirectUri,
      scope: "mcp",
      state: null,
      codeChallenge: challenge,
      resource: null,
    });
    const consent = await approveAuthorizationRequest({ requestId: request.id, userId: priya.id, actingFor: org });
    const code = new URL(consent!.redirectTo).searchParams.get("code")!;
    const first = await exchangeAuthorizationCode({ code, client, redirectUri, codeVerifier: verifier });
    const refreshed = await refreshAccessToken({ refreshToken: first.refreshToken, client });

    const rows = await rawQuery<{ acting_for: string | null }>(`SELECT DISTINCT acting_for FROM oauth_tokens WHERE client_id = $1`, [client.id]);
    expect(rows).toEqual([{ acting_for: org }]);
    const listed = await as(priya, { url: `/organizations/${org}/credentials` });
    expect(listed.json().credentials).toEqual([expect.objectContaining({ kind: "mcp_client", name: "Desk agent", account_id: priya.id })]);
    // The token is for /mcp, where it acts as the organization.
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${refreshed.accessToken}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.body).toContain("submit_contribution");
    expect(mcp.body).not.toContain("\"fund_mandate\"");
  });

  it("is approved only for an organization the person may act for", async () => {
    const { org } = await organization([]);
    const stranger = await signIn("stranger");
    const redirectUri = "https://client.example/callback";
    const { client } = await registerClient({ name: "Agent", redirectUris: [redirectUri], tokenEndpointAuthMethod: "none" });
    const request = await createAuthorizationRequest({
      client,
      redirectUri,
      scope: "mcp",
      state: null,
      codeChallenge: crypto.createHash("sha256").update("x".repeat(48)).digest("base64url"),
      resource: null,
    });
    const res = await as(stranger, { method: "POST", url: `/oauth/requests/${request.id}/approve`, payload: { acting_for: org } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("CANNOT_ACT_AS");
  });
});
