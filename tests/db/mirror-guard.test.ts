/**
 * The guard on mirrored rows, held against the manifest
 * (src/services/mirror-manifest.ts).
 *
 * The triggers that keep a mirrored row the public graph's are written in a
 * migration; the list of which tables are mirrored, and which of a claim's
 * columns are a deployment's own to write, is in the manifest. This test
 * fails when the two differ: a replicated table with no guard, or a column
 * the manifest calls local that the trigger still guards (or the reverse).
 * The fix is a migration that recreates that table's update trigger with
 * the manifest's local and generated columns as its arguments.
 *
 * What the guard does is tested in mirror-schema.test.ts.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { replicatedTables } from "../../src/services/mirror-manifest.js";

describe("the guard on mirrored rows and the manifest", () => {
  it("guards exactly the replicated tables", async () => {
    const guarded = await rawQuery<{ table_name: string }>(
      `SELECT DISTINCT t.tgrelid::regclass::text AS table_name
         FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mirror_row_guard_%' ORDER BY 1`
    );
    expect(guarded.map((g) => g.table_name)).toEqual(replicatedTables().map((t) => t.name).sort());
    const withOrigin = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'origin' AND column_default = '''local''::text' ORDER BY 1`
    );
    expect(withOrigin.map((w) => w.table_name)).toEqual(replicatedTables().map((t) => t.name).sort());
  });

  it("leaves unguarded, on an update, exactly the columns the manifest says are local or generated", async () => {
    const triggers = await rawQuery<{ table_name: string; args: string[] }>(
      `SELECT t.tgrelid::regclass::text AS table_name,
              CASE WHEN t.tgnargs = 0 THEN '{}'::text[]
                   ELSE string_to_array(rtrim(encode(t.tgargs, 'escape'), '\\000'), '\\000') END AS args
         FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'mirror_row_guard_update'`
    );
    const byTable = new Map(triggers.map((t) => [t.table_name, t.args]));
    for (const table of replicatedTables()) {
      expect(byTable.get(table.name), table.name).toEqual([...table.unguardedColumns]);
    }
  });
});
