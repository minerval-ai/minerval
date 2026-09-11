/**
 * GitHub App authentication for the agent-reports issue filing (#366).
 *
 * The far end of raise_issue writes as the minerval-agents GitHub App, not
 * as a person: the App's private key (GITHUB_APP_PRIVATE_KEY, from Secrets
 * Manager) plus its app id and installation id. A GitHub App holds no
 * long-lived token. It signs a JWT with its key, good for minutes, and
 * exchanges that for an installation access token, good for an hour, then
 * does it again. This module does the exchange and keeps the token for its
 * lifetime, so the issue service asks for "the bearer" and never sees the
 * key; a 401 from GitHub drops the cached token and the next request mints
 * a fresh one, which is how a rotated key or a reinstalled App recovers
 * without a restart.
 *
 * A plain token (GITHUB_TOKEN, a fine-grained PAT) still works and is what a
 * local run uses. When both are set the App wins.
 */
import { createSign } from "node:crypto";
import { loadConfig } from "../config.js";

/** GitHub caps an App JWT at ten minutes; stay under it with skew allowed. */
const JWT_CLOCK_SKEW_S = 60;
const JWT_LIFETIME_S = 9 * 60;
/** Mint again this long before the installation token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "minerval-agent-reports";

interface InstallationToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

let cached: InstallationToken | null = null;
let inflight: Promise<string> | null = null;

/** Test hook, and the reset a 401 triggers. */
export function resetGithubAppTokenCache(): void {
  cached = null;
  inflight = null;
}

export function githubAppConfigured(): boolean {
  const config = loadConfig();
  return Boolean(
    config.githubAppId && config.githubAppInstallationId && config.githubAppPrivateKey
  );
}

/** Either credential makes the GitHub side reachable. */
export function githubAuthConfigured(): boolean {
  return githubAppConfigured() || Boolean(loadConfig().githubToken);
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The App's own credential: an RS256 JWT with the app id as issuer, dated a
 * minute into the past so GitHub's clock cannot reject it as not yet valid.
 */
export function signAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - JWT_CLOCK_SKEW_S;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + JWT_CLOCK_SKEW_S + JWT_LIFETIME_S, iss: appId })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

async function mintInstallationToken(): Promise<InstallationToken> {
  const config = loadConfig();
  const jwt = signAppJwt(config.githubAppId, config.githubAppPrivateKey);
  const path = `/app/installations/${config.githubAppInstallationId}/access_tokens`;
  const res = await fetch(`${config.githubApiBaseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub App token exchange failed (${res.status}) for installation ` +
        `${config.githubAppInstallationId}: ${body.slice(0, 300)}`
    );
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Date.parse(body.expires_at);
  return {
    token: body.token,
    // GitHub always dates the token; if it ever did not, treat it as an
    // hour's grant rather than one that is already stale.
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000,
  };
}

/**
 * The bearer for the next GitHub request: the cached installation token
 * while it has margin left, a freshly minted one otherwise (concurrent
 * callers share the one exchange), or the plain token when no App is set.
 * Throws only when the exchange itself fails; callers are the never-throw
 * paths of the issue service, which log it.
 */
export async function getGithubBearer(): Promise<string> {
  const config = loadConfig();
  if (!githubAppConfigured()) return config.githubToken;
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token;
  if (!inflight) {
    inflight = mintInstallationToken()
      .then((minted) => {
        cached = minted;
        return minted.token;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
