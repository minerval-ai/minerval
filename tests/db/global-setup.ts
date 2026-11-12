/**
 * Global setup for the DB-backed suite: build the scratch database from
 * absolute zero, every run.
 *
 *  1. Connect to the maintenance DB (TEST_DATABASE_ADMIN_URL) and
 *     DROP + CREATE the scratch database (TEST_DATABASE_URL's db name).
 *  2. CREATE EXTENSION vector (migration 0000 needs it).
 *  3. Apply the full migration chain with drizzle-kit. Any migration
 *     failure fails the whole suite loudly, before a single test runs —
 *     migration-from-zero is itself under test.
 *
 * Runs in its own process; the per-worker DATABASE_URL is set in
 * tests/db/setup.ts.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { TEST_DATABASE_URL, TEST_DATABASE_ADMIN_URL } from "./urls.js";

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

  const admin = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const scratch = new pg.Client({ connectionString: TEST_DATABASE_URL });
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
}
