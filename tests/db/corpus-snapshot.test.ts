/**
 * The snapshot primitive (#334 L1), exercised for real: template-database
 * copies on a throwaway database — never the suite's scratch DB, whose pool
 * the force-terminate would kill. Save → mutate → restore → the mutation is
 * gone; that round-trip is the property everything downstream (metamorphic
 * re-runs, adversarial episodes) leans on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { TEST_DATABASE_URL } from "./urls.js";
import {
  dropSnapshot,
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
  snapshotDbName,
} from "../../scripts/corpus/snapshot-core.js";

// A private database for this file, parallel to the scratch DB.
const SOURCE_DB = `${new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "")}_snapsrc`;
const SOURCE_URL = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${SOURCE_DB}`;
  return u.toString();
})();
const ADMIN_URL = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = "/postgres";
  return u.toString();
})();

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function source<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: SOURCE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SOURCE_DB}`);
  });
  await source(async (c) => {
    await c.query(`CREATE TABLE marker (v text)`);
    await c.query(`INSERT INTO marker VALUES ('original')`);
  });
});

afterAll(async () => {
  await admin(async (c) => {
    await c.query(
      `DROP DATABASE IF EXISTS ${snapshotDbName(SOURCE_DB, "t1")} WITH (FORCE)`
    );
    await c.query(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
  });
});

describe("snapshot save → mutate → restore", () => {
  it("round-trips the database state", async () => {
    const snap = await saveSnapshot(SOURCE_URL, "t1");
    expect(snap).toBe(snapshotDbName(SOURCE_DB, "t1"));

    // Mutate the source after the snapshot.
    await source(async (c) => {
      await c.query(`UPDATE marker SET v = 'mutated'`);
      await c.query(`INSERT INTO marker VALUES ('extra')`);
    });

    await restoreSnapshot(SOURCE_URL, "t1");

    const rows = await source(async (c) => {
      const r = await c.query<{ v: string }>(`SELECT v FROM marker ORDER BY v`);
      return r.rows.map((x) => x.v);
    });
    expect(rows).toEqual(["original"]);
  });

  it("lists and drops snapshots", async () => {
    const listed = await listSnapshots(SOURCE_URL);
    expect(listed.map((s) => s.name)).toContain("t1");

    await dropSnapshot(SOURCE_URL, "t1");
    const after = await listSnapshots(SOURCE_URL);
    expect(after.map((s) => s.name)).not.toContain("t1");
  });

  it("refuses a restore from a snapshot that does not exist", async () => {
    await expect(restoreSnapshot(SOURCE_URL, "nope")).rejects.toThrow(
      /does not exist/
    );
  });
});
