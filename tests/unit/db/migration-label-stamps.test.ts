/**
 * A migration that inserts into a labelled table says what the label is.
 *
 * A sensitivity_label column defaults to the label of the connection the
 * insert arrives on, and migrations run on the owner's connection, which
 * carries none. Where `public` is the only label that default answers
 * `public`. Where a deployment has a second label it refuses the insert,
 * because a row is never public by omission: so a migration that inserts
 * into a labelled table without naming the column runs everywhere this
 * suite runs and fails on the first private deployment it reaches.
 *
 * This reads every migration after the one that changed the default and
 * holds each INSERT into a labelled table to naming the column. A row
 * derived from another takes that row's label (INSERT ... SELECT the
 * column); a row the migration makes up says which label it means.
 * Migrations before the change ran when the default was `public`, and are
 * not read.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATIONS = join(ROOT, "src", "db", "migrations");

/** The labelled tables, by their names in SQL, as the schema declares them. */
function labelledTables(): Set<string> {
  const schema = readFileSync(join(ROOT, "src", "db", "schema.ts"), "utf8");
  const starts = [...schema.matchAll(/export const \w+ = pgTable\(\s*"(\w+)"/g)];
  const names = new Set<string>();
  starts.forEach((m, i) => {
    const body = schema.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index! : schema.length);
    if (body.includes("sensitivityLabelColumn()")) names.add(m[1]!);
  });
  return names;
}

/** SQL with its comments removed, so a sentence about an insert is not read as one. */
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Each INSERT into a labelled table that does not name sensitivity_label, as "table: the statement's head". */
export function unlabelledInserts(sql: string, tables: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const m of withoutComments(sql).matchAll(/INSERT\s+INTO\s+(?:"?public"?\.)?"?(\w+)"?\s*(\(([^)]*)\))?/gi)) {
    const table = m[1]!.toLowerCase();
    if (!tables.has(table)) continue;
    // No column list at all leaves the column to its position or its default.
    if (m[3] === undefined || !/\bsensitivity_label\b/.test(m[3])) {
      found.push(`${table}: ${m[0].replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return found;
}

describe("a migration that inserts into a labelled table", () => {
  const tables = labelledTables();
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const changed = journal.entries.findIndex((e) => e.tag.endsWith("_label_enforcement"));

  it("finds the labelled tables and the migration that changed the default", () => {
    expect(tables.size).toBe(139);
    expect(changed).toBeGreaterThan(100);
  });

  it("names sensitivity_label, in every migration after the default became the connection's label", () => {
    const missing: string[] = [];
    for (const entry of journal.entries.slice(changed + 1)) {
      const sql = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
      for (const insert of unlabelledInserts(sql, tables)) missing.push(`${entry.tag}.sql ${insert}`);
    }
    expect(
      missing,
      "These inserts leave sensitivity_label to its default, which is refused on a deployment with more than one " +
        "label. Name the column: the label of the row this one is derived from, or the label the migration means."
    ).toEqual([]);
  });

  it("tells an insert that names its label from one that does not", () => {
    const some = new Set(["claims", "grants"]);
    expect(unlabelledInserts(`INSERT INTO claims (text) VALUES ('x');`, some)).toHaveLength(1);
    expect(unlabelledInserts(`insert into "claims" ("text") select text from old;`, some)).toHaveLength(1);
    expect(unlabelledInserts(`INSERT INTO public.grants SELECT * FROM staging;`, some)).toHaveLength(1);
    expect(unlabelledInserts(`INSERT INTO claims (text, sensitivity_label) SELECT text, sensitivity_label FROM old;`, some)).toEqual([]);
    expect(unlabelledInserts(`INSERT INTO "grants" ("name", "sensitivity_label") VALUES ('g', 'public');`, some)).toEqual([]);
    // A table with no label, and an insert that is only talked about.
    expect(unlabelledInserts(`INSERT INTO platform_flags (key) VALUES ('k');`, some)).toEqual([]);
    expect(unlabelledInserts(`-- INSERT INTO claims (text) VALUES ('x') would be refused\nSELECT 1;`, some)).toEqual([]);
  });
});
