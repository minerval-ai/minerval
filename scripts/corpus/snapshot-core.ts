/**
 * Database snapshot/restore mechanics (#334 L1) — the primitive that makes
 * multi-episode eval work feasible: metamorphic re-runs (#295), adversarial
 * episodes against a resettable graph (#302), and cheap "diff two states"
 * experiments, all without re-ingesting a corpus each time.
 *
 * Implemented as Postgres template-database copies: a snapshot IS a database
 * (`<db>_snap_<name>`), created with `CREATE DATABASE … TEMPLATE …`, which is
 * a file-level copy — seconds for corpus-sized graphs, no dump/restore
 * round-trip. The price of that speed is exclusivity: Postgres requires zero
 * connections on the template side (and DROP requires zero on the target),
 * so every operation force-terminates other sessions on the databases it
 * touches. That's correct for the harness (snapshots happen between runs,
 * never mid-drain) and is why this must never point at the production DB.
 *
 * This module is deliberately side-effect-free and URL-parameterized (no
 * lib.js import, no env pinning) so the DB test suite can exercise the real
 * mechanics against throwaway databases. The CLI wrapper (snapshot.ts) binds
 * it to the corpus DB and adds the operator ergonomics.
 */
import pg from "pg";

const SNAP_INFIX = "_snap_";

export function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

export function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

/**
 * Refuse anything that isn't a plausible, disposable database name. The main
 * graph is protected by name: snapshot/restore hard-refuses 'episteme'.
 */
export function assertSnapshotSafe(dbName: string): void {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Suspicious database name: "${dbName}"`);
  }
  if (dbName === "episteme") {
    throw new Error(
      "Refusing to snapshot/restore the main 'episteme' database. " +
        "Snapshots are a harness primitive for disposable databases only."
    );
  }
}

export function assertSnapshotName(name: string): void {
  if (!/^[a-z0-9_]{1,40}$/.test(name)) {
    throw new Error(
      `Snapshot name "${name}" must be 1-40 chars of [a-z0-9_].`
    );
  }
}

export function snapshotDbName(baseDb: string, name: string): string {
  return `${baseDb}${SNAP_INFIX}${name}`;
}

async function withAdmin<T>(
  databaseUrl: string,
  fn: (admin: pg.Client) => Promise<T>
): Promise<T> {
  const admin = new pg.Client({ connectionString: adminUrlOf(databaseUrl) });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function terminateConnections(
  admin: pg.Client,
  dbName: string
): Promise<void> {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName]
  );
}

async function dbExists(admin: pg.Client, dbName: string): Promise<boolean> {
  const { rows } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [dbName]
  );
  return rows.length > 0;
}

/** Copy the database to `<db>_snap_<name>`, replacing any prior snapshot. */
export async function saveSnapshot(
  databaseUrl: string,
  name: string
): Promise<string> {
  const base = dbNameOf(databaseUrl);
  assertSnapshotSafe(base);
  assertSnapshotName(name);
  const snap = snapshotDbName(base, name);
  await withAdmin(databaseUrl, async (admin) => {
    if (!(await dbExists(admin, base))) {
      throw new Error(`Database "${base}" does not exist; nothing to snapshot.`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${snap} WITH (FORCE)`);
    // The template side must have zero connections for the copy.
    await terminateConnections(admin, base);
    await admin.query(`CREATE DATABASE ${snap} TEMPLATE ${base}`);
  });
  return snap;
}

/** Replace the database with the named snapshot's contents. */
export async function restoreSnapshot(
  databaseUrl: string,
  name: string
): Promise<void> {
  const base = dbNameOf(databaseUrl);
  assertSnapshotSafe(base);
  assertSnapshotName(name);
  const snap = snapshotDbName(base, name);
  await withAdmin(databaseUrl, async (admin) => {
    if (!(await dbExists(admin, snap))) {
      throw new Error(
        `Snapshot "${name}" (database "${snap}") does not exist.`
      );
    }
    await terminateConnections(admin, snap);
    await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${base} TEMPLATE ${snap}`);
  });
}

export interface SnapshotInfo {
  name: string;
  database: string;
  sizePretty: string;
}

export async function listSnapshots(
  databaseUrl: string
): Promise<SnapshotInfo[]> {
  const base = dbNameOf(databaseUrl);
  assertSnapshotSafe(base);
  const prefix = `${base}${SNAP_INFIX}`;
  return withAdmin(databaseUrl, async (admin) => {
    const { rows } = await admin.query<{ datname: string; size: string }>(
      `SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size
         FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
      [`${prefix}%`]
    );
    return rows.map((r) => ({
      name: r.datname.slice(prefix.length),
      database: r.datname,
      sizePretty: r.size,
    }));
  });
}

export async function dropSnapshot(
  databaseUrl: string,
  name: string
): Promise<void> {
  const base = dbNameOf(databaseUrl);
  assertSnapshotSafe(base);
  assertSnapshotName(name);
  const snap = snapshotDbName(base, name);
  await withAdmin(databaseUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${snap} WITH (FORCE)`);
  });
}
