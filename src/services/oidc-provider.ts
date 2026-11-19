/**
 * minerval.ai as an OpenID Connect provider for organizations
 * (docs/organizations.md, "Hosted by Minerval", "Signing in").
 *
 * Many organizations that want a private deployment have no identity
 * provider of their own. An admin of the organization registers a client
 * for its deployment here; the deployment sets AUTH_OIDC_ISSUER to this
 * provider's issuer with that client's id and secret, and its members sign
 * in with their minerval.ai accounts. The deployment needs no code for it:
 * it already speaks OpenID Connect (web/auth.ts).
 *
 * Only live members of the organization the client was registered for can
 * sign in. The ID token carries the organization's id and a `groups` claim
 * with the person's role there (`admin` or `member`). A role here grants
 * nothing inside the deployment: its administrators grant permissions there
 * as always, and can grant them to the `admin` or `member` group.
 *
 * The authorization-code flow (RFC 6749 with OpenID Connect Core), PKCE
 * where the client sends it (S256 only). ID and access tokens are RS256
 * JWTs signed with OIDC_SIGNING_KEY, both short-lived; nothing is refreshed:
 * a deployment signs a person in again when its own session ends.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { OrganizationError, isLiveAdmin, requireMember } from "./organization-service.js";

/** How long a person has to approve, how long the code lasts, and how long the tokens do. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const TOKEN_TTL_SECONDS = 10 * 60;
export const OIDC_SCOPES = ["openid", "profile", "email"] as const;

export class OidcError extends Error {
  constructor(
    /** An OAuth error code: invalid_request, invalid_client, invalid_grant, unauthorized_client, access_denied, server_error. */
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const isUuid = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// ---- the signing key ----------------------------------------------------------------

let signing: { pem: string; key: KeyObject; kid: string; jwk: Record<string, unknown> } | null = null;

/** The key ID and access tokens are signed with, or a refusal where the provider is not set up. */
function signingKey(): { key: KeyObject; kid: string; jwk: Record<string, unknown> } {
  const config = loadConfig();
  const pem = config.oidcSigningKey;
  if (signing && (signing.pem === pem || (!pem && signing.pem === ""))) return signing;
  let key: KeyObject;
  if (pem) {
    key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new OidcError("server_error", "OIDC_SIGNING_KEY is not an RSA private key.", 503);
  } else if (config.env !== "production") {
    // Outside production, a key for the life of the process: tokens from before a restart stop verifying, which is fine there.
    key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  } else {
    throw new OidcError(
      "server_error",
      "minerval.ai is not set up as an OpenID Connect provider here: the operator sets OIDC_SIGNING_KEY.",
      503
    );
  }
  const jwk = createPublicKey(key).export({ format: "jwk" }) as Record<string, unknown>;
  const kid = sha256(`${jwk.n}.${jwk.e}`).slice(0, 16);
  signing = { pem: pem ?? "", key, kid, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
  return signing;
}

function signJwt(claims: Record<string, unknown>): string {
  const { key, kid } = signingKey();
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(sig)}`;
}

/** The claims of a JWT this provider signed, where its signature, issuer and time hold, or null. */
function verifyJwt(token: string, audience: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const { key } = signingKey();
  const ok = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(key), Buffer.from(parts[2]!, "base64url"));
  if (!ok) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims.iss !== issuer() || claims.aud !== audience) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

// ---- discovery ------------------------------------------------------------------------

/** The issuer a deployment names in AUTH_OIDC_ISSUER. */
export function issuer(): string {
  return `${loadConfig().publicApiBaseUrl.replace(/\/+$/, "")}/oidc`;
}

export function discovery(): Record<string, unknown> {
  const iss = issuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...OIDC_SCOPES],
    claims_supported: ["sub", "name", "email", "email_verified", "organization", "organization_name", "groups", "nonce"],
  };
}

export function jwks(): { keys: Array<Record<string, unknown>> } {
  return { keys: [signingKey().jwk] };
}

// ---- clients, for an organization's admins ---------------------------------------------

export interface OidcClientView {
  id: string;
  client_id: string;
  name: string;
  redirect_uris: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ClientRow {
  id: string;
  organization_id: string;
  client_id: string;
  client_secret_hash: string;
  name: string;
  redirect_uris: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const clientView = (r: ClientRow): OidcClientView => ({
  id: r.id,
  client_id: r.client_id,
  name: r.name,
  redirect_uris: r.redirect_uris,
  created_at: r.created_at.toISOString(),
  last_used_at: r.last_used_at?.toISOString() ?? null,
  revoked_at: r.revoked_at?.toISOString() ?? null,
});

function readRedirects(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string" || !v.trim()) continue;
    let url: URL;
    try {
      url = new URL(v.trim());
    } catch {
      throw new OrganizationError("BAD_REDIRECT", `${v} is not an address.`, 422);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new OrganizationError("BAD_REDIRECT", `${v}: a deployment is sent people back to over https.`, 422);
    }
    if (url.hash || url.username || url.password) throw new OrganizationError("BAD_REDIRECT", `${v} carries a fragment or a password.`, 422);
    out.push(url.toString());
  }
  if (out.length === 0) {
    throw new OrganizationError(
      "BAD_REDIRECT",
      "Give where the deployment receives people back: its address followed by /api/auth/callback/oidc, for instance https://research.acme.com/api/auth/callback/oidc.",
      422
    );
  }
  return [...new Set(out)];
}

async function requireAdmin(organizationId: string, by: string): Promise<void> {
  if (!isUuid(organizationId) || !(await isLiveAdmin(organizationId, by))) {
    throw new OrganizationError("ADMIN_REQUIRED", "Only an admin of the organization registers its sign-in clients.", 403);
  }
}

export async function listOidcClients(organizationId: string, by: string): Promise<OidcClientView[]> {
  await requireMember(organizationId, by);
  const rows = await rawQuery<ClientRow>(`SELECT * FROM organization_oidc_clients WHERE organization_id = $1 ORDER BY created_at DESC`, [organizationId]);
  return rows.map(clientView);
}

/** An admin registers a client; its secret is answered once. */
export async function makeOidcClient(input: { organizationId: string; name: unknown; redirectUris: unknown; by: string }): Promise<OidcClientView & { client_secret: string; issuer: string }> {
  await requireAdmin(input.organizationId, input.by);
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  if (!name) throw new OrganizationError("NAME_REQUIRED", "Name the deployment this client is for.", 422);
  const redirects = readRedirects(input.redirectUris);
  const clientId = `mvo_${randomBytes(12).toString("base64url")}`;
  const secret = `mvs_${randomBytes(32).toString("base64url")}`;
  const [row] = await rawQuery<ClientRow>(
    `INSERT INTO organization_oidc_clients (organization_id, client_id, client_secret_hash, name, redirect_uris, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.organizationId, clientId, sha256(secret), name, redirects, input.by]
  );
  await rawQuery(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail) VALUES ($1, $2, 'session', 'oidc_client_made', $3::jsonb)`,
    [input.organizationId, input.by, JSON.stringify({ client_id: clientId, name, redirect_uris: redirects })]
  );
  return { ...clientView(row!), client_secret: secret, issuer: issuer() };
}

export async function revokeOidcClient(input: { organizationId: string; id: string; by: string }): Promise<void> {
  await requireAdmin(input.organizationId, input.by);
  if (!isUuid(input.id)) throw new OrganizationError("CLIENT_NOT_FOUND", "The organization has no such client.", 404);
  const rows = await rawQuery<{ client_id: string; name: string }>(
    `UPDATE organization_oidc_clients SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND organization_id = $2 RETURNING client_id, name`,
    [input.id, input.organizationId]
  );
  if (rows.length === 0) throw new OrganizationError("CLIENT_NOT_FOUND", "The organization has no such client.", 404);
  await rawQuery(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail) VALUES ($1, $2, 'session', 'oidc_client_revoked', $3::jsonb)`,
    [input.organizationId, input.by, JSON.stringify(rows[0])]
  );
}

// ---- signing in -----------------------------------------------------------------------

async function liveClient(clientId: unknown): Promise<ClientRow | null> {
  if (typeof clientId !== "string" || !clientId) return null;
  const [row] = await rawQuery<ClientRow>(`SELECT * FROM organization_oidc_clients WHERE client_id = $1 AND revoked_at IS NULL`, [clientId]);
  return row ?? null;
}

/**
 * Begin a sign-in: check the client and where to send the person back, and
 * keep the request. Nothing here redirects to the client on an error, so
 * this host is not an open redirector.
 */
export async function beginAuthorization(q: Record<string, string | undefined>): Promise<{ request_id: string }> {
  signingKey();
  const client = await liveClient(q.client_id);
  if (!client) throw new OidcError("invalid_request", "Unknown or revoked client_id.");
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    throw new OidcError("invalid_request", "redirect_uri is not registered for this client. An admin of the organization adds it on its Members tab.");
  }
  if (q.response_type !== "code") throw new OidcError("unsupported_response_type", "Only response_type=code is supported.");
  const scopes = (q.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes("openid")) throw new OidcError("invalid_scope", "The scope must include openid.");
  const unknown = scopes.find((s) => !(OIDC_SCOPES as readonly string[]).includes(s));
  if (unknown) throw new OidcError("invalid_scope", `Unknown scope: ${unknown}.`);
  if (q.code_challenge && (q.code_challenge_method ?? "plain") !== "S256") throw new OidcError("invalid_request", "code_challenge_method must be S256.");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO oidc_authorization_requests (client_id, redirect_uri, scope, state, nonce, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval) RETURNING id`,
    [client.id, q.redirect_uri, scopes.join(" "), q.state ?? null, q.nonce ?? null, q.code_challenge ?? null, String(REQUEST_TTL_MS)]
  );
  return { request_id: row!.id };
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  code_challenge: string | null;
  expires_at: Date;
  account_id: string | null;
  approved_at: Date | null;
  code_expires_at: Date | null;
  used_at: Date | null;
  denied_at: Date | null;
  organization_id: string;
  organization_name: string;
  client_name: string;
}

async function openRequest(id: string): Promise<RequestRow> {
  if (!isUuid(id)) throw new OidcError("invalid_request", "No such sign-in request.", 404);
  const [row] = await rawQuery<RequestRow>(
    `SELECT r.*, k.organization_id, k.name AS client_name, c.display_name AS organization_name
       FROM oidc_authorization_requests r JOIN organization_oidc_clients k ON k.id = r.client_id AND k.revoked_at IS NULL
       JOIN contributors c ON c.id = k.organization_id
      WHERE r.id = $1`,
    [id]
  );
  if (!row) throw new OidcError("invalid_request", "No such sign-in request.", 404);
  return row;
}

async function roleIn(organizationId: string, accountId: string): Promise<"admin" | "member" | null> {
  const [m] = await rawQuery<{ role: "admin" | "member" }>(
    `SELECT m.role FROM organization_members m JOIN contributors a ON a.id = m.account_id
      WHERE m.organization_id = $1 AND m.account_id = $2 AND m.removed_at IS NULL AND NOT a.is_suspended`,
    [organizationId, accountId]
  );
  return m?.role ?? null;
}

/** What the person signing in is shown: which deployment asks, for which organization, and whether they may. */
export async function readAuthorization(id: string, accountId: string): Promise<Record<string, unknown>> {
  const r = await openRequest(id);
  const role = await roleIn(r.organization_id, accountId);
  return {
    request_id: r.id,
    client: { name: r.client_name, redirect_origin: new URL(r.redirect_uri).origin },
    organization: { id: r.organization_id, name: r.organization_name },
    scopes: r.scope.split(" "),
    your_role: role,
    state: r.denied_at ? "denied" : r.approved_at ? "approved" : r.expires_at.getTime() <= Date.now() ? "expired" : "waiting",
  };
}

const backTo = (r: RequestRow, params: Record<string, string>) => {
  const url = new URL(r.redirect_uri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (r.state) url.searchParams.set("state", r.state);
  url.searchParams.set("iss", issuer());
  return url.toString();
};

/** The person approves: only a live member of the client's organization can. Answers where to send them back, with a code. */
export async function approveAuthorization(id: string, accountId: string): Promise<{ redirect_to: string }> {
  const r = await openRequest(id);
  if (r.denied_at || r.approved_at) throw new OidcError("invalid_request", "This sign-in has been answered already. Start again from the deployment.", 409);
  if (r.expires_at.getTime() <= Date.now()) throw new OidcError("invalid_request", "This sign-in has expired. Start again from the deployment.", 409);
  if (!(await roleIn(r.organization_id, accountId))) {
    throw new OidcError(
      "access_denied",
      `Only members of ${r.organization_name} sign in to its deployment here. An admin of ${r.organization_name} invites you on its Members tab.`,
      403
    );
  }
  const code = randomBytes(32).toString("base64url");
  const rows = await rawQuery<{ id: string }>(
    `UPDATE oidc_authorization_requests SET account_id = $2, approved_at = now(), code_hash = $3,
       code_expires_at = now() + ($4 || ' milliseconds')::interval
     WHERE id = $1 AND approved_at IS NULL AND denied_at IS NULL RETURNING id`,
    [r.id, accountId, sha256(code), String(CODE_TTL_MS)]
  );
  if (rows.length === 0) throw new OidcError("invalid_request", "This sign-in has been answered already.", 409);
  return { redirect_to: backTo(r, { code }) };
}

export async function denyAuthorization(id: string): Promise<{ redirect_to: string }> {
  const r = await openRequest(id);
  await rawQuery(`UPDATE oidc_authorization_requests SET denied_at = now() WHERE id = $1 AND approved_at IS NULL AND denied_at IS NULL`, [r.id]);
  return { redirect_to: backTo(r, { error: "access_denied" }) };
}

function secretMatches(given: string, hash: string): boolean {
  const a = Buffer.from(sha256(given), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The client's credentials from the token request: HTTP Basic, or in the body. */
export function clientCredentials(authorization: string | undefined, body: Record<string, unknown>): { id: string; secret: string } | null {
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i > 0) return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  }
  if (typeof body.client_id === "string" && typeof body.client_secret === "string") return { id: body.client_id, secret: body.client_secret };
  return null;
}

/** Exchange a code for an ID token and an access token. The person must still be a live member then. */
export async function exchangeCode(input: {
  credentials: { id: string; secret: string } | null;
  grantType: unknown;
  code: unknown;
  redirectUri: unknown;
  codeVerifier: unknown;
}): Promise<Record<string, unknown>> {
  // RFC 6749 §5.2: 401 where the client presented credentials that failed, 400 where it presented none.
  if (!input.credentials) throw new OidcError("invalid_client", "The client's id and secret are required (HTTP Basic, or in the body).", 400);
  const client = await liveClient(input.credentials.id);
  if (!client || !secretMatches(input.credentials.secret, client.client_secret_hash)) {
    throw new OidcError("invalid_client", "The client is unknown, revoked, or its secret is wrong.", 401);
  }
  if (input.grantType !== "authorization_code") throw new OidcError("unsupported_grant_type", "Only grant_type=authorization_code is supported.");
  if (typeof input.code !== "string" || !input.code) throw new OidcError("invalid_request", "code is required.");
  const [r] = await rawQuery<RequestRow & { code_hash: string }>(
    `UPDATE oidc_authorization_requests r SET used_at = now()
      WHERE r.code_hash = $1 AND r.client_id = $2 AND r.used_at IS NULL AND r.code_expires_at > now()
      RETURNING r.*, (SELECT k.organization_id FROM organization_oidc_clients k WHERE k.id = r.client_id) AS organization_id`,
    [sha256(input.code), client.id]
  );
  if (!r) throw new OidcError("invalid_grant", "The code is unknown, used, expired, or not this client's.");
  if (input.redirectUri !== r.redirect_uri) throw new OidcError("invalid_grant", "redirect_uri does not match the one the sign-in began with.");
  if (r.code_challenge) {
    const verifier = typeof input.codeVerifier === "string" ? input.codeVerifier : "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!verifier || challenge !== r.code_challenge) throw new OidcError("invalid_grant", "code_verifier does not match the code_challenge.");
  }
  const role = await roleIn(r.organization_id, r.account_id!);
  if (!role) throw new OidcError("invalid_grant", "The person is no longer a member of the organization.");
  const claims = await personClaims(r.account_id!, r.organization_id, role, r.scope.split(" "));
  await rawQuery(`UPDATE organization_oidc_clients SET last_used_at = now() WHERE id = $1`, [client.id]);
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: issuer(), sub: r.account_id, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const idToken = signJwt({ ...base, aud: client.client_id, auth_time: Math.floor(r.approved_at!.getTime() / 1000), ...(r.nonce ? { nonce: r.nonce } : {}), ...claims });
  const accessToken = signJwt({ ...base, aud: `${issuer()}/userinfo`, client_id: client.client_id, organization: r.organization_id, scope: r.scope });
  return { token_type: "Bearer", access_token: accessToken, id_token: idToken, expires_in: TOKEN_TTL_SECONDS, scope: r.scope };
}

async function personClaims(accountId: string, organizationId: string, role: "admin" | "member", scopes: string[]): Promise<Record<string, unknown>> {
  const [p] = await rawQuery<{ display_name: string; email: string | null; org_name: string }>(
    `SELECT a.display_name, a.email, o.display_name AS org_name FROM contributors a, contributors o WHERE a.id = $1 AND o.id = $2`,
    [accountId, organizationId]
  );
  return {
    organization: organizationId,
    organization_name: p?.org_name ?? null,
    groups: [role],
    ...(scopes.includes("profile") ? { name: p?.display_name ?? null } : {}),
    ...(scopes.includes("email") && p?.email ? { email: p.email, email_verified: true } : {}),
  };
}

/** What the access token says of the person, read again now: they must still be a live member. */
export async function userinfo(authorization: string | undefined): Promise<Record<string, unknown>> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  // RFC 6750 §3.1: a request with no token at all is an invalid request.
  if (!token) throw new OidcError("invalid_request", "An access token is required: Authorization: Bearer <token>.", 400);
  const claims = verifyJwt(token, `${issuer()}/userinfo`);
  if (!claims || typeof claims.sub !== "string" || typeof claims.organization !== "string") {
    throw new OidcError("invalid_token", "The access token is missing, expired, or not this provider's.", 401);
  }
  const role = await roleIn(claims.organization, claims.sub);
  if (!role) throw new OidcError("invalid_token", "The person is no longer a member of the organization.", 401);
  return { sub: claims.sub, ...(await personClaims(claims.sub, claims.organization, role, String(claims.scope ?? "").split(" "))) };
}

/** For a test: forget the signing key, so the next call reads the setting again. */
export function forgetOidcKey(): void {
  signing = null;
}
