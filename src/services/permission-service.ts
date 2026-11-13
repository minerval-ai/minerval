/**
 * Permission grants, and the standing they add up to (src/permissions.ts).
 *
 * `permission_grants` is state and log in one: a row is a grant, the same
 * row later records its removal, and no row is ever deleted or rewritten.
 * Everything here is used only by a members-only deployment. On the public
 * graph the tables are empty and nothing calls this.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { loadConfig } from "../config.js";
import { PUBLIC_LABEL } from "../labels.js";
import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
  PUBLIC_STANDING,
  isPermissionName,
  membersOnly,
  type HeldGrant,
  type PermissionName,
  type Standing,
} from "../permissions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

/**
 * Serializes the two decisions that count administrators: establishing the
 * first one, and removing one. Both read "how many are there" and then
 * write, so they take this lock for their transaction.
 */
const ADMINISTRATOR_LOCK = `SELECT pg_advisory_xact_lock(hashtext('minerval:administrators'))`;

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

// ---- standing ---------------------------------------------------------------

/**
 * Every label readable from `labels`: the labels themselves, and each label
 * one of them reads, followed through label_reads to the end. `public` is
 * always in the answer. Sorted.
 *
 * The answer is the database's (minerval_labels_readable_from), which is
 * also what a run's label is turned into a clearance with
 * (db/clearance.ts): one definition of what a label reads, for people and
 * for runs.
 */
export async function labelsReadableFrom(labels: readonly string[]): Promise<string[]> {
  const start = [...new Set([PUBLIC_LABEL, ...labels])];
  if (start.length === 1) return start;
  const [row] = await rawQuery<{ labels: string[] }>(
    `SELECT minerval_labels_readable_from($1::text[]) AS labels`,
    [start]
  );
  return [...new Set(row?.labels ?? start)].sort();
}

/**
 * What an account may do and read now: the live grants made to it, the live
 * grants made to a group its latest sign-in carried (while that sign-in
 * still vouches for the group), and the clearance the reading grants add
 * up to. An account with no live grant gets the public standing.
 */
export async function resolveStanding(accountId: string): Promise<Standing> {
  const validHours = loadConfig().signInValidHours ?? 12;
  const groups = (
    await rawQuery<{ group_name: string }>(
      `SELECT group_name FROM account_groups
        WHERE account_id = $1
          AND asserted_at > now() - ($2::double precision * interval '1 hour')
        ORDER BY group_name`,
      [accountId, validHours]
    )
  ).map((r) => r.group_name);

  const rows = await rawQuery<{
    permission: string;
    label: string | null;
    party_id: string | null;
    group_name: string | null;
  }>(
    `SELECT permission, label, party_id, group_name
       FROM permission_grants
      WHERE removed_at IS NULL
        AND (account_id = $1 OR group_name = ANY($2::text[]))
      ORDER BY granted_at, id`,
    [accountId, groups]
  );
  const grants: HeldGrant[] = rows
    .filter((r) => isPermissionName(r.permission))
    .map((r) => ({
      permission: r.permission as PermissionName,
      label: r.label,
      partyId: r.party_id,
      group: r.group_name,
    }));
  if (grants.length === 0) return { ...PUBLIC_STANDING, groups };

  const readAt = grants.filter((g) => g.permission === "read" && g.label).map((g) => g.label!);
  const rawAt = grants
    .filter((g) => g.permission === "read_sources" && g.label)
    .map((g) => g.label!);
  return {
    member: true,
    grants,
    clearance: await labelsReadableFrom(readAt),
    rawSourceLabels: [...new Set([PUBLIC_LABEL, ...rawAt])].sort(),
    groups,
  };
}

// ---- sign-in ----------------------------------------------------------------

/** Group names as stored: trimmed, non-empty, each once. */
export function cleanGroupNames(groups: readonly unknown[]): string[] {
  const names = groups
    .filter((g): g is string => typeof g === "string")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  return [...new Set(names)];
}

/**
 * Replace the groups an account's sign-in carried. Called at each sign-in
 * that names groups, with all of them: a group the sign-in no longer
 * carries is gone, and each one it does carry is vouched for as of now.
 */
export async function recordSignInGroups(accountId: string, groups: readonly unknown[]): Promise<string[]> {
  const names = cleanGroupNames(groups);
  // The tables that say what a clearance is (the grants, these groups, the
  // labels) can be read on a connection held to a clearance and written
  // only on the owner's (db/clearance.ts): a connection that reads `public`
  // alone must not be able to widen what anyone reads.
  await withSystemClearance(
    "The groups a verified sign-in carried decide what the account may read, so they are written on the owner's connection.",
    () =>
      withTransaction(async (tx) => {
        await tx.query(`DELETE FROM account_groups WHERE account_id = $1`, [accountId]);
        if (names.length > 0) {
          await tx.query(
            `INSERT INTO account_groups (account_id, group_name)
             SELECT $1, unnest($2::text[])`,
            [accountId, names]
          );
        }
      })
  );
  return names;
}

/**
 * Establish the deployment's first administrator, if this sign-in is the one
 * the FIRST_ADMINISTRATOR setting names and the deployment has never had an
 * administrator.
 *
 * The setting is used once. "Never had" counts removed grants too, so once
 * any administrator has existed the setting does nothing, whatever it says:
 * a person the administrators later removed cannot come back by signing in
 * again, and a stale setting grants no one anything. The way back in for a
 * deployment that has lost its administrators is the operator key
 * (grantAdministratorByOperator).
 *
 * The plan's rule is that the person who sets a deployment up holds every
 * permission and hands them out, so the grant is all of them: the three
 * with no scope, the two reading permissions at each label that exists
 * besides `public`, and release for each party that exists. Each is a row
 * marked as granted by the setting. Returns whether it granted.
 *
 * The organization itself is a party from this moment: the row is made here
 * if the deployment has none, under a placeholder name an administrator
 * replaces (party-service.ts, addParty). A part of a page that rests on no
 * outside party's material is the organization's to release
 * (services/showing-service.ts), so without this row and the grant for it
 * nobody could release anything until an administrator had thought to add
 * both.
 */
export const OWN_ORGANIZATION_SETUP_NAME = "This organization";

export async function establishFirstAdministrator(account: {
  id: string;
  externalId: string | null;
}): Promise<boolean> {
  const config = loadConfig();
  if (!membersOnly(config)) return false;
  const named = config.firstAdministrator ?? "";
  if (!named || !account.externalId || named !== account.externalId) return false;

  return withSystemClearance(
    "The first administrator's grants say what that account may read, so they are written on the owner's connection.",
    () => establish(account)
  );
}

function establish(account: { id: string; externalId: string | null }): Promise<boolean> {
  return withTransaction(async (tx) => {
    await tx.query(ADMINISTRATOR_LOCK);
    const ever = await tx.query(
      `SELECT 1 FROM permission_grants WHERE permission = 'administer' LIMIT 1`
    );
    if (ever.length > 0) return false;

    const insert = (permission: PermissionName, label: string | null, partyId: string | null) =>
      tx.query(
        `INSERT INTO permission_grants (permission, account_id, label, party_id, granted_via)
         VALUES ($1, $2, $3, $4, 'first_administrator')`,
        [permission, account.id, label, partyId]
      );
    for (const permission of PERMISSIONS) {
      if (PERMISSION_DEFINITIONS[permission].scope === "none") await insert(permission, null, null);
    }
    const labels = await tx.query<{ name: string }>(
      `SELECT name FROM labels WHERE name <> $1 ORDER BY name`,
      [PUBLIC_LABEL]
    );
    for (const { name } of labels) {
      await insert("read", name, null);
      await insert("read_sources", name, null);
    }
    const [own] = await tx.query<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    if (!own) {
      const [made] = await tx.query<{ id: string }>(
        `INSERT INTO parties (name, is_own_organization) VALUES ($1, true) RETURNING id`,
        [OWN_ORGANIZATION_SETUP_NAME]
      );
      await logAdministrativeEvent(tx, "party_added", account.id, { party_id: made!.id });
    }
    const parties = await tx.query<{ id: string }>(`SELECT id FROM parties ORDER BY created_at, id`);
    for (const { id } of parties) await insert("release", null, id);
    return true;
  });
}

// ---- granting and removing --------------------------------------------------

export type GrantFailure =
  | "INVALID_PERMISSION"
  | "INVALID_SUBJECT"
  | "UNKNOWN_ACCOUNT"
  | "INVALID_SCOPE"
  | "UNKNOWN_LABEL"
  | "UNKNOWN_PARTY"
  | "ALREADY_HELD";

export interface GrantInput {
  permission: string;
  /** Exactly one of accountId and groupName. */
  accountId?: string | null;
  groupName?: string | null;
  label?: string | null;
  partyId?: string | null;
  /** The administrator granting; null when the operator key grants. */
  grantedBy: string | null;
  via: "administrator" | "operator";
}

export interface GrantRow {
  id: string;
  permission: PermissionName;
  account_id: string | null;
  group_name: string | null;
  label: string | null;
  party_id: string | null;
  granted_by: string | null;
  granted_via: string;
  granted_at: Date;
  removed_by: string | null;
  removed_at: Date | null;
}

type Result<T, C extends string> = { ok: true; value: T } | { ok: false; code: C; message: string };

function fail<C extends string>(code: C, message: string): { ok: false; code: C; message: string } {
  return { ok: false, code, message };
}

/**
 * Grant one permission to one account or one group. Granting what the
 * subject already holds at that scope is refused: a grant is one row, and a
 * second would have to be removed twice.
 */
export async function grantPermission(input: GrantInput): Promise<Result<GrantRow, GrantFailure>> {
  if (!isPermissionName(input.permission)) {
    return fail(
      "INVALID_PERMISSION",
      `"${input.permission}" is not a permission. The permissions are: ${PERMISSIONS.join(", ")}.`
    );
  }
  const permission = input.permission;
  const accountId = input.accountId?.trim() || null;
  const groupName = input.groupName?.trim() || null;
  if ((accountId === null) === (groupName === null)) {
    return fail("INVALID_SUBJECT", "A grant is made to one account (account_id) or to one group (group), not both.");
  }
  if (accountId !== null) {
    if (!UUID_RE.test(accountId)) return fail("UNKNOWN_ACCOUNT", "No account has that id.");
    const found = await rawQuery(`SELECT 1 FROM contributors WHERE id = $1`, [accountId]);
    if (found.length === 0) {
      return fail(
        "UNKNOWN_ACCOUNT",
        "No account has that id. An account exists once its person has signed in; a group can be granted before anyone in it has."
      );
    }
  }

  const scope = PERMISSION_DEFINITIONS[permission].scope;
  const label = input.label?.trim() || null;
  const partyId = input.partyId?.trim() || null;
  if (scope === "label") {
    if (!label || partyId) {
      return fail("INVALID_SCOPE", `The permission to ${PERMISSION_DEFINITIONS[permission].phrase} is granted at one label (label), and for no party.`);
    }
    const found = await rawQuery(`SELECT 1 FROM labels WHERE name = $1`, [label]);
    if (found.length === 0) return fail("UNKNOWN_LABEL", `This deployment defines no label named "${label}".`);
  } else if (scope === "party") {
    if (!partyId || label) {
      return fail("INVALID_SCOPE", `The permission to ${PERMISSION_DEFINITIONS[permission].phrase} is granted for one party (party_id), and at no label.`);
    }
    const found = UUID_RE.test(partyId)
      ? await rawQuery(`SELECT 1 FROM parties WHERE id = $1`, [partyId])
      : [];
    if (found.length === 0) return fail("UNKNOWN_PARTY", "No party has that id.");
  } else if (label || partyId) {
    return fail("INVALID_SCOPE", `The permission to ${PERMISSION_DEFINITIONS[permission].phrase} has no scope: it takes no label and no party.`);
  }

  try {
    const [row] = await withSystemClearance(
      "A grant says who may read a label, so it is written on the owner's connection. The caller has checked that the actor may administer.",
      () =>
        rawQuery<GrantRow>(
          `INSERT INTO permission_grants
             (permission, account_id, group_name, label, party_id, granted_by, granted_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [permission, accountId, groupName, label, partyId, input.grantedBy, input.via]
        )
    );
    return { ok: true, value: row! };
  } catch (err) {
    if (sqlState(err) === UNIQUE_VIOLATION) {
      return fail("ALREADY_HELD", "That subject already holds this permission at this scope.");
    }
    throw err;
  }
}

export type RemoveFailure = "NOT_FOUND" | "ALREADY_REMOVED" | "LAST_ADMINISTRATOR";

/**
 * Remove a grant: the row stays, marked with who removed it and when. The
 * last live grant of the permission to administer cannot be removed, since
 * nobody could then grant anything, that one included.
 */
export async function removeGrant(input: {
  grantId: string;
  removedBy: string;
}): Promise<Result<GrantRow, RemoveFailure>> {
  if (!UUID_RE.test(input.grantId)) return fail("NOT_FOUND", "No grant has that id.");
  return withSystemClearance(
    "Removing a grant changes who may read a label, so it is written on the owner's connection. The caller has checked that the actor may administer.",
    () => remove(input)
  );
}

function remove(input: { grantId: string; removedBy: string }): Promise<Result<GrantRow, RemoveFailure>> {
  return withTransaction(async (tx): Promise<Result<GrantRow, RemoveFailure>> => {
    await tx.query(ADMINISTRATOR_LOCK);
    const [grant] = await tx.query<GrantRow>(
      `SELECT * FROM permission_grants WHERE id = $1 FOR UPDATE`,
      [input.grantId]
    );
    if (!grant) return fail("NOT_FOUND", "No grant has that id.");
    if (grant.removed_at) return fail("ALREADY_REMOVED", "That grant was already removed.");
    if (grant.permission === "administer") {
      const [{ live } = { live: 0 }] = await tx.query<{ live: number }>(
        `SELECT count(*)::int AS live FROM permission_grants
          WHERE permission = 'administer' AND removed_at IS NULL`
      );
      if (live <= 1) {
        return fail(
          "LAST_ADMINISTRATOR",
          "This is the deployment's only grant of the permission to administer. Grant it to " +
            "another account or group first: with none left, nobody could grant anything."
        );
      }
    }
    const [removed] = await tx.query<GrantRow>(
      `UPDATE permission_grants SET removed_by = $2, removed_at = now()
        WHERE id = $1 RETURNING *`,
      [input.grantId, input.removedBy]
    );
    return { ok: true, value: removed! };
  });
}

/**
 * The operator key's way back in: grant the permission to administer to an
 * account, named by its sign-in identity. For a deployment whose
 * administrators can no longer sign in, or whose only grant went to a group
 * nobody is in. The grant is a row like any other, marked as made with the
 * operator key.
 */
export async function grantAdministratorByOperator(
  externalId: string
): Promise<Result<GrantRow, GrantFailure>> {
  const [account] = await rawQuery<{ id: string }>(
    `SELECT id FROM contributors WHERE external_id = $1`,
    [externalId.trim()]
  );
  if (!account) {
    return fail(
      "UNKNOWN_ACCOUNT",
      "No account has that sign-in identity. The person signs in once first, which creates the account."
    );
  }
  return grantPermission({
    permission: "administer",
    accountId: account.id,
    grantedBy: null,
    via: "operator",
  });
}

// ---- reading ----------------------------------------------------------------

/** A grant as the routes serve it, with the names an administrator needs to read it. */
export interface GrantView {
  id: string;
  permission: PermissionName;
  account: { id: string; display_name: string; external_id: string | null; email: string | null } | null;
  group: string | null;
  label: string | null;
  party: { id: string; name: string } | null;
  granted_by: { id: string; display_name: string } | null;
  granted_via: string;
  granted_at: string;
  removed_by: { id: string; display_name: string } | null;
  removed_at: string | null;
}

interface GrantJoinRow extends GrantRow {
  account_name: string | null;
  account_external_id: string | null;
  account_email: string | null;
  party_name: string | null;
  granted_by_name: string | null;
  removed_by_name: string | null;
}

const GRANT_JOIN = `
  SELECT g.*, a.display_name AS account_name, a.external_id AS account_external_id,
         a.email AS account_email, p.name AS party_name,
         gb.display_name AS granted_by_name, rb.display_name AS removed_by_name
    FROM permission_grants g
    LEFT JOIN contributors a ON a.id = g.account_id
    LEFT JOIN parties p ON p.id = g.party_id
    LEFT JOIN contributors gb ON gb.id = g.granted_by
    LEFT JOIN contributors rb ON rb.id = g.removed_by`;

function grantView(r: GrantJoinRow): GrantView {
  return {
    id: r.id,
    permission: r.permission,
    account: r.account_id
      ? {
          id: r.account_id,
          display_name: r.account_name ?? "",
          external_id: r.account_external_id,
          email: r.account_email,
        }
      : null,
    group: r.group_name,
    label: r.label,
    party: r.party_id ? { id: r.party_id, name: r.party_name ?? "" } : null,
    granted_by: r.granted_by ? { id: r.granted_by, display_name: r.granted_by_name ?? "" } : null,
    granted_via: r.granted_via,
    granted_at: r.granted_at.toISOString(),
    removed_by: r.removed_by ? { id: r.removed_by, display_name: r.removed_by_name ?? "" } : null,
    removed_at: r.removed_at ? r.removed_at.toISOString() : null,
  };
}

/** One grant in full, for the answer to a grant or a removal. */
export async function getGrant(id: string): Promise<GrantView | null> {
  const [row] = await rawQuery<GrantJoinRow>(`${GRANT_JOIN} WHERE g.id = $1`, [id]);
  return row ? grantView(row) : null;
}

/** Every live grant, oldest first: who holds what now. */
export async function listLiveGrants(): Promise<GrantView[]> {
  const rows = await rawQuery<GrantJoinRow>(
    `${GRANT_JOIN} WHERE g.removed_at IS NULL ORDER BY g.granted_at, g.id`
  );
  return rows.map(grantView);
}

/** An account as an administrator sees it: who it is, its groups, and what was granted to it directly. */
export interface AccountView {
  id: string;
  display_name: string;
  external_id: string | null;
  email: string | null;
  last_active_at: string;
  /** Each group the latest sign-in carried, and whether that sign-in still vouches for it. */
  groups: Array<{ name: string; asserted_at: string; current: boolean }>;
  grants: Array<{ id: string; permission: PermissionName; label: string | null; party_id: string | null }>;
}

export async function listAccounts(input: { q?: string; limit?: number } = {}): Promise<AccountView[]> {
  const validHours = loadConfig().signInValidHours ?? 12;
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 200)), 1000);
  const q = input.q?.trim() ?? "";
  const rows = await rawQuery<{
    id: string;
    display_name: string;
    external_id: string | null;
    email: string | null;
    last_active_at: Date;
    groups: Array<{ name: string; asserted_at: string; current: boolean }> | null;
    grants: AccountView["grants"] | null;
  }>(
    `SELECT c.id, c.display_name, c.external_id, c.email, c.last_active_at,
            (SELECT json_agg(json_build_object(
                      'name', ag.group_name,
                      'asserted_at', ag.asserted_at,
                      'current', ag.asserted_at > now() - ($3::double precision * interval '1 hour'))
                    ORDER BY ag.group_name)
               FROM account_groups ag WHERE ag.account_id = c.id) AS groups,
            (SELECT json_agg(json_build_object(
                      'id', g.id, 'permission', g.permission,
                      'label', g.label, 'party_id', g.party_id)
                    ORDER BY g.granted_at, g.id)
               FROM permission_grants g
              WHERE g.account_id = c.id AND g.removed_at IS NULL) AS grants
       FROM contributors c
      WHERE $1 = ''
         OR c.display_name ILIKE '%' || $1 || '%'
         OR c.email ILIKE '%' || $1 || '%'
         OR c.external_id ILIKE '%' || $1 || '%'
      ORDER BY c.last_active_at DESC, c.id
      LIMIT $2`,
    [q, limit, validHours]
  );
  return rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    external_id: r.external_id,
    email: r.email,
    last_active_at: r.last_active_at.toISOString(),
    groups: (r.groups ?? []).map((g) => ({
      name: g.name,
      asserted_at: new Date(g.asserted_at).toISOString(),
      current: g.current,
    })),
    grants: r.grants ?? [],
  }));
}

// ---- the log ----------------------------------------------------------------

/**
 * One entry of the log every member may read: a grant, a removal, or
 * another administrative act. People appear by display name only.
 *
 * A scope's name is withheld from a reader who is not entitled to it, and
 * the entry says so: a label the reader is not cleared for, and a party
 * that is neither the organization itself nor one the reader holds release
 * for. A deployment may hold material from parties who are not to learn of
 * each other, and label and party names can say who they are. A connection
 * is named, with its tools, only to a reader cleared for its label, for the
 * same reason. That an act happened, who did it, to whom, and when, is never
 * withheld.
 */
/** The administrative acts logged besides grants (administrative_events.action). */
export type AdministrativeAction =
  | "label_defined"
  | "label_read_added"
  | "label_read_removed"
  | "party_added"
  // The organization's own party, made at setup under a placeholder name, was given its name.
  | "own_organization_named"
  | "source_party_set"
  // Connections (src/connections.ts, services/connection-service.ts).
  | "connection_added"
  | "connection_changed"
  | "connection_tools_offered"
  | "connection_tool_withdrawn";

export interface LogEntry {
  event: "granted" | "removed" | AdministrativeAction;
  at: string;
  /** Who did it; null for a grant no administrator made (see `via`). */
  by: string | null;
  /** How a grant was made: administrator, first_administrator, or operator. */
  via?: string;
  permission?: PermissionName;
  /** Who a grant is to: an account's display name, or a group's name. */
  account?: string;
  group?: string;
  label?: string | { withheld: true };
  reads?: string | { withheld: true };
  party?: string | { withheld: true };
  previous_party?: string | { withheld: true } | null;
  source_id?: string;
  /** The connection an act was about, by name. */
  connection?: string | { withheld: true };
  previous_label?: string | { withheld: true };
  /** Which of a connection's settings a change touched, as the route names them. */
  changed?: string[];
  /** The tools an administrator picked for agents, and those no longer picked. */
  offered?: string[];
  no_longer_offered?: string[];
  /** A tool withdrawn from agents, and why: changed, missing or address_changed. */
  tool?: string;
  reason?: string;
}

const WITHHELD = { withheld: true } as const;

export async function permissionLog(
  reader: Standing,
  input: { limit?: number; before?: string } = {}
): Promise<LogEntry[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 100)), 500);
  const before = input.before && !Number.isNaN(Date.parse(input.before)) ? input.before : null;

  const administers = reader.grants.some((g) => g.permission === "administer");
  const cleared = new Set(reader.clearance);
  const releasesFor = new Set(
    reader.grants.filter((g) => g.permission === "release" && g.partyId).map((g) => g.partyId!)
  );
  const parties = new Map(
    (
      await rawQuery<{ id: string; name: string; is_own_organization: boolean }>(
        `SELECT id, name, is_own_organization FROM parties`
      )
    ).map((p) => [p.id, p])
  );
  // A connection's name can say whose system it is, so it is shown to a
  // reader cleared for the connection's label and withheld from the rest.
  const connections = new Map(
    (
      await rawQuery<{ id: string; name: string; sensitivity_label: string }>(
        `SELECT id, name, sensitivity_label FROM connections`
      )
    ).map((c) => [c.id, c])
  );
  const connectionName = (id: string) => {
    const connection = connections.get(id);
    if (!connection) return WITHHELD;
    return administers || cleared.has(connection.sensitivity_label) ? connection.name : WITHHELD;
  };
  const labelName = (name: string) => (administers || cleared.has(name) ? name : WITHHELD);
  const partyName = (id: string) => {
    const party = parties.get(id);
    if (!party) return WITHHELD;
    return administers || party.is_own_organization || releasesFor.has(id) ? party.name : WITHHELD;
  };

  const rows = await rawQuery<{
    event: LogEntry["event"];
    at: Date;
    by_name: string | null;
    via: string | null;
    permission: PermissionName | null;
    account_name: string | null;
    group_name: string | null;
    label: string | null;
    party_id: string | null;
    detail: Record<string, string | null> | null;
  }>(
    `SELECT * FROM (
       SELECT 'granted' AS event, g.granted_at AS at, gb.display_name AS by_name, g.granted_via AS via,
              g.permission, a.display_name AS account_name, g.group_name, g.label, g.party_id,
              NULL::jsonb AS detail, g.id::text AS tiebreak
         FROM permission_grants g
         LEFT JOIN contributors a ON a.id = g.account_id
         LEFT JOIN contributors gb ON gb.id = g.granted_by
       UNION ALL
       SELECT 'removed', g.removed_at, rb.display_name, NULL,
              g.permission, a.display_name, g.group_name, g.label, g.party_id,
              NULL::jsonb, g.id::text
         FROM permission_grants g
         LEFT JOIN contributors a ON a.id = g.account_id
         LEFT JOIN contributors rb ON rb.id = g.removed_by
        WHERE g.removed_at IS NOT NULL
       UNION ALL
       SELECT e.action, e.created_at, actor.display_name, NULL,
              NULL, NULL, NULL, NULL, NULL,
              e.detail, e.id::text
         FROM administrative_events e
         LEFT JOIN contributors actor ON actor.id = e.actor_id
     ) log
     WHERE ($2::timestamptz IS NULL OR log.at < $2::timestamptz)
     ORDER BY log.at DESC, log.tiebreak DESC
     LIMIT $1`,
    [limit, before]
  );

  return rows.map((r): LogEntry => {
    const entry: LogEntry = { event: r.event, at: r.at.toISOString(), by: r.by_name };
    if (r.event === "granted" || r.event === "removed") {
      if (r.event === "granted" && r.via) entry.via = r.via;
      if (r.permission) entry.permission = r.permission;
      if (r.account_name !== null) entry.account = r.account_name;
      if (r.group_name !== null) entry.group = r.group_name;
      if (r.label !== null) entry.label = labelName(r.label);
      if (r.party_id !== null) entry.party = partyName(r.party_id);
      return entry;
    }
    const d = r.detail ?? {};
    if (typeof d.label === "string") entry.label = labelName(d.label);
    if (typeof d.reads === "string") entry.reads = labelName(d.reads);
    if (typeof d.party_id === "string") entry.party = partyName(d.party_id);
    if (r.event === "source_party_set") {
      if (typeof d.source_id === "string") entry.source_id = d.source_id;
      entry.previous_party =
        typeof d.previous_party_id === "string" ? partyName(d.previous_party_id) : null;
    }
    if (typeof d.connection_id === "string") {
      entry.connection = connectionName(d.connection_id);
      if (typeof d.previous_label === "string") entry.previous_label = labelName(d.previous_label);
      if (typeof d.previous_party_id === "string") entry.previous_party = partyName(d.previous_party_id);
      // Lists are stored as one string, a name to a line: a tool's name may
      // hold a comma.
      const list = (value: string | null | undefined) =>
        typeof value === "string" && value.length > 0 ? value.split("\n") : undefined;
      const changed = list(d.changed);
      if (changed) entry.changed = changed;
      if (typeof d.reason === "string") entry.reason = d.reason;
      // A tool's name can say as much about the system as the connection's
      // own, so the two are shown or withheld together.
      if (typeof entry.connection === "string") {
        const offered = list(d.offered);
        if (offered) entry.offered = offered;
        const dropped = list(d.no_longer_offered);
        if (dropped) entry.no_longer_offered = dropped;
        if (typeof d.tool === "string") entry.tool = d.tool;
      }
    }
    return entry;
  });
}

/** Write one administrative event inside the transaction that makes the change. */
export async function logAdministrativeEvent(
  tx: TxQuery,
  action: AdministrativeAction,
  // Null for a change no person made: a connection's tool withdrawn because
  // it changed at its server.
  actorId: string | null,
  detail: Record<string, string | null>
): Promise<void> {
  await tx.query(
    `INSERT INTO administrative_events (action, actor_id, detail) VALUES ($1, $2, $3::jsonb)`,
    [action, actorId, JSON.stringify(detail)]
  );
}
