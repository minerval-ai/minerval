/**
 * Create or update the two login roles read-only SQL runs as
 * (src/services/sql-service.ts): one for agents' queries, one for outside
 * callers'. Each is a member of minerval_sql, the group role migration 0091
 * grants SELECT on the public_read views and nothing else, so neither can
 * read a base table. Each has its own connection limit: a query opens a
 * fresh connection and closes it, so the limit is how many queries of that
 * audience can run at once, and a query past it is answered BUSY at once
 * rather than queued (Postgres error 53300).
 *
 * Roles are cluster-wide, so creating them on the primary creates them on
 * the read replica the queries actually run on.
 *
 * Idempotent: an existing role has its password, membership and limit set
 * again, which is also how a rotated secret is applied.
 *
 * Run with the primary's admin credentials (DB_HOST/DB_USERNAME/DB_PASSWORD
 * or DATABASE_URL) and the roles' own (SQL_AGENT_DB_USERNAME/PASSWORD,
 * SQL_CALLER_DB_USERNAME/PASSWORD), which the API's task definition already
 * supplies, so in production run it as a one-off ECS task on that task
 * definition, as the platform-mandate seed is run:
 *
 *   aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"api",
 *     "command":["npm","run","ensure:sql-roles"]}]}'
 */
import { rawQuery, closeDb } from "../src/db/client.js";

/** How many queries of each audience may run at once. */
const LIMITS = { agent: 4, caller: 4 } as const;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

async function ensureRole(user: string | undefined, password: string | undefined, limit: number): Promise<void> {
  if (!user || !password) throw new Error("missing a role's username or password in the environment");
  if (!IDENT.test(user)) throw new Error(`"${user}" is not a plain role name`);
  const quoted = password.replace(/'/g, "''");
  const [exists] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [user]);
  if (Number(exists?.n ?? 0) === 0) {
    await rawQuery(`CREATE ROLE ${user} LOGIN PASSWORD '${quoted}' CONNECTION LIMIT ${limit} IN ROLE minerval_sql`);
    console.log(`+ role ${user} (connection limit ${limit})`);
  } else {
    await rawQuery(`ALTER ROLE ${user} WITH LOGIN PASSWORD '${quoted}' CONNECTION LIMIT ${limit}`);
    await rawQuery(`GRANT minerval_sql TO ${user}`);
    console.log(`~ role ${user} (connection limit ${limit})`);
  }
}

async function main() {
  await ensureRole(process.env.SQL_AGENT_DB_USERNAME, process.env.SQL_AGENT_DB_PASSWORD, LIMITS.agent);
  await ensureRole(process.env.SQL_CALLER_DB_USERNAME, process.env.SQL_CALLER_DB_PASSWORD, LIMITS.caller);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
