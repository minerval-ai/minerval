/**
 * This deployment's connection to the public graph, its own side
 * (docs/organizations.md, "Connecting"; #1118, phase 2b).
 *
 * An administrator presses Connect: the deployment makes a key, asks the
 * public graph to connect it (POST /deployments/connect, signed with that
 * key), and shows the code and the link it is given. An admin of the
 * organization approves it on minerval.ai. The deployment learns that the
 * next time it asks (GET /deployments/connect/:code, signed the same way),
 * stores what it was given beside the key, and from then on signs every
 * request with it (services/public-graph-client.ts). No restart.
 *
 * The private key is written and read on the owner's connection only.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { DEPLOYMENT_GRANTS, type DeploymentGrant } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { generateSigningKey } from "./mirror-batch.js";
import {
  forgetConnection,
  publicGraphFetch,
  readConnection,
  signedAuthorization,
  type Connection,
} from "./public-graph-client.js";
import { logOutwardAct, type Actor } from "./outward-acts-service.js";

const REASON =
  "The deployment's connection key is the owner's alone; it is written when an administrator connects and read to sign requests to the public graph.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);

/** The public graph's API address, where nothing else names one. */
export const MINERVAL_API_URL = "https://api.claimgraph.io";
/** How often a waiting connection may ask, as the public graph says. */
const POLL_MS = 5_000;
/** How often a connected one reads its grants again when a page asks. */
const REFRESH_MS = 60_000;

export class ConnectionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

/** The fetch the connection itself goes out by (asking and polling, before the key is approved). */
let rawFetch: typeof fetch = (input, init) => fetch(input, init);
export function setConnectionFetch(impl: typeof fetch | null): void {
  rawFetch = impl ?? ((input, init) => fetch(input, init));
}

async function sendWithKey(
  key: { privateKeyPem: string; publicKey: string },
  url: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<{ status: number; json: Record<string, any> }> {
  const text = body === undefined ? null : JSON.stringify(body);
  const res = await rawFetch(url, {
    method,
    headers: {
      authorization: signedAuthorization(key, url, method, text),
      ...(text !== null ? { "content-type": "application/json" } : {}),
    },
    ...(text !== null ? { body: text } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  let json: Record<string, any> = {};
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function errorWords(json: Record<string, any>, status: number): string {
  const e = json.error;
  return typeof e === "string" ? e : typeof e?.message === "string" ? e.message : `The public graph answered ${status}.`;
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The identifier this deployment puts on its usage reports, where it has made one (docs/usage-report.md). */
async function reportIdentifier(): Promise<string | null> {
  const [row] = await rawQuery<{ id: string | null }>(
    `SELECT deployment_id::text AS id FROM usage_reports ORDER BY created_at ASC LIMIT 1`
  );
  return row?.id ?? null;
}

// ---- connecting -------------------------------------------------------------

export async function startConnect(input: {
  name: string;
  grants: DeploymentGrant[];
  apiUrl?: string | null;
  replace?: boolean;
  actor: Actor;
}): Promise<ConnectionView> {
  const config = loadConfig();
  const hosting = config.deploymentHosting;
  if (!hosting) {
    throw new ConnectionError(
      "HOSTING_NOT_STATED",
      "Say where this deployment runs before connecting: DEPLOYMENT_HOSTING (own_machines, minerval or third_party). The organization's admin is shown it.",
      409
    );
  }
  const grants = [...new Set(input.grants)].filter((g): g is DeploymentGrant => (DEPLOYMENT_GRANTS as readonly string[]).includes(g));
  if (grants.length === 0) throw new ConnectionError("NO_GRANTS", "Ask for at least one grant.", 422);
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw new ConnectionError("NAME_REQUIRED", "Suggest a name for this deployment.", 422);
  const existing = await readConnection();
  if (existing?.state === "connected" && !input.replace) {
    throw new ConnectionError(
      "ALREADY_CONNECTED",
      "This deployment is connected already. Connecting again makes a new key and needs a new approval; the old connection stops when you disconnect it.",
      409
    );
  }
  const apiUrl = base(input.apiUrl?.trim() || config.publicGraphApiUrl || MINERVAL_API_URL);
  const key = generateSigningKey();
  const asked = { privateKeyPem: key.privateKeyPem, publicKey: key.publicKey };
  let res: { status: number; json: Record<string, any> };
  try {
    res = await sendWithKey(asked, `${apiUrl}/deployments/connect`, "POST", {
      public_key: key.publicKey,
      name,
      hosting,
      grants,
      ...((await reportIdentifier()) ? { report_identifier: await reportIdentifier() } : {}),
    });
  } catch (err) {
    throw new ConnectionError("PUBLIC_GRAPH_UNREACHABLE", `${apiUrl} could not be reached: ${err instanceof Error ? err.message.slice(0, 200) : "no answer"}`, 502);
  }
  if (res.status !== 201) {
    await logOutwardAct({ kind: "connect_deployment", by: input.actor, sent: { api_url: apiUrl, name, hosting, grants }, result: "refused", said: errorWords(res.json, res.status) });
    throw new ConnectionError("PUBLIC_GRAPH_REFUSED", errorWords(res.json, res.status), 502);
  }
  await asOwner(() =>
    rawQuery(
      `INSERT INTO public_graph_connection (id, api_url, private_key_pem, public_key, key_id, state, code, verification_uri, code_expires_at, asked_grants, started_by, started_at)
       VALUES ('this', $1, $2, $3, $4, 'waiting', $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET api_url = EXCLUDED.api_url, private_key_pem = EXCLUDED.private_key_pem, public_key = EXCLUDED.public_key,
         key_id = EXCLUDED.key_id, state = 'waiting', code = EXCLUDED.code, verification_uri = EXCLUDED.verification_uri,
         code_expires_at = EXCLUDED.code_expires_at, asked_grants = EXCLUDED.asked_grants, started_by = EXCLUDED.started_by,
         started_at = now(), deployment_id = NULL, deployment_name = NULL, organization_id = NULL, organization_name = NULL,
         grants = '{}', connected_at = NULL, last_checked_at = NULL, last_error = NULL`,
      [
        apiUrl,
        key.privateKeyPem,
        key.publicKey,
        key.keyId,
        String(res.json.code),
        String(res.json.verification_uri_complete ?? ""),
        res.json.expires_at ? new Date(String(res.json.expires_at)) : null,
        grants,
        "actor" in input.actor ? input.actor.actor.id : null,
      ]
    )
  );
  forgetConnection();
  await logOutwardAct({
    kind: "connect_deployment",
    by: input.actor,
    sent: { api_url: apiUrl, name, hosting, grants, key_id: key.keyId },
    result: "done",
    said: `Code ${String(res.json.code)}, waiting for an admin of the organization`,
  });
  return (await connectionStatus({ check: false }))!;
}

/** Ask the public graph whether the waiting connection has been approved, and store what it says. */
export async function checkConnect(): Promise<void> {
  const c = await readConnection();
  if (!c || c.state !== "waiting" || !c.code) return;
  let res: { status: number; json: Record<string, any> };
  try {
    res = await sendWithKey(c, `${c.apiUrl}/deployments/connect/${encodeURIComponent(c.code)}`, "GET");
  } catch (err) {
    await asOwner(() =>
      rawQuery(`UPDATE public_graph_connection SET last_checked_at = now(), last_error = $1 WHERE id = 'this'`, [
        `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 200) : "no answer"}`,
      ])
    );
    forgetConnection();
    return;
  }
  const state = res.json.state;
  if (res.status === 200 && state === "approved") {
    const grants = (Array.isArray(res.json.grants) ? res.json.grants : []).filter((g: unknown) => (DEPLOYMENT_GRANTS as readonly unknown[]).includes(g));
    await asOwner(() =>
      rawQuery(
        `UPDATE public_graph_connection SET state = 'connected', deployment_id = $1, deployment_name = $2, organization_id = $3,
           organization_name = $4, grants = $5, connected_at = now(), last_checked_at = now(), last_error = NULL, code = NULL
         WHERE id = 'this'`,
        [res.json.deployment?.id ?? null, res.json.deployment?.name ?? null, res.json.organization?.id ?? null, res.json.organization?.name ?? null, grants]
      )
    );
    forgetConnection();
    // The feed's key is read now, for an administrator to accept on the
    // Mirror page (docs/organizations.md, "The feed's key"). A failure is
    // said there and stops nothing here.
    if (grants.includes("read_feed")) {
      const { followsInApp, readFeedKeys } = await import("./mirror-following.js");
      if (followsInApp()) await readFeedKeys().catch(() => undefined);
    }
  } else if (res.status === 200 && (state === "denied" || state === "expired")) {
    await asOwner(() => rawQuery(`UPDATE public_graph_connection SET state = $1, last_checked_at = now() WHERE id = 'this'`, [state]));
  } else if (res.status === 200) {
    await asOwner(() => rawQuery(`UPDATE public_graph_connection SET last_checked_at = now(), last_error = NULL WHERE id = 'this'`));
  } else {
    await asOwner(() =>
      rawQuery(`UPDATE public_graph_connection SET last_checked_at = now(), last_error = $1 WHERE id = 'this'`, [errorWords(res.json, res.status)])
    );
  }
  forgetConnection();
}

/**
 * Read the connection's grants and organization again from the public
 * graph (GET /organizations/me), so that a withdrawn grant or a retired
 * deployment is seen here.
 */
export async function refreshConnection(): Promise<void> {
  const c = await readConnection();
  if (!c || c.state !== "connected") return;
  let res: Response;
  try {
    res = await publicGraphFetch(`${c.apiUrl}/organizations/me`, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    await asOwner(() =>
      rawQuery(`UPDATE public_graph_connection SET last_checked_at = now(), last_error = $1 WHERE id = 'this'`, [
        `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 200) : "no answer"}`,
      ])
    );
    forgetConnection();
    return;
  }
  let json: Record<string, any> = {};
  try {
    json = (await res.json()) as Record<string, any>;
  } catch {
    json = {};
  }
  if (res.ok) {
    const grants = (Array.isArray(json.deployment?.grants) ? json.deployment.grants : []).filter((g: unknown) =>
      (DEPLOYMENT_GRANTS as readonly unknown[]).includes(g)
    );
    await asOwner(() =>
      rawQuery(
        `UPDATE public_graph_connection SET grants = $1, organization_name = $2, deployment_name = $3, last_checked_at = now(), last_error = NULL WHERE id = 'this'`,
        [grants, json.organization?.name ?? c.organizationName, json.deployment?.name ?? c.deploymentName]
      )
    );
  } else {
    // Retired on minerval.ai, or every grant withdrawn: the deployment holds nothing there now.
    await asOwner(() =>
      rawQuery(`UPDATE public_graph_connection SET grants = '{}', last_checked_at = now(), last_error = $1 WHERE id = 'this'`, [
        errorWords(json, res.status),
      ])
    );
  }
  forgetConnection();
}

/**
 * Disconnect: tell the public graph to retire this deployment (one last
 * signed request), then forget the key. A failure to reach the public graph
 * is said, and the key is forgotten all the same: an admin of the
 * organization can retire it there.
 */
export async function disconnect(input: { actor: Actor }): Promise<{ retired_there: boolean; said: string | null }> {
  const c = await readConnection();
  if (!c) throw new ConnectionError("NOT_CONNECTED", "This deployment is not connected.", 409);
  let retired = false;
  let said: string | null = null;
  if (c.state === "connected") {
    try {
      const res = await publicGraphFetch(`${c.apiUrl}/deployments/me/retire`, { method: "POST", body: "{}", signal: AbortSignal.timeout(20_000) });
      retired = res.ok;
      if (!res.ok) said = `The public graph answered ${res.status}.`;
    } catch (err) {
      said = `The public graph could not be reached: ${err instanceof Error ? err.message.slice(0, 200) : "no answer"}`;
    }
  }
  await asOwner(() => rawQuery(`DELETE FROM public_graph_connection WHERE id = 'this'`));
  forgetConnection();
  await logOutwardAct({
    kind: "disconnect_deployment",
    by: input.actor,
    sent: { api_url: c.apiUrl, key_id: c.keyId, deployment_id: c.deploymentId },
    result: c.state !== "connected" || retired ? "done" : "failed",
    said: said ?? (c.state === "connected" ? "Retired on the public graph" : "A waiting request was withdrawn"),
  });
  return { retired_there: retired, said };
}

// ---- reading ------------------------------------------------------------------

export interface ConnectionView {
  connected: boolean;
  state: Connection["state"] | "none";
  api_url: string | null;
  key_id: string | null;
  code: string | null;
  link: string | null;
  code_expires_at: string | null;
  asked_grants: DeploymentGrant[];
  organization: { id: string; name: string } | null;
  deployment: { id: string; name: string } | null;
  grants: DeploymentGrant[];
  connected_at: string | null;
  last_checked_at: string | null;
  problem: string | null;
}

/**
 * The connection as a page shows it. A waiting one is checked if it has not
 * been lately, and a connected one read again now and then, so a page that
 * is open learns of an approval or a withdrawal without anyone pressing
 * anything.
 */
export async function connectionStatus(opts: { check?: boolean } = {}): Promise<ConnectionView | null> {
  let c = await readConnection();
  if (opts.check !== false && c) {
    const since = c.lastCheckedAt ? Date.now() - new Date(c.lastCheckedAt).getTime() : Infinity;
    if (c.state === "waiting" && since >= POLL_MS) await checkConnect();
    else if (c.state === "connected" && since >= REFRESH_MS) await refreshConnection();
    c = await readConnection();
  }
  if (!c) return null;
  const expired = c.state === "waiting" && c.codeExpiresAt !== null && new Date(c.codeExpiresAt).getTime() <= Date.now();
  return {
    connected: c.state === "connected",
    state: expired ? "expired" : c.state,
    api_url: c.apiUrl,
    key_id: c.keyId,
    code: c.state === "waiting" ? c.code : null,
    link: c.state === "waiting" ? c.verificationUri : null,
    code_expires_at: c.codeExpiresAt ? new Date(c.codeExpiresAt).toISOString() : null,
    asked_grants: c.askedGrants,
    organization: c.organizationId ? { id: c.organizationId, name: c.organizationName ?? "" } : null,
    deployment: c.deploymentId ? { id: c.deploymentId, name: c.deploymentName ?? "" } : null,
    grants: c.grants,
    connected_at: c.connectedAt ? new Date(c.connectedAt).toISOString() : null,
    last_checked_at: c.lastCheckedAt ? new Date(c.lastCheckedAt).toISOString() : null,
    problem: c.lastError,
  };
}
