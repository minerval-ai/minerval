/**
 * minerval.ai as an OpenID Connect provider for organizations
 * (docs/organizations.md, "Signing in"; services/oidc-provider.ts), against
 * the real app and tables, as a deployment's sign-in uses it: discovery and
 * keys; an admin registering a client; a member signing in through it, with
 * PKCE, and the ID token naming them, the organization and their role as a
 * group; a person who is not a member refused; the code used once; a wrong
 * secret refused; and a revoked client stopping.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";

const SERVICE_KEY = "oidc-web-tier-key";

vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "oidc-web-tier-key";
  process.env.PUBLIC_API_BASE_URL = "https://api.test";
  process.env.PUBLIC_WEB_BASE_URL = "https://web.test";
  process.env.LOG_LEVEL = "fatal";
});

let app: FastifyInstance;

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

function as(person: Person, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

const REDIRECT = "https://research.acme.example/api/auth/callback/oidc";

async function setup() {
  const dana = await signIn("dana");
  const priya = await signIn("priya");
  const omar = await signIn("omar");
  const org = (await as(dana, { method: "POST", url: "/organizations", payload: { name: "Acme Corp" } })).json().organization.id as string;
  const invite = await as(dana, { method: "POST", url: `/organizations/${org}/invitations`, payload: { role: "member" } });
  await as(priya, { method: "POST", url: `/organization-invitations/${invite.json().token}/accept` });
  const made = await as(dana, { method: "POST", url: `/organizations/${org}/oidc-clients`, payload: { name: "Research", redirect_uris: [REDIRECT] } });
  expect(made.statusCode, made.body).toBe(201);
  return { dana, priya, omar, org, client: made.json().client as { id: string; client_id: string; client_secret: string; issuer: string } };
}

/** The deployment's half: begin, and the request id the consent page is given. */
async function begin(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile email",
    state: "s-1",
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  return app.inject({ method: "GET", url: `/oidc/authorize?${q}` });
}

function token(client: { client_id: string; client_secret: string }, body: Record<string, string>, secret = client.client_secret) {
  return app.inject({
    method: "POST",
    url: "/oidc/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString("base64")}`,
    },
    payload: new URLSearchParams(body).toString(),
  });
}

function decode(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(c!, "base64url").toString()) };
}

beforeAll(async () => {
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("minerval.ai as an OpenID Connect provider", () => {
  it("says where its endpoints and keys are", async () => {
    const d = (await app.inject({ method: "GET", url: "/oidc/.well-known/openid-configuration" })).json();
    expect(d).toMatchObject({
      issuer: "https://api.test/oidc",
      authorization_endpoint: "https://api.test/oidc/authorize",
      token_endpoint: "https://api.test/oidc/token",
      jwks_uri: "https://api.test/oidc/jwks",
      id_token_signing_alg_values_supported: ["RS256"],
    });
    const keys = (await app.inject({ method: "GET", url: "/oidc/jwks" })).json().keys;
    expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
  });

  it("signs a member in, telling the deployment who they are, the organization and their role, once", async () => {
    const { priya, org, client } = await setup();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const started = await begin(client.client_id, challenge);
    expect(started.statusCode).toBe(302);
    const consent = new URL(started.headers.location as string);
    expect(consent.origin + consent.pathname).toBe("https://web.test/oidc/consent");
    const requestId = consent.searchParams.get("request_id")!;

    const shown = (await as(priya, { url: `/oidc/requests/${requestId}` })).json();
    expect(shown).toMatchObject({ client: { name: "Research" }, organization: { id: org, name: "Acme Corp" }, your_role: "member", state: "waiting" });

    const approved = await as(priya, { method: "POST", url: `/oidc/requests/${requestId}/approve` });
    expect(approved.statusCode, approved.body).toBe(200);
    const back = new URL(approved.json().redirect_to);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s-1");
    const code = back.searchParams.get("code")!;

    const badVerifier = await token(client, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "wrong" });
    expect(badVerifier.json().error).toBe("invalid_grant");

    // The first exchange used the code: start again for a good one.
    const again = new URL((await begin(client.client_id, challenge)).headers.location as string).searchParams.get("request_id")!;
    const code2 = new URL((await as(priya, { method: "POST", url: `/oidc/requests/${again}/approve` })).json().redirect_to).searchParams.get("code")!;
    const exchanged = await token(client, { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const tokens = exchanged.json();
    const { header, claims } = decode(tokens.id_token);
    expect(header).toMatchObject({ alg: "RS256" });
    expect(claims).toMatchObject({
      iss: "https://api.test/oidc",
      aud: client.client_id,
      sub: priya.id,
      nonce: "n-1",
      organization: org,
      organization_name: "Acme Corp",
      groups: ["member"],
      name: "priya",
      email_verified: true,
    });
    // Its signature verifies under the published key.
    const jwk = (await app.inject({ method: "GET", url: "/oidc/jwks" })).json().keys[0];
    const [h, c, s] = (tokens.id_token as string).split(".");
    expect(cryptoVerify("sha256", Buffer.from(`${h}.${c}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s!, "base64url"))).toBe(true);

    const replay = await token(client, { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(replay.json().error).toBe("invalid_grant");

    const info = await app.inject({ method: "GET", url: "/oidc/userinfo", headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(info.json()).toMatchObject({ sub: priya.id, organization: org, groups: ["member"] });
  });

  it("signs in only the organization's members, and only for a client with its secret, while it is not revoked", async () => {
    const { dana, omar, org, client } = await setup();
    const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
    const requestId = new URL((await begin(client.client_id, challenge)).headers.location as string).searchParams.get("request_id")!;
    expect((await as(omar, { url: `/oidc/requests/${requestId}` })).json().your_role).toBeNull();
    const stranger = await as(omar, { method: "POST", url: `/oidc/requests/${requestId}/approve` });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error).toMatch(/Only members of Acme Corp/);

    const code = new URL((await as(dana, { method: "POST", url: `/oidc/requests/${requestId}/approve` })).json().redirect_to).searchParams.get("code")!;
    const wrong = await token(client, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "v".repeat(43) }, "mvs_wrong");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_client");
    const ok = await token(client, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "v".repeat(43) });
    expect(decode(ok.json().id_token).claims.groups).toEqual(["admin"]);

    // An address that is not registered is refused, and not redirected to.
    const elsewhere = await begin(client.client_id, challenge, { redirect_uri: "https://evil.example/cb" });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.headers.location).toBeUndefined();

    await as(dana, { method: "DELETE", url: `/organizations/${org}/oidc-clients/${client.id}` });
    expect((await begin(client.client_id, challenge)).statusCode).toBe(400);
    const listed = (await as(dana, { url: `/organizations/${org}/oidc-clients` })).json().clients;
    expect(listed[0].revoked_at).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(client.client_secret);
  });

  it("is registered by admins only, sending people back over https", async () => {
    const { priya, dana, org } = await setup();
    expect((await as(priya, { method: "POST", url: `/organizations/${org}/oidc-clients`, payload: { name: "X", redirect_uris: [REDIRECT] } })).json().code).toBe(
      "ADMIN_REQUIRED"
    );
    const plain = await as(dana, { method: "POST", url: `/organizations/${org}/oidc-clients`, payload: { name: "X", redirect_uris: ["http://research.acme.example/cb"] } });
    expect(plain.json().code).toBe("BAD_REDIRECT");
  });
});
