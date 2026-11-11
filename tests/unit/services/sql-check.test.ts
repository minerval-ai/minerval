/**
 * checkQuery's relation allowlist resolves CTE names by scope, the way
 * Postgres does. A name declared in one subquery must not excuse the same
 * name elsewhere, where Postgres binds it to pg_catalog.
 */
import { describe, it, expect } from "vitest";
import { checkQuery, SqlRefusal } from "../../../src/services/sql-service.js";

async function refused(sql: string): Promise<boolean> {
  try {
    await checkQuery(sql);
    return false;
  } catch (err) {
    if (err instanceof SqlRefusal && err.code === "NOT_ALLOWED") return true;
    throw err;
  }
}

describe("checkQuery CTE scoping", () => {
  it("refuses a catalog name excused only by a CTE in another scope", async () => {
    for (const sql of [
      // The reported form: the inner CTE's name whitelisted the outer pg_roles.
      "SELECT rolname FROM pg_roles WHERE EXISTS (WITH pg_roles AS (SELECT 1 AS x) SELECT 1 FROM pg_roles)",
      // Same trick without a pg_ CTE name: a sibling subquery's CTE.
      "SELECT * FROM (WITH x AS (SELECT 1) SELECT 1 FROM x) a, (SELECT 1 FROM x) b",
      // A non-recursive CTE's own body sees the catalog, not itself.
      "WITH pg_settings AS (SELECT * FROM pg_settings) SELECT * FROM pg_settings",
      "WITH s AS (SELECT * FROM s) SELECT * FROM s",
      // A later CTE is not visible to an earlier one.
      "WITH a AS (SELECT * FROM b), b AS (SELECT id FROM nodes) SELECT * FROM a",
      "SELECT * FROM pg_stat_activity",
    ]) {
      expect(await refused(sql), sql).toBe(true);
    }
  });

  it("still accepts CTEs used where they are in scope", async () => {
    for (const sql of [
      "WITH a AS (SELECT id FROM nodes) SELECT * FROM a",
      "WITH a AS (SELECT id FROM nodes), b AS (SELECT id FROM a) SELECT * FROM b",
      "WITH a AS (SELECT id FROM nodes) SELECT id FROM a UNION SELECT id FROM a",
      "SELECT * FROM nodes WHERE EXISTS (WITH x AS (SELECT 1 AS y) SELECT 1 FROM x)",
      "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r",
      "WITH a AS (SELECT id FROM nodes) SELECT * FROM nodes WHERE id IN (SELECT id FROM a)",
    ]) {
      expect(await refused(sql), sql).toBe(false);
    }
  });
});
