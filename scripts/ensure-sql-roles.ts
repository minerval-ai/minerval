/**
 * Create or update the two login roles read-only SQL runs as
 * (src/db/sql-roles.ts has the detail). The API does this itself at
 * startup, after migrations, so this script is for applying a change
 * without a deploy: a rotated secret, or a role someone dropped.
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
import { ensureSqlRoles } from "../src/db/sql-roles.js";

async function main() {
  const lines = await ensureSqlRoles((text, params) => rawQuery(text, params), {
    agentUser: process.env.SQL_AGENT_DB_USERNAME,
    agentPassword: process.env.SQL_AGENT_DB_PASSWORD,
    callerUser: process.env.SQL_CALLER_DB_USERNAME,
    callerPassword: process.env.SQL_CALLER_DB_PASSWORD,
  });
  for (const line of lines) console.log(line);
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
