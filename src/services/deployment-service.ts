/**
 * Connected deployments, the public graph's side (docs/organizations.md, "A
 * deployment's identity" and "Connecting"; #1118, phase 2).
 *
 * A private deployment asks to be connected with a key it made and a short
 * code; an admin of an organization approves it, with the grants they
 * choose, from their own session. From then on the deployment signs every
 * request with that key, and each signed request is the organization's,
 * limited to what its grants open (server/organization-routes.ts).
 */
import { randomInt } from "node:crypto";
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { ACT_SPLIT, DEPLOYMENT_GRANTS, type DeploymentGrant } from "../db/schema.js";
import { HOSTING_WORDS } from "../published-page/verify.js";
import { keyIdOf, parsePublicKey } from "./mirror-batch.js";
import { NONCE_MEMORY_SECONDS } from "./request-signature.js";
import { isLiveAdmin } from "./organization-service.js";

const REASON =
  "A deployment's key and grants say who a signed request is, so they are written on the owner's connection, as API keys are. The caller has checked the signature, or the admin approving it.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);

/** How long a code waits for an admin. */
export const CONNECT_TTL_MS = 15 * 60 * 1000;
/** How often the deployment may ask whether it has been approved. */
export const CONNECT_INTERVAL_SECONDS = 5;
const NAME_MAX = 120;
// RFC 8628's alphabet for a code a person reads: no vowels, no look-alikes.
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export class DeploymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

export function isGrant(value: unknown): value is DeploymentGrant {
  return typeof value === "string" && (DEPLOYMENT_GRANTS as readonly string[]).includes(value);
}

/**
 * Grants as a deployment or an admin names them, with phase 2's `act` read as
 * the four it was split into (docs/organizations.md, "What an organization
 * grants"): a deployment built before the split still asks for it. Anything
 * else that is not a grant is left in, so the caller refuses it.
 */
export function readGrants(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((g) => (g === "act" ? [...ACT_SPLIT] : [g])))];
}

function makeCode(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** A code as a person may type it: any case, with or without the dash. */
export function normalizeCode(code: string): string {
  const letters = code.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : code.toUpperCase();
}

function isUuid(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ---- asking to connect ---------------------------------------------------------

export interface ConnectAsk {
  publicKey: string;
  name: unknown;
  hosting: unknown;
  /** The grants its settings need, alone: what a deployment built before `needs` sends. */
  grants?: unknown;
  /** The grants its settings need, each with why ([{ grant, why }]). */
  needs?: unknown;
  /** Where its own site is, for links back to it. */
  address?: unknown;
  reportIdentifier?: unknown;
}

export interface Need {
  grant: DeploymentGrant;
  why: string | null;
}

const WHY_MAX = 300;
const ADDRESS_MAX = 500;

/**
 * What a deployment says its settings need: `needs` with why, or `grants`
 * alone from one built before. Neither is required: the admin approving
 * chooses from every grant. Anything that is not a grant is refused.
 */
function readNeeds(input: ConnectAsk): Need[] {
  const out = new Map<DeploymentGrant, string | null>();
  const add = (grant: unknown, why: unknown) => {
    for (const g of readGrants([grant])) {
      if (!isGrant(g)) throw new DeploymentError("BAD_GRANTS", `Needs are among ${DEPLOYMENT_GRANTS.join(", ")}.`, 422);
      const words = typeof why === "string" && why.trim() ? why.trim().replace(/\s+/g, " ").slice(0, WHY_MAX) : null;
      if (!out.has(g) || (out.get(g) === null && words)) out.set(g, words);
    }
  };
  if (input.needs !== undefined && input.needs !== null) {
    if (!Array.isArray(input.needs)) throw new DeploymentError("BAD_NEEDS", "needs is a list of { grant, why }.", 422);
    for (const n of input.needs) {
      if (!n || typeof n !== "object") throw new DeploymentError("BAD_NEEDS", "needs is a list of { grant, why }.", 422);
      add((n as { grant?: unknown }).grant, (n as { why?: unknown }).why);
    }
  }
  if (input.grants !== undefined && input.grants !== null) {
    if (!Array.isArray(input.grants)) throw new DeploymentError("BAD_GRANTS", `grants is a list among ${DEPLOYMENT_GRANTS.join(", ")}.`, 422);
    for (const g of input.grants) add(g, null);
  }
  return [...out].map(([grant, why]) => ({ grant, why }));
}

const BAD_ADDRESS = "address is the deployment's own web address, https://...";

/**
 * The address a deployment states for its own site: an http(s) origin and
 * path, nothing else. It is shown, linked to, and sent back to after
 * approval; it is never fetched.
 */
export function readAddress(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > ADDRESS_MAX) throw new DeploymentError("BAD_ADDRESS", BAD_ADDRESS, 422);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DeploymentError("BAD_ADDRESS", BAD_ADDRESS, 422);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DeploymentError("BAD_ADDRESS", BAD_ADDRESS, 422);
  if (url.username || url.password) throw new DeploymentError("BAD_ADDRESS", "address carries no user name or password.", 422);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Record a deployment's request to connect. The caller has checked it is signed with the key it names. */
export async function askToConnect(input: ConnectAsk): Promise<{ code: string; expires_at: string; key_id: string }> {
  try {
    parsePublicKey(input.publicKey);
  } catch {
    throw new DeploymentError("BAD_PUBLIC_KEY", "public_key must be an Ed25519 key, the base64 of its 32 bytes.", 422);
  }
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX) : "";
  if (!name) throw new DeploymentError("NAME_REQUIRED", "Suggest a name for the deployment.", 422);
  if (typeof input.hosting !== "string" || !(input.hosting in HOSTING_WORDS)) {
    throw new DeploymentError("BAD_HOSTING", `hosting is one of ${Object.keys(HOSTING_WORDS).join(", ")}.`, 422);
  }
  const needs = readNeeds(input);
  const address = readAddress(input.address);
  const report = input.reportIdentifier === undefined || input.reportIdentifier === null ? null : input.reportIdentifier;
  if (report !== null && !isUuid(report)) throw new DeploymentError("BAD_REPORT_IDENTIFIER", "report_identifier is a uuid.", 422);
  const keyId = keyIdOf(input.publicKey);
  const [live] = await rawQuery<{ id: string }>(`SELECT id FROM deployments WHERE key_id = $1 AND retired_at IS NULL`, [keyId]);
  if (live) throw new DeploymentError("KEY_ALREADY_CONNECTED", "This key is already a connected deployment's. Make a new key to connect again.", 409);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    try {
      const [row] = await asOwner(() =>
        rawQuery<{ expires_at: Date }>(
          `INSERT INTO deployment_connect_requests (code, public_key, key_id, suggested_name, hosting, asked_grants, needs, address, report_identifier, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now() + ($10 || ' milliseconds')::interval)
           RETURNING expires_at`,
          [code, input.publicKey, keyId, name, input.hosting, needs.map((n) => n.grant), JSON.stringify(needs), address, report, String(CONNECT_TTL_MS)]
        )
      );
      return { code, expires_at: new Date(row!.expires_at).toISOString(), key_id: keyId };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue; // a code already in use: draw another
      throw err;
    }
  }
  throw new DeploymentError("NO_CODE", "Could not make a code. Try again.", 503);
}

interface ConnectRow {
  id: string;
  code: string;
  public_key: string;
  key_id: string;
  suggested_name: string;
  hosting: string;
  asked_grants: string[];
  needs: Array<{ grant: string; why: string | null }>;
  address: string | null;
  report_identifier: string | null;
  expires_at: Date;
  state: "waiting" | "approved" | "denied";
  deployment_id: string | null;
}

async function connectRow(code: string): Promise<ConnectRow | null> {
  const [row] = await rawQuery<ConnectRow>(
    `SELECT id, code, public_key, key_id, suggested_name, hosting, asked_grants, needs, address, report_identifier, expires_at, state, deployment_id
       FROM deployment_connect_requests WHERE code = $1`,
    [normalizeCode(code)]
  );
  return row ?? null;
}

/** The public key a waiting request was made with, so its own polls can be checked. */
export async function connectRequestKey(code: string): Promise<string | null> {
  return (await connectRow(code))?.public_key ?? null;
}

export type ConnectState =
  | { state: "waiting"; expires_at: string }
  | { state: "expired" }
  | { state: "denied" }
  | {
      state: "approved";
      deployment: { id: string; name: string };
      organization: { id: string; name: string };
      grants: DeploymentGrant[];
    };

function expired(row: ConnectRow): boolean {
  return row.state === "waiting" && new Date(row.expires_at).getTime() <= Date.now();
}

/** What the deployment learns when it asks whether it has been approved. */
export async function connectState(code: string): Promise<ConnectState> {
  const row = await connectRow(code);
  if (!row) throw new DeploymentError("CODE_NOT_FOUND", "No connection request has that code.", 404);
  if (row.state === "denied") return { state: "denied" };
  if (expired(row)) return { state: "expired" };
  if (row.state === "waiting") return { state: "waiting", expires_at: new Date(row.expires_at).toISOString() };
  const live = await liveDeployment(row.deployment_id!);
  if (!live) return { state: "denied" };
  return {
    state: "approved",
    deployment: { id: live.id, name: live.name },
    organization: { id: live.organization_id, name: live.organization_name },
    grants: live.grants,
  };
}

/** What an admin who opened the link is shown before deciding. */
export interface ConnectRequestView {
  code: string;
  suggested_name: string;
  hosting: string;
  hosting_words: string;
  key_id: string;
  /** The grants its settings need, alone (as before `needs`). */
  asked_grants: DeploymentGrant[];
  /** The grants its settings need, each with why, where it said. */
  needs: Need[];
  /** Where its own site is, as it stated. */
  address: string | null;
  expires_at: string;
  state: "waiting" | "approved" | "denied" | "expired";
  /** The organizations the reader is an admin of, to choose from. */
  your_organizations: Array<{ id: string; name: string }>;
  /** Those they are only a member of, with the admins who can approve it there. */
  member_organizations: Array<{ id: string; name: string; admins: string[] }>;
}

/** What a request says its settings need, from `needs`, or from the grants alone where it said no more. */
function needsOf(row: ConnectRow): Need[] {
  const said = Array.isArray(row.needs) ? row.needs.filter((n) => isGrant(n?.grant)) : [];
  const out: Need[] = said.map((n) => ({ grant: n.grant as DeploymentGrant, why: n.why ?? null }));
  for (const g of readGrants(row.asked_grants).filter(isGrant)) if (!out.some((n) => n.grant === g)) out.push({ grant: g, why: null });
  return out;
}

export async function readConnectRequest(code: string, readerId: string): Promise<ConnectRequestView> {
  const row = await connectRow(code);
  if (!row) throw new DeploymentError("CODE_NOT_FOUND", "No connection request has that code. Check the code the deployment shows.", 404);
  const orgs = await rawQuery<{ id: string; name: string }>(
    `SELECT c.id, c.display_name AS name FROM organization_members m JOIN contributors c ON c.id = m.organization_id
      WHERE m.account_id = $1 AND m.role = 'admin' AND m.removed_at IS NULL AND c.kind = 'organization'
      ORDER BY c.display_name`,
    [readerId]
  );
  const memberOf = await rawQuery<{ id: string; name: string; admins: string[] | null }>(
    `SELECT c.id, c.display_name AS name,
            (SELECT array_agg(a.display_name ORDER BY a.display_name) FROM organization_members am
               JOIN contributors a ON a.id = am.account_id
              WHERE am.organization_id = c.id AND am.role = 'admin' AND am.removed_at IS NULL AND NOT a.is_suspended) AS admins
       FROM organization_members m JOIN contributors c ON c.id = m.organization_id
      WHERE m.account_id = $1 AND m.role = 'member' AND m.removed_at IS NULL AND c.kind = 'organization'
      ORDER BY c.display_name`,
    [readerId]
  );
  const needs = needsOf(row);
  return {
    code: row.code,
    suggested_name: row.suggested_name,
    hosting: row.hosting,
    hosting_words: HOSTING_WORDS[row.hosting as keyof typeof HOSTING_WORDS] ?? row.hosting,
    key_id: row.key_id,
    asked_grants: needs.map((n) => n.grant),
    needs,
    address: row.address,
    expires_at: new Date(row.expires_at).toISOString(),
    state: expired(row) ? "expired" : row.state,
    your_organizations: orgs,
    member_organizations: memberOf.map((o) => ({ id: o.id, name: o.name, admins: o.admins ?? [] })),
  };
}

async function openRow(tx: TxQuery, code: string): Promise<ConnectRow> {
  const [row] = await tx.query<ConnectRow>(
    `SELECT id, code, public_key, key_id, suggested_name, hosting, asked_grants, needs, address, report_identifier, expires_at, state, deployment_id
       FROM deployment_connect_requests WHERE code = $1 FOR UPDATE`,
    [normalizeCode(code)]
  );
  if (!row) throw new DeploymentError("CODE_NOT_FOUND", "No connection request has that code.", 404);
  if (row.state !== "waiting") throw new DeploymentError("CODE_USED", "This code has already been answered.", 409);
  if (expired(row)) throw new DeploymentError("CODE_EXPIRED", "This code has expired. Ask for a new one on the deployment.", 409);
  return row;
}

/**
 * An admin of the organization approves the deployment, with the grants
 * they choose (any of the organization's grants for deployments; those its
 * settings need are only ticked to start with), a name, and an allowance on
 * spend where they set one. The code is used once. Recorded on the
 * organization's log under the admin. Answers where to send the admin back:
 * the deployment's own Overview, at the address it stated.
 */
export async function approveConnect(input: {
  code: string;
  organizationId: string;
  name?: unknown;
  grants: unknown;
  allowanceOwls?: unknown;
  by: string;
}): Promise<{ deployment_id: string; return_to: string | null }> {
  if (!(await isLiveAdmin(input.organizationId, input.by))) {
    throw new DeploymentError("ADMIN_REQUIRED", "Only an admin of that organization can approve a deployment for it.", 403);
  }
  return asOwner(() =>
    withTransaction(async (tx) => {
      const row = await openRow(tx, input.code);
      const grants = readGrants(input.grants);
      if (!grants.every(isGrant)) throw new DeploymentError("BAD_GRANTS", `Grants are among ${DEPLOYMENT_GRANTS.join(", ")}.`, 422);
      if (grants.length === 0) throw new DeploymentError("NO_GRANTS", "Tick at least one thing it may do, or deny it.", 422);
      const allowance = readAllowance(input.allowanceOwls);
      if (allowance !== null && !grants.includes("spend")) {
        throw new DeploymentError("ALLOWANCE_WITHOUT_SPEND", "An allowance is on spend: tick spend, or leave the allowance empty.", 422);
      }
      const name =
        typeof input.name === "string" && input.name.trim() ? input.name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX) : row.suggested_name;
      const [live] = await tx.query<{ id: string }>(`SELECT id FROM deployments WHERE key_id = $1 AND retired_at IS NULL`, [row.key_id]);
      if (live) throw new DeploymentError("KEY_ALREADY_CONNECTED", "This key is already a connected deployment's.", 409);
      const [dep] = await tx.query<{ id: string }>(
        `INSERT INTO deployments (organization_id, name, hosting, public_key, key_id, report_identifier, address, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.organizationId, name, row.hosting, row.public_key, row.key_id, row.report_identifier, row.address, input.by]
      );
      for (const g of grants) {
        await tx.query(
          `INSERT INTO organization_grants (organization_id, deployment_id, permission, granted_by, allowance_micro_usd) VALUES ($1, $2, $3, $4, $5)`,
          [input.organizationId, dep!.id, g, input.by, g === "spend" ? allowance : null]
        );
      }
      await tx.query(
        `UPDATE deployment_connect_requests SET state = 'approved', decided_by = $2, decided_at = now(), deployment_id = $3 WHERE id = $1`,
        [row.id, input.by, dep!.id]
      );
      await tx.query(
        `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail)
         VALUES ($1, $2, 'session', 'deployment_approved', $3::jsonb)`,
        [
          input.organizationId,
          input.by,
          JSON.stringify({
            deployment_id: dep!.id,
            name,
            hosting: row.hosting,
            key_id: row.key_id,
            grants,
            ...(allowance !== null ? { allowance_micro_usd: allowance } : {}),
          }),
        ]
      );
      return { deployment_id: dep!.id, return_to: row.address ? `${row.address}/admin/outside?check=1` : null };
    })
  );
}

/** An allowance given in owls on approval, as micro-USD, or null for none. */
function readAllowance(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const owls = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(owls) || owls < 0 || owls > 1_000_000_000) {
    throw new DeploymentError("BAD_ALLOWANCE", "An allowance is a number of owls, zero or more.", 422);
  }
  return Math.round(owls * 1_000_000);
}

/** Deny a waiting request. Only someone who admins an organization can, so a stranger with the link cannot block one. */
export async function denyConnect(input: { code: string; by: string }): Promise<void> {
  const [admin] = await rawQuery<{ ok: boolean }>(
    `SELECT true AS ok FROM organization_members WHERE account_id = $1 AND role = 'admin' AND removed_at IS NULL LIMIT 1`,
    [input.by]
  );
  if (!admin) throw new DeploymentError("ADMIN_REQUIRED", "Only an admin of an organization can deny a deployment.", 403);
  await asOwner(() =>
    withTransaction(async (tx) => {
      const row = await openRow(tx, input.code);
      await tx.query(`UPDATE deployment_connect_requests SET state = 'denied', decided_by = $2, decided_at = now() WHERE id = $1`, [row.id, input.by]);
    })
  );
}

// ---- a connected deployment ------------------------------------------------------------------

export interface LiveDeployment {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  organization_external_id: string;
  public_key: string;
  key_id: string;
  hosting: string;
  approved_at: Date;
  grants: DeploymentGrant[];
}

const LIVE_SELECT = `
  SELECT d.id, d.name, d.organization_id, c.display_name AS organization_name, c.external_id AS organization_external_id,
         d.public_key, d.key_id, d.hosting, d.approved_at,
         COALESCE(array_agg(g.permission ORDER BY g.permission) FILTER (WHERE g.id IS NOT NULL), '{}') AS grants
    FROM deployments d
    JOIN contributors c ON c.id = d.organization_id AND c.kind = 'organization' AND NOT c.is_suspended
    LEFT JOIN organization_grants g ON g.deployment_id = d.id AND g.withdrawn_at IS NULL
   WHERE d.retired_at IS NULL`;

async function liveDeployment(id: string): Promise<LiveDeployment | null> {
  const [row] = await rawQuery<LiveDeployment>(`${LIVE_SELECT} AND d.id = $1 GROUP BY d.id, c.id`, [id]);
  return row ?? null;
}

/** The live deployment a key id belongs to, with its live grants. */
export async function deploymentByKey(keyId: string): Promise<LiveDeployment | null> {
  const [row] = await rawQuery<LiveDeployment>(`${LIVE_SELECT} AND d.key_id = $1 GROUP BY d.id, c.id`, [keyId]);
  return row ?? null;
}

/**
 * Remember a write's nonce, refusing one already seen with this key in the
 * last ten minutes. Old nonces are pruned as new ones arrive.
 */
export async function recordNonce(keyId: string, nonce: string): Promise<boolean> {
  return asOwner(async () => {
    await rawQuery(`DELETE FROM deployment_request_nonces WHERE seen_at < now() - ($1 || ' seconds')::interval`, [String(NONCE_MEMORY_SECONDS)]);
    const rows = await rawQuery<{ nonce: string }>(
      `INSERT INTO deployment_request_nonces (key_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce`,
      [keyId, nonce]
    );
    return rows.length === 1;
  });
}

/** A signed write, for the organization's members to see. */
export async function logDeploymentRequest(entry: { deploymentId: string; method: string; route: string; status: number }): Promise<void> {
  await asOwner(() =>
    rawQuery(`INSERT INTO deployment_requests (deployment_id, method, route, status) VALUES ($1, $2, $3, $4)`, [
      entry.deploymentId,
      entry.method,
      entry.route,
      entry.status,
    ])
  );
}

/**
 * A deployment retires itself when its administrators disconnect it: its
 * key stops working at once, its grants are withdrawn, and the
 * organization's log says so. It can connect again with a new key.
 */
export async function retireSelf(deploymentId: string): Promise<void> {
  await asOwner(() =>
    withTransaction(async (tx) => {
      const [dep] = await tx.query<{ organization_id: string; name: string }>(
        `UPDATE deployments SET retired_at = now() WHERE id = $1 AND retired_at IS NULL RETURNING organization_id, name`,
        [deploymentId]
      );
      if (!dep) return;
      await tx.query(`UPDATE organization_grants SET withdrawn_at = now() WHERE deployment_id = $1 AND withdrawn_at IS NULL`, [deploymentId]);
      await tx.query(
        `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail)
         VALUES ($1, NULL, 'session', 'deployment_disconnected', $2::jsonb)`,
        [dep.organization_id, JSON.stringify({ deployment_id: deploymentId, name: dep.name })]
      );
    })
  );
}

/** What a deployment reads of itself and its organization (GET /organizations/me). */
export async function organizationForDeployment(deploymentId: string): Promise<Record<string, unknown>> {
  const live = await liveDeployment(deploymentId);
  if (!live) throw new DeploymentError("DEPLOYMENT_RETIRED", "This deployment has been retired.", 403);
  const publishers = await rawQuery<{ key_id: string; hosting: string; registered_at: Date }>(
    `SELECT key_id, hosting, registered_at FROM publishers WHERE account_id = $1 AND retired_at IS NULL ORDER BY registered_at DESC`,
    [live.organization_id]
  );
  // The allowance on its spend, where an admin set one: what it may spend of
  // the organization's owls, and what is left, for it to tell its agents.
  const [spend] = await rawQuery<{ allowance: string | null; spent: string }>(
    `SELECT allowance_micro_usd AS allowance, allowance_spent_micro_usd AS spent
       FROM organization_grants WHERE deployment_id = $1 AND permission = 'spend' AND withdrawn_at IS NULL LIMIT 1`,
    [live.id]
  );
  return {
    organization: { id: live.organization_id, name: live.organization_name, external_id: live.organization_external_id },
    deployment: {
      id: live.id,
      name: live.name,
      hosting: live.hosting,
      key_id: live.key_id,
      approved_at: new Date(live.approved_at).toISOString(),
      grants: live.grants,
      allowance:
        spend && spend.allowance !== null
          ? {
              allowance_micro_usd: Number(spend.allowance),
              spent_micro_usd: Number(spend.spent),
              left_micro_usd: Math.max(0, Number(spend.allowance) - Number(spend.spent)),
            }
          : null,
    },
    publisher_registrations: publishers.map((p) => ({ key_id: p.key_id, hosting: p.hosting, registered_at: new Date(p.registered_at).toISOString() })),
  };
}

/** An organization's deployments, live and retired, for its members. */
export async function listDeployments(organizationId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<{
    id: string; name: string; hosting: string; key_id: string; approved_at: Date; approved_by: string | null;
    retired_at: Date | null; grants: string[]; last_write: Date | null; address: string | null;
  }>(
    `SELECT d.id, d.name, d.hosting, d.key_id, d.address, d.approved_at, a.display_name AS approved_by, d.retired_at,
            COALESCE((SELECT array_agg(g.permission ORDER BY g.permission) FROM organization_grants g WHERE g.deployment_id = d.id AND g.withdrawn_at IS NULL), '{}') AS grants,
            (SELECT max(r.at) FROM deployment_requests r WHERE r.deployment_id = d.id) AS last_write
       FROM deployments d LEFT JOIN contributors a ON a.id = d.approved_by
      WHERE d.organization_id = $1
      ORDER BY d.retired_at IS NOT NULL, d.approved_at DESC`,
    [organizationId]
  );
  const recent = await rawQuery<{ deployment_id: string; method: string; route: string; status: number; at: Date }>(
    `SELECT r.deployment_id, r.method, r.route, r.status, r.at FROM deployment_requests r
       JOIN deployments d ON d.id = r.deployment_id
      WHERE d.organization_id = $1 ORDER BY r.at DESC LIMIT 100`,
    [organizationId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hosting: r.hosting,
    hosting_words: HOSTING_WORDS[r.hosting as keyof typeof HOSTING_WORDS] ?? r.hosting,
    key_id: r.key_id,
    address: r.address,
    approved_at: new Date(r.approved_at).toISOString(),
    approved_by: r.approved_by,
    retired_at: r.retired_at ? new Date(r.retired_at).toISOString() : null,
    grants: r.grants,
    last_write_at: r.last_write ? new Date(r.last_write).toISOString() : null,
    recent_writes: recent
      .filter((w) => w.deployment_id === r.id)
      .slice(0, 20)
      .map((w) => ({ method: w.method, route: w.route, status: w.status, at: new Date(w.at).toISOString() })),
  }));
}
