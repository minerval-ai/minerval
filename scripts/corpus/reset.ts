/**
 * Reset the isolated corpus database to an empty, migrated state.
 *
 *   1. CREATE DATABASE <corpus db> if it doesn't exist
 *   2. CREATE EXTENSION vector / pg_trgm
 *   3. run Drizzle migrations
 *   4. TRUNCATE all data tables
 *
 * This is the "delete everything and start over" button — and because it only
 * ever touches the corpus DB (see lib.ts), it can never wipe the main graph.
 *
 * Usage:  tsx scripts/corpus/reset.ts
 */
import "./lib.js"; // side effect: pin DATABASE_URL to the corpus DB (must be first)
import { CORPUS_DATABASE_URL, MIGRATIONS_DIR } from "./lib.js";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres"; // connect to the maintenance DB to issue CREATE DATABASE
  return u.toString();
}

const DATA_TABLES = [
  "agent_steps",
  "agent_runs",
  "enqueue_events",
  "queue_depth_snapshots",
  "claim_instances",
  "claim_relationships",
  "assessments",
  "arguments",
  "contributions",
  "contribution_reviews",
  "appeals",
  "arbitration_results",
  "claims",
  "sources",
  "jobs",
  "contributors",
];

export async function resetCorpusDb(): Promise<void> {
  const dbName = dbNameOf(CORPUS_DATABASE_URL);
  if (dbName === "episteme") {
    throw new Error(
      "Refusing to reset: corpus DB is 'episteme' (the main graph). Set CORPUS_DATABASE_URL."
    );
  }

  // 1. Ensure the database exists.
  const admin = new pg.Client({ connectionString: adminUrlOf(CORPUS_DATABASE_URL) });
  await admin.connect();
  const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    dbName,
  ]);
  if (rows.length === 0) {
    console.log(`  creating database "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  // 2-4. Extensions, migrations, truncate.
  const pool = new pg.Pool({ connectionString: CORPUS_DATABASE_URL });
  const db = drizzle(pool);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`)
  );
  await pool.end();

  console.log(`✓ corpus DB "${dbName}" reset (extensions + migrations + truncated)`);
}

// Run directly.
if ((process.argv[1] ?? "").endsWith("reset.ts")) {
  resetCorpusDb().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
