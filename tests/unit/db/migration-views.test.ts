/**
 * A migration that makes or replaces a view does not open a way past the
 * label policies (src/db/clearance.ts).
 *
 * Two kinds of view can do that:
 *
 *   A view in `public` reads its tables as its owner unless it says
 *   otherwise, and the tables' owner is not bound by the policies: a
 *   cleared connection would read every label through it. So every view
 *   there is created WITH (security_invoker = true). The four in-force
 *   views say so in src/db/schema.ts, so a regenerated one is created with
 *   it, and CREATE OR REPLACE VIEW without the option would take it away.
 *
 *   A view in `public_read` is what read-only SQL reads. It is held because
 *   it belongs to a role the policies bind, which a view made by a
 *   migration does not: it belongs to the owner until the step hands it
 *   over. So a migration that makes one runs the step itself, after its
 *   last such statement. Migrations run in one transaction, so no reader
 *   ever sees the view between the two.
 *
 * This reads every migration after the one that brought enforcement and
 * fails on a statement that does neither. Earlier migrations are not read:
 * the enforcement migration set every view that existed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATIONS = join(ROOT, "src", "db", "migrations");

const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** What is wrong with the views a migration makes, as sentences; empty when nothing is. */
export function viewProblems(sql: string): string[] {
  const text = withoutComments(sql);
  const problems: string[] = [];
  let lastSqlView = -1;
  for (const m of text.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?([^;]*?)\bAS\b/gi
  )) {
    const [, materialized, schema = "public", name, options] = m;
    const where = `${schema}.${name}`;
    if (materialized) {
      problems.push(`${where} is a materialized view: it is a copy of rows taken as its owner, and no policy applies to it.`);
    } else if (schema.toLowerCase() === "public" && !/security_invoker\s*=\s*(true|on|1)/i.test(options ?? "")) {
      problems.push(`${where} is made without WITH (security_invoker = true), so it would read its tables as the owner.`);
    } else if (schema.toLowerCase() === "public_read") {
      lastSqlView = m.index!;
    }
  }
  if (lastSqlView >= 0 && !/minerval_enforcement_sync\s*\(/i.test(text.slice(lastSqlView))) {
    problems.push(
      "a view in public_read is made and the migration does not run SELECT public.minerval_enforcement_sync() after it, " +
        "so read-only SQL would read every label through it until the next start."
    );
  }
  return problems;
}

describe("a migration that makes a view", () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const enforcement = journal.entries.findIndex((e) => e.tag.endsWith("_label_enforcement"));

  it("keeps it held, in every migration after the one that brought enforcement", () => {
    expect(enforcement).toBeGreaterThan(100);
    const wrong: string[] = [];
    for (const entry of journal.entries.slice(enforcement + 1)) {
      const sql = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
      for (const problem of viewProblems(sql)) wrong.push(`${entry.tag}.sql: ${problem}`);
    }
    expect(wrong).toEqual([]);
  });

  it("says in the schema that the views in public read with their caller's rights, so a regenerated one is made that way", () => {
    const schema = readFileSync(join(ROOT, "src", "db", "schema.ts"), "utf8");
    const views = [...schema.matchAll(/pgView\(\s*"(\w+)"\s*\)([^;]*?)\.as\(/g)];
    expect(views.map((v) => v[1])).toEqual([
      "assessments_in_force",
      "argument_evaluations_in_force",
      "quantity_estimates_in_force",
      "question_assessments_in_force",
      "assessments_versions",
      "argument_evaluations_versions",
      "quantity_estimates_versions",
      "question_assessments_versions",
    ]);
    for (const [, name, options] of views) expect(options, name).toContain(".with(callersRights)");
    expect(schema).toContain("const callersRights = { securityInvoker: true };");
  });

  it("tells a held view from one that is not", () => {
    expect(viewProblems(`CREATE OR REPLACE VIEW "public"."v" AS SELECT 1;`)).toHaveLength(1);
    expect(viewProblems(`CREATE VIEW v AS SELECT 1;`)).toHaveLength(1);
    expect(viewProblems(`CREATE VIEW "public"."v" WITH (security_invoker = true) AS (select 1);`)).toEqual([]);
    expect(viewProblems(`CREATE OR REPLACE VIEW public_read.nodes AS SELECT 1;`)).toHaveLength(1);
    expect(viewProblems(`CREATE OR REPLACE VIEW public_read.nodes AS SELECT 1;\nSELECT public.minerval_enforcement_sync();`)).toEqual([]);
    // The step run before the view is made does not cover it.
    expect(viewProblems(`SELECT minerval_enforcement_sync();\nCREATE VIEW public_read.nodes AS SELECT 1;`)).toHaveLength(1);
    expect(viewProblems(`CREATE MATERIALIZED VIEW public.digest AS SELECT 1;`)).toHaveLength(1);
    // A view in a schema of its own that applies the clearance itself is neither kind.
    expect(viewProblems(`CREATE OR REPLACE VIEW minerval_readable.claims_search AS SELECT 1;`)).toEqual([]);
    expect(viewProblems(`-- CREATE VIEW public.v AS SELECT 1 would read as the owner\nSELECT 1;`)).toEqual([]);
  });
});
