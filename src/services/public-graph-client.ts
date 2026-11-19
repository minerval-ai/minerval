/**
 * One client for every request this deployment makes to the public graph
 * (docs/organizations.md, "What changes inside a deployment"; #1118, phase
 * 2b): the mirror applier, the usage-report sender, the outbound sender and
 * the outward acts all go through here.
 *
 * Where the deployment is connected (public_graph_connection, state
 * 'connected'), each request is signed with its connection key
 * (services/request-signature.ts) and carries no bearer secret. Where it is
 * not, the request carries the account key from the settings, as before;
 * that fallback goes with the last phase (docs/organizations.md, "Phases").
 *
 * The connection is read on the owner's connection, since the key is the
 * owner's alone, and kept in memory for a few seconds so that a run of
 * requests does not read it each time.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import type { DeploymentGrant } from "../db/schema.js";
import { parseSigningKey } from "./mirror-batch.js";
import { signRequest } from "./request-signature.js";

const REASON =
  "The deployment's connection key is the owner's alone; it is read to sign a request to the public graph and goes nowhere else.";

export interface Connection {
  apiUrl: string;
  state: "waiting" | "connected" | "denied" | "expired" | "by_hand";
  privateKeyPem: string;
  publicKey: string;
  keyId: string;
  code: string | null;
  verificationUri: string | null;
  codeExpiresAt: Date | null;
  askedGrants: DeploymentGrant[];
  /** Where it runs, as the administrator who connected it answered. */
  hosting: Hosting | null;
  deploymentId: string | null;
  deploymentName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  grants: DeploymentGrant[];
  /** The allowance on its spend as last read, and what is left (micro-USD); null where none is set. */
  allowanceMicroUsd: number | null;
  allowanceLeftMicroUsd: number | null;
  /** The signed request shown to carry by hand, where it was connected that way. */
  byHandRequest: string | null;
  startedBy: string | null;
  startedAt: Date;
  connectedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export const HOSTINGS = ["own_machines", "third_party", "minerval"] as const;
export type Hosting = (typeof HOSTINGS)[number];
export function isHosting(value: unknown): value is Hosting {
  return typeof value === "string" && (HOSTINGS as readonly string[]).includes(value);
}

const CACHE_MS = 5_000;
let cached: { at: number; value: Connection | null } | null = null;

/** Forget the cached connection: after it changes, or in a test. */
export function forgetConnection(): void {
  cached = null;
}

export async function readConnection(): Promise<Connection | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [row] = await withSystemClearance(REASON, () =>
    rawQuery<{
      api_url: string; state: Connection["state"]; private_key_pem: string; public_key: string; key_id: string;
      code: string | null; verification_uri: string | null; code_expires_at: Date | null; asked_grants: DeploymentGrant[]; hosting: string | null;
      deployment_id: string | null; deployment_name: string | null; organization_id: string | null; organization_name: string | null;
      grants: DeploymentGrant[]; allowance_micro_usd: string | null; allowance_left_micro_usd: string | null; by_hand_request: string | null; started_by: string | null; started_at: Date; connected_at: Date | null; last_checked_at: Date | null;
      last_error: string | null;
    }>(`SELECT * FROM public_graph_connection WHERE id = 'this'`)
  );
  const value: Connection | null = row
    ? {
        apiUrl: row.api_url,
        state: row.state,
        privateKeyPem: row.private_key_pem,
        publicKey: row.public_key,
        keyId: row.key_id,
        code: row.code,
        verificationUri: row.verification_uri,
        codeExpiresAt: row.code_expires_at,
        askedGrants: row.asked_grants,
        hosting: isHosting(row.hosting) ? row.hosting : null,
        deploymentId: row.deployment_id,
        deploymentName: row.deployment_name,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        grants: row.grants,
        allowanceMicroUsd: row.allowance_micro_usd === null ? null : Number(row.allowance_micro_usd),
        allowanceLeftMicroUsd: row.allowance_left_micro_usd === null ? null : Number(row.allowance_left_micro_usd),
        byHandRequest: row.by_hand_request,
        startedBy: row.started_by,
        startedAt: row.started_at,
        connectedAt: row.connected_at,
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error,
      }
    : null;
  cached = { at: Date.now(), value };
  return value;
}

/** The connection, where it is approved and in use. */
export async function liveConnection(): Promise<Connection | null> {
  const c = await readConnection();
  return c && c.state === "connected" ? c : null;
}

/** The fetch requests go out by. Tests deliver into an app of their own. */
let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
export function setPublicGraphFetch(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((input, init) => fetch(input, init));
}

/** The Authorization header for one request, signed with a key. */
export function signedAuthorization(
  key: { privateKeyPem: string; publicKey: string },
  url: string,
  method: string,
  body?: string | null
): string {
  const u = new URL(url);
  return signRequest(parseSigningKey(key.privateKeyPem, "the connection key"), key.publicKey, {
    host: u.host,
    method,
    path: `${u.pathname}${u.search}`,
    body: body ?? null,
  });
}

/**
 * Send a request to the public graph. Signed with the connection key where
 * the deployment is connected; otherwise with `fallbackKey`, the account
 * key from the settings, where one is given. The body, when there is one,
 * is sent exactly as it was signed.
 */
export async function publicGraphFetch(
  url: string,
  init: { method?: string; body?: string | null; headers?: Record<string, string>; fallbackKey?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined && init.body !== null && !headers["content-type"]) headers["content-type"] = "application/json";
  const connection = await liveConnection();
  if (connection) {
    headers.authorization = signedAuthorization(connection, url, method, init.body ?? null);
  } else if (init.fallbackKey) {
    headers["x-api-key"] = init.fallbackKey;
  }
  return fetchImpl(url, {
    method,
    headers,
    ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}
