/**
 * The two login roles read-only SQL runs as (src/services/sql-service.ts):
 * one for agents' queries, one for outside callers'. Each is a member of
 * minerval_sql, the group role migration 0093 grants SELECT on the
 * public_read views and nothing else, so neither can read a base table.
 * Each has its own connection limit: a query opens a fresh connection and
 * closes it, so the limit is how many queries of that audience can run at
 * once, and a query past it is answered BUSY at once rather than queued
 * (Postgres error 53300).
 *
 * Roles are cluster-wide, so creating them on the primary creates them on
 * the read replica the queries actually run on.
 *
 * Idempotent: an existing role has its password, membership and limit set
 * again, which is also how a rotated secret is applied. The API runs this
 * at startup, after migrations (src/index.ts), because a deployment whose
 * roles were never made answers every query UNAVAILABLE: the login fails
 * and sql-service reports that as a fault on our side. scripts/
 * ensure-sql-roles.ts runs it by hand.
 */

/** How many queries of each audience may run at once. */
export const SQL_ROLE_CONNECTION_LIMITS = { agent: 4, caller: 4 } as const;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export type RoleQuery = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export interface SqlRoleCredentials {
  agentUser?: string;
  agentPassword?: string;
  callerUser?: string;
  callerPassword?: string;
}

/** Whether the environment names both roles fully, so there is something to ensure. */
export function hasSqlRoleCredentials(c: SqlRoleCredentials): boolean {
  return Boolean(c.agentUser && c.agentPassword && c.callerUser && c.callerPassword);
}

async function ensureRole(
  query: RoleQuery,
  user: string | undefined,
  password: string | undefined,
  limit: number
): Promise<"created" | "updated"> {
  if (!user || !password) throw new Error("missing a role's username or password in the environment");
  if (!IDENT.test(user)) throw new Error(`"${user}" is not a plain role name`);
  // CREATE ROLE and ALTER ROLE take no bind parameters, so the password is a
  // quoted literal. The secrets that supply it exclude quotes anyway
  // (infra/lib/database-stack.ts).
  const quoted = password.replace(/'/g, "''");
  const [exists] = await query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [user]);
  if (Number(exists?.n ?? 0) === 0) {
    try {
      await query(`CREATE ROLE ${user} LOGIN PASSWORD '${quoted}' CONNECTION LIMIT ${limit} IN ROLE minerval_sql`);
      return "created";
    } catch (err) {
      // 42710: another API task starting at the same moment made it first.
      // Fall through and set it again, which leaves the same result.
      if ((err as { code?: string }).code !== "42710") throw err;
    }
  }
  await query(`ALTER ROLE ${user} WITH LOGIN PASSWORD '${quoted}' CONNECTION LIMIT ${limit}`);
  await query(`GRANT minerval_sql TO ${user}`);
  return "updated";
}

/** Create or update both roles. Returns one line per role, for the log. */
export async function ensureSqlRoles(query: RoleQuery, c: SqlRoleCredentials): Promise<string[]> {
  const lines: string[] = [];
  for (const [user, password, limit] of [
    [c.agentUser, c.agentPassword, SQL_ROLE_CONNECTION_LIMITS.agent],
    [c.callerUser, c.callerPassword, SQL_ROLE_CONNECTION_LIMITS.caller],
  ] as const) {
    const outcome = await ensureRole(query, user, password, limit);
    lines.push(`${outcome === "created" ? "+" : "~"} role ${user} (connection limit ${limit})`);
  }
  return lines;
}
