/**
 * Organizations on minerval.ai (docs/organizations.md, "Organizations on
 * minerval.ai"; #1118).
 *
 * An organization is a `contributors` row of kind 'organization', so every
 * table that names an account (the owl ledger, publishers, published pages,
 * usage reports received, mandates, contributions) works for it as it is.
 * Nobody signs in as one: its external id is `org:<id>`, which no sign-in
 * provider makes and POST /users/provision refuses. People act for it as
 * themselves, as its admins or members (organization_members).
 *
 * Every change is a row in organization_log, read by the organization's
 * members and by nobody else. An organization always has an admin: a change
 * that would leave it with none is refused, and the way back when every
 * admin's account is gone is the operator key.
 *
 * Changes to one organization's members run one at a time: each takes a
 * row lock on the organization's own row first, so two admins removing each
 * other at once cannot both succeed and leave it with none.
 */
import crypto from "node:crypto";
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { DEPLOYMENT_GRANTS, MEMBER_PERMISSIONS, type DeploymentGrant, type MemberPermission, type OrganizationRole } from "../db/schema.js";

/** The prefix of every organization's external id. No sign-in provider makes it. */
export const ORGANIZATION_EXTERNAL_PREFIX = "org:";
/** An invitation link's token. Only its hash is kept. */
export const INVITATION_PREFIX = "eoin_";
/** How long an invitation can be accepted. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NAME_MAX = 120;

const REASON =
  "Organizations say who acts for an account, so their rows are written on the owner's connection, as API keys are. The caller has been checked against the organization's members.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);
const inTransaction = <T>(fn: (tx: TxQuery) => Promise<T>): Promise<T> => asOwner(() => withTransaction(fn));

export class OrganizationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

const NOT_FOUND = () =>
  new OrganizationError("ORGANIZATION_NOT_FOUND", "No organization with that id, or you are not one of its members.", 404);
const ADMINS_ONLY = () =>
  new OrganizationError("ADMIN_REQUIRED", "Only an admin of this organization can do that.", 403);
const LAST_ADMIN = () =>
  new OrganizationError(
    "LAST_ADMIN",
    "An organization always has an admin. Make someone else an admin first.",
    409
  );

export interface OrganizationView {
  id: string;
  name: string;
  external_id: string;
  created_at: string;
  /** The person's own role in it, where the reader is a member. */
  role?: OrganizationRole;
  /**
   * What the reader may do as the organization: every member permission for
   * an admin, the ones they were granted for a member.
   */
  permissions?: MemberPermission[];
}

export interface MemberView {
  account_id: string;
  display_name: string;
  avatar_url: string | null;
  role: OrganizationRole;
  added_at: string;
  added_by: string | null;
  /** What they may do as the organization: every member permission for an admin. */
  permissions: MemberPermission[];
  /** Their live grants, each with its id, for withdrawing. Empty for an admin, who holds everything without one. */
  grants: GrantView[];
}

export interface GrantView {
  id: string;
  permission: MemberPermission | DeploymentGrant;
  account_id: string | null;
  deployment_id: string | null;
  granted_at: string;
  granted_by: string | null;
}

export interface InvitationView {
  id: string;
  role: OrganizationRole;
  made_at: string;
  made_by: string | null;
  expires_at: string;
  state: "open" | "accepted" | "cancelled" | "expired";
  accepted_by: string | null;
}

export interface LogEntry {
  id: string;
  at: string;
  kind: string;
  credential: "session" | "operator";
  actor: { id: string; display_name: string } | null;
  detail: Record<string, unknown>;
}

interface OrgRow {
  id: string;
  display_name: string;
  external_id: string;
  created_at: Date;
}

function view(row: OrgRow, role?: OrganizationRole, granted: readonly MemberPermission[] = []): OrganizationView {
  return {
    id: row.id,
    name: row.display_name,
    external_id: row.external_id,
    created_at: new Date(row.created_at).toISOString(),
    ...(role ? { role, permissions: role === "admin" ? [...MEMBER_PERMISSIONS] : [...granted] } : {}),
  };
}

/** A person's live member grants, by organization. */
async function grantedTo(accountId: string, organizationId?: string): Promise<Map<string, MemberPermission[]>> {
  const rows = await rawQuery<{ organization_id: string; permission: MemberPermission }>(
    `SELECT organization_id, permission FROM organization_grants
      WHERE account_id = $1 AND withdrawn_at IS NULL ${organizationId ? "AND organization_id = $2" : ""}
      ORDER BY permission`,
    organizationId ? [accountId, organizationId] : [accountId]
  );
  const by = new Map<string, MemberPermission[]>();
  for (const r of rows) by.set(r.organization_id, [...(by.get(r.organization_id) ?? []), r.permission]);
  return by;
}

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!n) throw new OrganizationError("NAME_REQUIRED", "Give the organization a name.", 422);
  if (n.length > NAME_MAX) {
    throw new OrganizationError("NAME_TOO_LONG", `A name is at most ${NAME_MAX} characters.`, 422);
  }
  return n;
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function hashInvitation(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether an external id is an organization's. */
export function isOrganizationExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(ORGANIZATION_EXTERNAL_PREFIX);
}

async function log(
  tx: TxQuery,
  entry: { organizationId: string; actorId: string | null; credential?: "session" | "operator"; kind: string; detail?: Record<string, unknown> }
): Promise<void> {
  await tx.query(
    `INSERT INTO organization_log (organization_id, actor_id, credential, kind, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entry.organizationId, entry.actorId, entry.credential ?? "session", entry.kind, JSON.stringify(entry.detail ?? {})]
  );
}

/** The account a person acts as must be a person's, live. */
async function requirePerson(q: { query: TxQuery["query"] }, accountId: string): Promise<{ id: string; display_name: string }> {
  const [row] = await q.query<{ id: string; display_name: string; kind: string; is_suspended: boolean }>(
    `SELECT id, display_name, kind, is_suspended FROM contributors WHERE id = $1`,
    [accountId]
  );
  if (!row || row.kind !== "person") {
    throw new OrganizationError("PERSON_REQUIRED", "Only a person's own account can do that.", 403);
  }
  if (row.is_suspended) throw new OrganizationError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  return row;
}

/** Lock the organization's row, so changes to its members run one at a time. */
async function lockOrganization(tx: TxQuery, organizationId: string): Promise<OrgRow> {
  if (!isUuid(organizationId)) throw NOT_FOUND();
  const [row] = await tx.query<OrgRow>(
    `SELECT id, display_name, external_id, created_at FROM contributors
      WHERE id = $1 AND kind = 'organization' FOR UPDATE`,
    [organizationId]
  );
  if (!row) throw NOT_FOUND();
  return row;
}

async function roleOf(q: { query: TxQuery["query"] }, organizationId: string, accountId: string): Promise<OrganizationRole | null> {
  const [row] = await q.query<{ role: OrganizationRole }>(
    `SELECT role FROM organization_members
      WHERE organization_id = $1 AND account_id = $2 AND removed_at IS NULL`,
    [organizationId, accountId]
  );
  return row?.role ?? null;
}

async function liveAdmins(tx: TxQuery, organizationId: string): Promise<number> {
  const [row] = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM organization_members m
       JOIN contributors c ON c.id = m.account_id
      WHERE m.organization_id = $1 AND m.role = 'admin' AND m.removed_at IS NULL AND NOT c.is_suspended`,
    [organizationId]
  );
  return Number(row?.n ?? 0);
}

// ---- making and reading ---------------------------------------------------

/** Make an organization. The person who makes it is its first admin. */
export async function createOrganization(input: { name: unknown; by: string }): Promise<OrganizationView> {
  const name = cleanName(input.name);
  return inTransaction(async (tx) => {
    await requirePerson(tx, input.by);
    const id = crypto.randomUUID();
    const [row] = await tx.query<OrgRow>(
      `INSERT INTO contributors (id, external_id, kind, display_name)
       VALUES ($1, $2, 'organization', $3)
       RETURNING id, display_name, external_id, created_at`,
      [id, `${ORGANIZATION_EXTERNAL_PREFIX}${id}`, name]
    );
    await tx.query(
      `INSERT INTO organization_members (organization_id, account_id, role, added_by) VALUES ($1, $2, 'admin', $2)`,
      [id, input.by]
    );
    await log(tx, { organizationId: id, actorId: input.by, kind: "created", detail: { name } });
    return view(row!, "admin");
  });
}

/** The organizations a person belongs to, with their role in each. */
export async function listMyOrganizations(accountId: string): Promise<OrganizationView[]> {
  const rows = await rawQuery<OrgRow & { role: OrganizationRole }>(
    `SELECT c.id, c.display_name, c.external_id, c.created_at, m.role
       FROM organization_members m JOIN contributors c ON c.id = m.organization_id
      WHERE m.account_id = $1 AND m.removed_at IS NULL AND c.kind = 'organization'
      ORDER BY c.display_name`,
    [accountId]
  );
  const granted = await grantedTo(accountId);
  return rows.map((r) => view(r, r.role, granted.get(r.id)));
}

/** One organization, for one of its members. Anyone else is told it does not exist. */
export async function getOrganization(organizationId: string, accountId: string): Promise<OrganizationView> {
  if (!isUuid(organizationId)) throw NOT_FOUND();
  const [row] = await rawQuery<OrgRow & { role: OrganizationRole }>(
    `SELECT c.id, c.display_name, c.external_id, c.created_at, m.role
       FROM contributors c JOIN organization_members m
         ON m.organization_id = c.id AND m.account_id = $2 AND m.removed_at IS NULL
      WHERE c.id = $1 AND c.kind = 'organization'`,
    [organizationId, accountId]
  );
  if (!row) throw NOT_FOUND();
  return view(row, row.role, (await grantedTo(accountId, organizationId)).get(organizationId));
}

/** The reader's role, or a refusal that says the organization does not exist. */
export async function requireMember(organizationId: string, accountId: string): Promise<OrganizationRole> {
  return (await getOrganization(organizationId, accountId)).role!;
}

export async function renameOrganization(input: { organizationId: string; name: unknown; by: string }): Promise<OrganizationView> {
  const name = cleanName(input.name);
  return inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const role = await roleOf(tx, org.id, input.by);
    if (!role) throw NOT_FOUND();
    if (role !== "admin") throw ADMINS_ONLY();
    if (name === org.display_name) return view(org, role);
    await tx.query(`UPDATE contributors SET display_name = $2 WHERE id = $1`, [org.id, name]);
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "renamed", detail: { from: org.display_name, to: name } });
    return view({ ...org, display_name: name }, role);
  });
}

// ---- members ----------------------------------------------------------------

export async function listMembers(organizationId: string, readerId: string): Promise<MemberView[]> {
  await requireMember(organizationId, readerId);
  const rows = await rawQuery<{
    account_id: string; display_name: string; avatar_url: string | null; role: OrganizationRole; added_at: Date; added_by: string | null;
  }>(
    `SELECT m.account_id, c.display_name, c.avatar_url, m.role, m.added_at, a.display_name AS added_by
       FROM organization_members m
       JOIN contributors c ON c.id = m.account_id
       LEFT JOIN contributors a ON a.id = m.added_by
      WHERE m.organization_id = $1 AND m.removed_at IS NULL
      ORDER BY (m.role = 'admin') DESC, c.display_name`,
    [organizationId]
  );
  const grants = await liveGrants(organizationId);
  return rows.map((r) => {
    const own = grants.filter((g) => g.account_id === r.account_id);
    return {
      ...r,
      added_at: new Date(r.added_at).toISOString(),
      permissions: r.role === "admin" ? [...MEMBER_PERMISSIONS] : own.map((g) => g.permission as MemberPermission),
      grants: r.role === "admin" ? [] : own,
    };
  });
}

/** Make a member an admin, or an admin a member. Refused where it would leave no admin. */
export async function setRole(input: { organizationId: string; accountId: string; role: OrganizationRole; by: string }): Promise<MemberView[]> {
  if (input.role !== "admin" && input.role !== "member") {
    throw new OrganizationError("BAD_ROLE", "A role is admin or member.", 422);
  }
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    const current = await roleOf(tx, org.id, input.accountId);
    if (!current) throw new OrganizationError("NOT_A_MEMBER", "That person is not a member of this organization.", 404);
    if (current === input.role) return;
    if (current === "admin" && (await liveAdmins(tx, org.id)) <= 1) throw LAST_ADMIN();
    await tx.query(
      `UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [org.id, input.accountId, input.role]
    );
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "role_changed", detail: { account_id: input.accountId, from: current, to: input.role } });
    // An admin holds every permission without a grant; one made a member again starts from none.
    if (input.role === "admin") await withdrawAllOf(tx, { organizationId: org.id, accountId: input.accountId, by: input.by });
  });
  return listMembers(input.organizationId, input.by);
}

/**
 * Take a person out of an organization. An admin can remove anyone; anyone
 * can remove themselves (leave). Refused where it would leave no admin.
 */
export async function removeMember(input: { organizationId: string; accountId: string; by: string }): Promise<void> {
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    const leaving = input.accountId === input.by;
    if (!leaving && byRole !== "admin") throw ADMINS_ONLY();
    const current = await roleOf(tx, org.id, input.accountId);
    if (!current) throw new OrganizationError("NOT_A_MEMBER", "That person is not a member of this organization.", 404);
    if (current === "admin" && (await liveAdmins(tx, org.id)) <= 1) throw LAST_ADMIN();
    await tx.query(
      `UPDATE organization_members SET removed_at = now(), removed_by = $3
        WHERE organization_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [org.id, input.accountId, input.by]
    );
    await log(tx, { organizationId: org.id, actorId: input.by, kind: leaving ? "left" : "removed", detail: { account_id: input.accountId, role: current } });
    await withdrawAllOf(tx, { organizationId: org.id, accountId: input.accountId, by: input.by });
  });
}

/**
 * The way back for an organization whose admins are all gone: the operator
 * key makes a person an admin. Logged as made with the operator key.
 */
export async function operatorAddAdmin(input: { organizationId: string; accountId: string }): Promise<void> {
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    await requirePerson(tx, input.accountId);
    const current = await roleOf(tx, org.id, input.accountId);
    if (current === "admin") return;
    if (current) {
      await tx.query(
        `UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [org.id, input.accountId]
      );
    } else {
      await tx.query(
        `INSERT INTO organization_members (organization_id, account_id, role, added_by) VALUES ($1, $2, 'admin', NULL)`,
        [org.id, input.accountId]
      );
    }
    await log(tx, { organizationId: org.id, actorId: null, credential: "operator", kind: "admin_added_by_operator", detail: { account_id: input.accountId } });
  });
}

// ---- invitations ------------------------------------------------------------

/** Make a single-use link that adds a person with the role it names. The token is returned once. */
export async function makeInvitation(input: { organizationId: string; role: OrganizationRole; by: string }): Promise<{ invitation: InvitationView; token: string }> {
  if (input.role !== "admin" && input.role !== "member") {
    throw new OrganizationError("BAD_ROLE", "A role is admin or member.", 422);
  }
  const token = INVITATION_PREFIX + crypto.randomBytes(24).toString("base64url");
  const invitation = await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO organization_invitations (organization_id, role, token_hash, made_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval) RETURNING id`,
      [org.id, input.role, hashInvitation(token), input.by, String(INVITATION_TTL_MS)]
    );
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "invited", detail: { invitation_id: row!.id, role: input.role } });
    return row!.id;
  });
  const [made] = (await listInvitations(input.organizationId, input.by)).filter((i) => i.id === invitation);
  return { invitation: made!, token };
}

export async function listInvitations(organizationId: string, readerId: string): Promise<InvitationView[]> {
  await requireMember(organizationId, readerId);
  const rows = await rawQuery<{
    id: string; role: OrganizationRole; made_at: Date; made_by: string | null; expires_at: Date;
    accepted_at: Date | null; cancelled_at: Date | null; accepted_by: string | null;
  }>(
    `SELECT i.id, i.role, i.made_at, m.display_name AS made_by, i.expires_at, i.accepted_at, i.cancelled_at,
            a.display_name AS accepted_by
       FROM organization_invitations i
       LEFT JOIN contributors m ON m.id = i.made_by
       LEFT JOIN contributors a ON a.id = i.accepted_by
      WHERE i.organization_id = $1
      ORDER BY i.made_at DESC
      LIMIT 100`,
    [organizationId]
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    made_at: new Date(r.made_at).toISOString(),
    made_by: r.made_by,
    expires_at: new Date(r.expires_at).toISOString(),
    accepted_by: r.accepted_by,
    state: r.accepted_at ? "accepted" : r.cancelled_at ? "cancelled" : new Date(r.expires_at).getTime() <= now ? "expired" : "open",
  }));
}

export async function cancelInvitation(input: { organizationId: string; invitationId: string; by: string }): Promise<void> {
  if (!isUuid(input.invitationId)) throw new OrganizationError("INVITATION_NOT_FOUND", "No such invitation.", 404);
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    const rows = await tx.query<{ id: string }>(
      `UPDATE organization_invitations SET cancelled_at = now(), cancelled_by = $3
        WHERE id = $2 AND organization_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL
        RETURNING id`,
      [org.id, input.invitationId, input.by]
    );
    if (!rows.length) throw new OrganizationError("INVITATION_NOT_OPEN", "That invitation is not open.", 409);
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "invitation_cancelled", detail: { invitation_id: input.invitationId } });
  });
}

/** What an invitation link is for, shown to the signed-in person who opened it before they accept. */
export async function readInvitation(token: string): Promise<{ organization: { id: string; name: string }; role: OrganizationRole; state: InvitationView["state"]; expires_at: string }> {
  const [row] = await rawQuery<{
    organization_id: string; name: string; role: OrganizationRole; expires_at: Date; accepted_at: Date | null; cancelled_at: Date | null;
  }>(
    `SELECT i.organization_id, c.display_name AS name, i.role, i.expires_at, i.accepted_at, i.cancelled_at
       FROM organization_invitations i JOIN contributors c ON c.id = i.organization_id
      WHERE i.token_hash = $1`,
    [hashInvitation(token)]
  );
  if (!row) throw new OrganizationError("INVITATION_NOT_FOUND", "This invitation link is not one Minerval made.", 404);
  return {
    organization: { id: row.organization_id, name: row.name },
    role: row.role,
    expires_at: new Date(row.expires_at).toISOString(),
    state: row.accepted_at ? "accepted" : row.cancelled_at ? "cancelled" : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "open",
  };
}

/** Accept an invitation as oneself. Single use, and only while it is open. */
export async function acceptInvitation(input: { token: string; by: string }): Promise<OrganizationView> {
  const organizationId = await inTransaction(async (tx) => {
    const [inv] = await tx.query<{ id: string; organization_id: string; role: OrganizationRole; expires_at: Date; accepted_at: Date | null; cancelled_at: Date | null }>(
      `SELECT id, organization_id, role, expires_at, accepted_at, cancelled_at FROM organization_invitations WHERE token_hash = $1`,
      [hashInvitation(input.token)]
    );
    if (!inv) throw new OrganizationError("INVITATION_NOT_FOUND", "This invitation link is not one Minerval made.", 404);
    const org = await lockOrganization(tx, inv.organization_id);
    // Re-read under the organization's lock: two people opening one link at once cannot both use it.
    const [fresh] = await tx.query<{ accepted_at: Date | null; cancelled_at: Date | null }>(
      `SELECT accepted_at, cancelled_at FROM organization_invitations WHERE id = $1`,
      [inv.id]
    );
    if (fresh!.accepted_at) throw new OrganizationError("INVITATION_USED", "This invitation has already been used.", 409);
    if (fresh!.cancelled_at) throw new OrganizationError("INVITATION_CANCELLED", "An admin cancelled this invitation.", 409);
    if (new Date(inv.expires_at).getTime() <= Date.now()) {
      throw new OrganizationError("INVITATION_EXPIRED", "This invitation has expired. Ask an admin for a new one.", 409);
    }
    await requirePerson(tx, input.by);
    if (await roleOf(tx, org.id, input.by)) {
      throw new OrganizationError("ALREADY_A_MEMBER", "You are already a member of this organization.", 409);
    }
    await tx.query(
      `INSERT INTO organization_members (organization_id, account_id, role, added_by)
       SELECT $1, $2, $3, made_by FROM organization_invitations WHERE id = $4`,
      [org.id, input.by, inv.role, inv.id]
    );
    await tx.query(`UPDATE organization_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, input.by]);
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "joined", detail: { invitation_id: inv.id, role: inv.role } });
    return org.id;
  });
  return getOrganization(organizationId, input.by);
}

// ---- the log ------------------------------------------------------------------

export async function listLog(organizationId: string, readerId: string, limit = 100): Promise<LogEntry[]> {
  await requireMember(organizationId, readerId);
  const rows = await rawQuery<{
    id: string; created_at: Date; kind: string; credential: "session" | "operator"; actor_id: string | null; actor_name: string | null; detail: Record<string, unknown>;
  }>(
    `SELECT l.id, l.created_at, l.kind, l.credential, l.actor_id, a.display_name AS actor_name, l.detail
       FROM organization_log l LEFT JOIN contributors a ON a.id = l.actor_id
      WHERE l.organization_id = $1
      ORDER BY l.created_at DESC, l.id
      LIMIT $2`,
    [organizationId, Math.max(1, Math.min(500, limit))]
  );
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.created_at).toISOString(),
    kind: r.kind,
    credential: r.credential,
    actor: r.actor_id ? { id: r.actor_id, display_name: r.actor_name ?? "" } : null,
    detail: r.detail ?? {},
  }));
}

/**
 * An act a person made as the organization (docs/organizations.md, "Acting
 * as the organization"): which route, and what the API answered. Written
 * after the response, so it records what happened.
 */
export async function logActedAs(entry: { organizationId: string; actorId: string; method: string; route: string; status: number }): Promise<void> {
  await inTransaction((tx) =>
    log(tx, {
      organizationId: entry.organizationId,
      actorId: entry.actorId,
      kind: "acted",
      detail: { method: entry.method, route: entry.route, status: entry.status },
    })
  );
}

/** Whether a person is a live admin of an organization right now. */
export async function isLiveAdmin(organizationId: string, accountId: string): Promise<boolean> {
  if (!isUuid(organizationId)) return false;
  const [row] = await rawQuery<{ ok: boolean }>(
    `SELECT true AS ok FROM organization_members m JOIN contributors c ON c.id = m.organization_id
      WHERE m.organization_id = $1 AND m.account_id = $2 AND m.role = 'admin' AND m.removed_at IS NULL
        AND c.kind = 'organization' AND NOT c.is_suspended`,
    [organizationId, accountId]
  );
  return Boolean(row?.ok);
}

// ---- grants ------------------------------------------------------------------
//
// What an organization grants its members and its deployments, from one list
// (docs/organizations.md, "What an organization grants"). Admins grant and
// withdraw; every member reads them. Each change is on the log.

interface GrantRow {
  id: string;
  permission: MemberPermission | DeploymentGrant;
  account_id: string | null;
  deployment_id: string | null;
  granted_at: Date;
  granted_by: string | null;
}

function grantView(r: GrantRow): GrantView {
  return { ...r, granted_at: new Date(r.granted_at).toISOString() };
}

async function liveGrants(organizationId: string): Promise<GrantView[]> {
  const rows = await rawQuery<GrantRow>(
    `SELECT g.id, g.permission, g.account_id, g.deployment_id, g.granted_at, b.display_name AS granted_by
       FROM organization_grants g LEFT JOIN contributors b ON b.id = g.granted_by
      WHERE g.organization_id = $1 AND g.withdrawn_at IS NULL
      ORDER BY g.granted_at`,
    [organizationId]
  );
  return rows.map(grantView);
}

/** An organization's live grants, to its members and its deployments (its members only). */
export async function listGrants(organizationId: string, readerId: string): Promise<GrantView[]> {
  await requireMember(organizationId, readerId);
  return liveGrants(organizationId);
}

async function withdrawAllOf(tx: TxQuery, input: { organizationId: string; accountId: string; by: string }): Promise<void> {
  const withdrawn = await tx.query<{ permission: string }>(
    `UPDATE organization_grants SET withdrawn_at = now(), withdrawn_by = $3
      WHERE organization_id = $1 AND account_id = $2 AND withdrawn_at IS NULL
      RETURNING permission`,
    [input.organizationId, input.accountId, input.by]
  );
  if (withdrawn.length > 0) {
    await log(tx, {
      organizationId: input.organizationId,
      actorId: input.by,
      kind: "grants_withdrawn",
      detail: { account_id: input.accountId, permissions: withdrawn.map((w) => w.permission) },
    });
  }
}

/**
 * Give a member or a deployment a permission (admins). A member can be given
 * a member permission, a deployment a deployment one. An admin is given
 * nothing: they hold every member permission already. Giving one already
 * held changes nothing.
 */
export async function grantPermission(input: {
  organizationId: string;
  permission: unknown;
  accountId?: string | null;
  deploymentId?: string | null;
  by: string;
}): Promise<GrantView[]> {
  const toMember = typeof input.accountId === "string" && input.accountId !== "";
  const toDeployment = typeof input.deploymentId === "string" && input.deploymentId !== "";
  if (toMember === toDeployment) {
    throw new OrganizationError("GRANTEE_REQUIRED", "Name one member (account_id) or one deployment (deployment_id).", 422);
  }
  const allowed: readonly string[] = toMember ? MEMBER_PERMISSIONS : DEPLOYMENT_GRANTS;
  if (typeof input.permission !== "string" || !allowed.includes(input.permission)) {
    throw new OrganizationError(
      "BAD_PERMISSION",
      `A ${toMember ? "member" : "deployment"} can be given ${allowed.join(", ")}.`,
      422
    );
  }
  const permission = input.permission;
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    if (toMember) {
      const role = await roleOf(tx, org.id, input.accountId!);
      if (!role) throw new OrganizationError("NOT_A_MEMBER", "That person is not a member of this organization.", 404);
      if (role === "admin") {
        throw new OrganizationError("ADMIN_HOLDS_ALL", "An admin holds every permission already.", 409);
      }
    } else {
      if (!isUuid(input.deploymentId!)) throw new OrganizationError("NOT_A_DEPLOYMENT", "No live deployment of this organization has that id.", 404);
      const [dep] = await tx.query<{ id: string }>(
        `SELECT id FROM deployments WHERE id = $1 AND organization_id = $2 AND retired_at IS NULL`,
        [input.deploymentId, org.id]
      );
      if (!dep) throw new OrganizationError("NOT_A_DEPLOYMENT", "No live deployment of this organization has that id.", 404);
    }
    const added = await tx.query<{ id: string }>(
      `INSERT INTO organization_grants (organization_id, account_id, deployment_id, permission, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [org.id, toMember ? input.accountId : null, toDeployment ? input.deploymentId : null, permission, input.by]
    );
    if (added.length > 0) {
      await log(tx, {
        organizationId: org.id,
        actorId: input.by,
        kind: "granted",
        detail: { permission, ...(toMember ? { account_id: input.accountId } : { deployment_id: input.deploymentId }) },
      });
    }
  });
  return liveGrants(input.organizationId);
}

/** Withdraw a live grant (admins). It stops working at the grantee's next request. */
export async function withdrawGrant(input: { organizationId: string; grantId: string; by: string }): Promise<GrantView[]> {
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    if (!isUuid(input.grantId)) throw new OrganizationError("GRANT_NOT_FOUND", "No live grant of this organization has that id.", 404);
    const [row] = await tx.query<{ permission: string; account_id: string | null; deployment_id: string | null }>(
      `UPDATE organization_grants SET withdrawn_at = now(), withdrawn_by = $3
        WHERE id = $1 AND organization_id = $2 AND withdrawn_at IS NULL
        RETURNING permission, account_id, deployment_id`,
      [input.grantId, org.id, input.by]
    );
    if (!row) throw new OrganizationError("GRANT_NOT_FOUND", "No live grant of this organization has that id.", 404);
    await log(tx, {
      organizationId: org.id,
      actorId: input.by,
      kind: "withdrew",
      detail: { permission: row.permission, ...(row.account_id ? { account_id: row.account_id } : { deployment_id: row.deployment_id }) },
    });
  });
  return liveGrants(input.organizationId);
}

/**
 * A person's standing in an organization right now, for acting as it: their
 * role and live permissions, or null where they are not a live member of a
 * live organization.
 */
export async function memberStanding(
  organizationId: string,
  accountId: string
): Promise<{ role: OrganizationRole; permissions: MemberPermission[] } | null> {
  if (!isUuid(organizationId)) return null;
  const [row] = await rawQuery<{ role: OrganizationRole; permissions: MemberPermission[] }>(
    `SELECT m.role,
            COALESCE(array_agg(g.permission ORDER BY g.permission) FILTER (WHERE g.id IS NOT NULL), '{}') AS permissions
       FROM organization_members m
       JOIN contributors c ON c.id = m.organization_id AND c.kind = 'organization' AND NOT c.is_suspended
       LEFT JOIN organization_grants g
         ON g.organization_id = m.organization_id AND g.account_id = m.account_id AND g.withdrawn_at IS NULL
      WHERE m.organization_id = $1 AND m.account_id = $2 AND m.removed_at IS NULL
      GROUP BY m.role`,
    [organizationId, accountId]
  );
  return row ?? null;
}

// ---- old keys -------------------------------------------------------------

export interface OldKeyView {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * The API keys an organization's account holds. An organization cannot
 * mint one; these are left from a shared login it was converted from, and
 * can do anything the organization can. Listed so the admins can see when
 * nothing uses them any more, and revoke them.
 */
export async function listOldKeys(organizationId: string, readerId: string): Promise<OldKeyView[]> {
  await requireMember(organizationId, readerId);
  const rows = await rawQuery<{ id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null }>(
    `SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [organizationId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    key_prefix: r.key_prefix,
    created_at: new Date(r.created_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  }));
}

export async function revokeOldKey(input: { organizationId: string; keyId: string; by: string }): Promise<void> {
  if (!isUuid(input.keyId)) throw new OrganizationError("KEY_NOT_FOUND", "No such key.", 404);
  await inTransaction(async (tx) => {
    const org = await lockOrganization(tx, input.organizationId);
    const byRole = await roleOf(tx, org.id, input.by);
    if (!byRole) throw NOT_FOUND();
    if (byRole !== "admin") throw ADMINS_ONLY();
    const rows = await tx.query<{ key_prefix: string }>(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL RETURNING key_prefix`,
      [org.id, input.keyId]
    );
    if (!rows.length) throw new OrganizationError("KEY_NOT_FOUND", "No live key with that id belongs to this organization.", 404);
    await log(tx, { organizationId: org.id, actorId: input.by, kind: "old_key_revoked", detail: { key_id: input.keyId, key_prefix: rows[0]!.key_prefix } });
  });
}

// ---- converting a shared account ------------------------------------------

export interface ConversionView {
  id: string;
  account: { id: string; display_name: string };
  name: string;
  first_admin: { id: string; display_name: string };
  asked_at: string;
  /** What the account keeps, so the person deciding can see it. */
  keeps: { live_api_keys: number; publishers: number; published_pages: number };
}

async function conversionView(id: string): Promise<ConversionView | null> {
  const [row] = await rawQuery<{
    id: string; account_id: string; account_name: string; name: string; first_admin_id: string; first_admin_name: string; asked_at: Date;
    keys: string; publishers: string; pages: string;
  }>(
    `SELECT v.id, v.account_id, a.display_name AS account_name, v.name, v.first_admin_id, f.display_name AS first_admin_name, v.asked_at,
            (SELECT count(*) FROM api_keys k WHERE k.user_id = v.account_id AND k.revoked_at IS NULL)::text AS keys,
            (SELECT count(*) FROM publishers p WHERE p.account_id = v.account_id)::text AS publishers,
            (SELECT count(*) FROM published_pages g WHERE g.account_id = v.account_id)::text AS pages
       FROM account_conversions v
       JOIN contributors a ON a.id = v.account_id
       JOIN contributors f ON f.id = v.first_admin_id
      WHERE v.id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: row.id,
    account: { id: row.account_id, display_name: row.account_name },
    name: row.name,
    first_admin: { id: row.first_admin_id, display_name: row.first_admin_name },
    asked_at: new Date(row.asked_at).toISOString(),
    keeps: { live_api_keys: Number(row.keys), publishers: Number(row.publishers), published_pages: Number(row.pages) },
  };
}

/**
 * A shared login asks to become an organization, naming the person who is to
 * be its first admin. Nothing changes until that person accepts.
 */
export async function askConversion(input: { accountId: string; name: unknown; firstAdminId: string }): Promise<ConversionView> {
  const name = cleanName(input.name);
  if (!isUuid(input.firstAdminId)) {
    throw new OrganizationError("FIRST_ADMIN_NOT_FOUND", "Name the first admin by their account id, from their contributor page.", 404);
  }
  if (input.firstAdminId === input.accountId) {
    throw new OrganizationError(
      "FIRST_ADMIN_IS_THIS_ACCOUNT",
      "The first admin must be a person's own account, not the account being converted.",
      422
    );
  }
  const id = await inTransaction(async (tx) => {
    await requirePerson(tx, input.accountId);
    const [admin] = await tx.query<{ kind: string; is_suspended: boolean }>(
      `SELECT kind, is_suspended FROM contributors WHERE id = $1`,
      [input.firstAdminId]
    );
    if (!admin || admin.kind !== "person" || admin.is_suspended) {
      throw new OrganizationError("FIRST_ADMIN_NOT_FOUND", "The first admin must be a person's own account on Minerval.", 404);
    }
    await tx.query(
      `UPDATE account_conversions SET cancelled_at = now() WHERE account_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL`,
      [input.accountId]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO account_conversions (account_id, name, first_admin_id) VALUES ($1, $2, $3) RETURNING id`,
      [input.accountId, name, input.firstAdminId]
    );
    return row!.id;
  });
  return (await conversionView(id))!;
}

/** The account's open request to become an organization, if any. */
export async function getOpenConversion(accountId: string): Promise<ConversionView | null> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM account_conversions WHERE account_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL`,
    [accountId]
  );
  return row ? conversionView(row.id) : null;
}

export async function cancelConversion(accountId: string): Promise<void> {
  await asOwner(() =>
    rawQuery(
      `UPDATE account_conversions SET cancelled_at = now() WHERE account_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL`,
      [accountId]
    )
  );
}

/** The open requests that name this person as first admin. */
export async function listConversionsForMe(accountId: string): Promise<ConversionView[]> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM account_conversions WHERE first_admin_id = $1 AND accepted_at IS NULL AND cancelled_at IS NULL ORDER BY asked_at`,
    [accountId]
  );
  const views = await Promise.all(rows.map((r) => conversionView(r.id)));
  return views.filter((v): v is ConversionView => v !== null);
}

/**
 * The named first admin accepts, from their own session. In one transaction
 * the account becomes the organization: its kind and external id change, so
 * the shared login no longer reaches it (signing in with it again makes a
 * new, empty person account); its email and avatar, which were the shared
 * login's, are cleared; its OAuth tokens, each a person's consent, are
 * revoked. Its id, and so its record, pages, owls and API keys, stay.
 */
export async function acceptConversion(input: { conversionId: string; by: string }): Promise<OrganizationView> {
  if (!isUuid(input.conversionId)) throw new OrganizationError("CONVERSION_NOT_FOUND", "No such request.", 404);
  const orgId = await inTransaction(async (tx) => {
    const [conv] = await tx.query<{ id: string; account_id: string; name: string; first_admin_id: string; accepted_at: Date | null; cancelled_at: Date | null }>(
      `SELECT id, account_id, name, first_admin_id, accepted_at, cancelled_at FROM account_conversions WHERE id = $1 FOR UPDATE`,
      [input.conversionId]
    );
    if (!conv || conv.first_admin_id !== input.by) {
      throw new OrganizationError("CONVERSION_NOT_FOUND", "No request names you as first admin with that id.", 404);
    }
    if (conv.accepted_at || conv.cancelled_at) {
      throw new OrganizationError("CONVERSION_NOT_OPEN", "That request is no longer open.", 409);
    }
    await requirePerson(tx, input.by);
    const [acct] = await tx.query<{ kind: string; external_id: string | null }>(
      `SELECT kind, external_id FROM contributors WHERE id = $1 FOR UPDATE`,
      [conv.account_id]
    );
    if (!acct || acct.kind !== "person") {
      throw new OrganizationError("CONVERSION_NOT_OPEN", "That account is no longer a person's account.", 409);
    }
    await tx.query(
      `UPDATE contributors SET kind = 'organization', external_id = $2, display_name = $3, email = NULL, avatar_url = NULL
        WHERE id = $1`,
      [conv.account_id, `${ORGANIZATION_EXTERNAL_PREFIX}${conv.account_id}`, conv.name]
    );
    await tx.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [conv.account_id]);
    await tx.query(
      `INSERT INTO organization_members (organization_id, account_id, role, added_by) VALUES ($1, $2, 'admin', NULL)`,
      [conv.account_id, input.by]
    );
    await tx.query(`UPDATE account_conversions SET accepted_at = now() WHERE id = $1`, [conv.id]);
    await log(tx, {
      organizationId: conv.account_id,
      actorId: input.by,
      kind: "converted",
      detail: { from_external_id: acct.external_id, name: conv.name },
    });
    return conv.account_id;
  });
  return getOrganization(orgId, input.by);
}

