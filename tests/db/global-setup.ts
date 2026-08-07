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

export default async function globalSetup(): Promise<void> {
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
}
