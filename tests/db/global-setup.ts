/**
 * Global setup for the DB-backed suite: build the scratch database from
 * absolute zero, every run.
 *
 *  1. Connect to the maintenance DB (TEST_DATABASE_ADMIN_URL) and
 *     DROP + CREATE the scratch database (TEST_DATABASE_URL's db name).
 *     Where TEST_DATABASE_URL names another role than the maintenance
 *     connection's, that role is made if it is not there (a login that may
 *     create roles and databases and is not a superuser, which is what a
 *     managed Postgres gives a deployment) and owns the database: the
 *     suite then runs as a deployment's owner does on a managed Postgres,
 *     where no application role is a superuser (`npm run test:db:owner`).
 *  2. CREATE EXTENSION vector (migration 0000 needs it), as the
 *     maintenance role.
 *  3. Apply the full migration chain with drizzle-kit. Any migration
 *     failure fails the whole suite loudly, before a single test runs —
 *     migration-from-zero is itself under test.
 *  4. Copy the migrated, still empty database three times, for the mirror's tests
 *     (tests/db/urls.ts, mirrorDatabaseUrl): a publisher and a private
 *     deployment are two databases.
 *
 * Runs in its own process; the per-worker DATABASE_URL is set in
 * tests/db/setup.ts.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { MIRROR_DATABASE_SIDES, TEST_DATABASE_URL, TEST_DATABASE_ADMIN_URL, mirrorDatabaseUrl } from "./urls.js";

/**
 * What the catalog says about enforcement (src/db/clearance.ts): the
 * labelled tables, which of them have row-level security, and how many
 * policies and judgment guards exist.
 */
export interface EnforcementCatalog {
  labelled: string[];
  secured: string[];
  policies: number;
  guards: number;
}

async function enforcementCatalog(client: pg.Client): Promise<EnforcementCatalog> {
  const tables = await client.query<{ name: string; secured: boolean }>(
    `SELECT c.relname::text AS name, c.relrowsecurity AS secured
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
      ORDER BY c.relname`
  );
  const [counts] = (
    await client.query<{ policies: number; guards: number }>(
      `SELECT (SELECT count(*)::int FROM pg_policy) AS policies,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'judgment_label_guard') AS guards`
    )
  ).rows;
  return {
    labelled: tables.rows.map((t) => t.name),
    secured: tables.rows.filter((t) => t.secured).map((t) => t.name),
    policies: counts!.policies,
    guards: counts!.guards,
  };
}

/**
 * The switch, on a database that has only ever had `public`: what the
 * catalog holds before any other label, with one defined, and with it
 * removed again. It is done inside a transaction that is rolled back, so
 * the suite starts on a database nothing was ever switched on in.
 * tests/db/enforcement.test.ts asserts on what is recorded here; this is
 * the one moment the suite's database is known to have `public` alone.
 */
async function recordEnforcementSwitch(): Promise<{
  before: EnforcementCatalog;
  during: EnforcementCatalog;
  after: EnforcementCatalog;
}> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const before = await enforcementCatalog(client);
    await client.query("BEGIN");
    await client.query(`INSERT INTO labels (name, description) VALUES ('switch-probe', 'Defined and removed by the suite setup.')`);
    const during = await enforcementCatalog(client);
    await client.query(`DELETE FROM labels WHERE name = 'switch-probe'`);
    const after = await enforcementCatalog(client);
    await client.query("ROLLBACK");
    return { before, during, after };
  } finally {
    await client.end();
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    enforcementSwitch: { before: EnforcementCatalog; during: EnforcementCatalog; after: EnforcementCatalog };
  }
}

export default async function globalSetup(project: {
  provide: (key: "enforcementSwitch", value: Awaited<ReturnType<typeof recordEnforcementSwitch>>) => void;
}): Promise<void> {
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to manage suspicious test db name: ${dbName}`);
  }
  if (dbName === "episteme") {
    throw new Error(
      "Refusing to run the DB suite against the 'episteme' database; " +
        "point TEST_DATABASE_URL at a scratch database"
    );
  }

  const owner = new URL(TEST_DATABASE_URL);
  const ownerRole = decodeURIComponent(owner.username);
  const separateOwner = ownerRole !== decodeURIComponent(new URL(TEST_DATABASE_ADMIN_URL).username);
  if (separateOwner && !/^[a-z0-9_]+$/.test(ownerRole)) {
    throw new Error(`Refusing to manage suspicious test role name: ${ownerRole}`);
  }

  const admin = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    if (separateOwner) {
      const existing = await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = $1`, [ownerRole]);
      if (existing.rows[0]?.rolsuper) {
        throw new Error(`The role ${ownerRole} is a superuser; name a role of its own for a run as a plain owner`);
      }
      // The password travels as a parameter of format(), never in the statement's text.
      const password = decodeURIComponent(owner.password);
      const [statement] = (
        await admin.query<{ sql: string }>(
          `SELECT format('%s ROLE %I LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD %L', $1::text, $2::text, $3::text) AS sql`,
          [existing.rows.length > 0 ? "ALTER" : "CREATE", ownerRole, password]
        )
      ).rows;
      await admin.query(statement!.sql);
      // The roles migrations make belong to the whole server. On a server
      // where an earlier run made them as another role, this owner is given
      // what their maker has: the right to administer them, and nothing of
      // theirs by inheritance. On a server of its own it makes them itself.
      const made = await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'minerval\\_%'`);
      for (const { rolname } of made.rows) {
        await admin.query(`GRANT "${rolname}" TO "${ownerRole}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      }
    }
    await admin.query(`CREATE DATABASE ${dbName}${separateOwner ? ` OWNER ${ownerRole}` : ""}`);
  } finally {
    await admin.end();
  }

  // The extension is the maintenance role's to create; a plain owner may not.
  const scratchUrl = new URL(TEST_DATABASE_ADMIN_URL);
  scratchUrl.pathname = `/${dbName}`;
  const scratch = new pg.Client({ connectionString: separateOwner ? scratchUrl.toString() : TEST_DATABASE_URL });
  await scratch.connect();
  try {
    await scratch.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await scratch.end();
  }

  // Migration-from-zero, via the same tool production uses. execFileSync
  // throws on a non-zero exit, which fails the suite with the tool's
  // output attached.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  execFileSync("npx", ["drizzle-kit", "migrate"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  project.provide("enforcementSwitch", await recordEnforcementSwitch());
  // The mirror's databases: copies of the one just migrated, taken now,
  // while nothing is connected to it and it holds no rows.
  const copies = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  await copies.connect();
  try {
    for (const side of MIRROR_DATABASE_SIDES) {
      const copy = new URL(mirrorDatabaseUrl(side)).pathname.replace(/^\//, "");
      await copies.query(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE)`);
      await copies.query(`CREATE DATABASE ${copy} TEMPLATE ${dbName}`);
    }
  } finally {
    await copies.end();
  }
}
