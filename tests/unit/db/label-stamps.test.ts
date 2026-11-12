/**
 * Every insert into a table that carries a label says what the label is.
 *
 * An insert that names no label gets the label of the connection it arrives
 * on (the column's default, src/db/clearance.ts): inside a run that is the
 * run's label, so a forgotten stamp is no longer written as public. It is
 * still not what the code meant to say. A row derived from another carries
 * that row's label, not the run's, and an insert on a connection with no
 * label is refused where a second label exists. So every insert under src
 * says its label itself, and this reads the source to hold each one to
 * that: the DB tests drive one seam for each table, and an insert site none
 * of them reaches, or one added later, is held to the same rule.
 *
 * The rule is about the statement, not the value: an insert names
 * sensitivity_label (raw SQL) or sets sensitivityLabel (drizzle). What it
 * gives is checked where the seam is driven (tests/db/label-*.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

/** The labelled tables: their names in SQL and the names of their drizzle objects. */
function labelledTables(): { sql: Set<string>; drizzle: Map<string, string> } {
  const schema = readFileSync(join(SRC, "db", "schema.ts"), "utf8");
  const starts = [...schema.matchAll(/export const (\w+) = pgTable\(\s*"(\w+)"/g)];
  const sql = new Set<string>();
  const drizzle = new Map<string, string>();
  starts.forEach((m, i) => {
    const body = schema.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index! : schema.length);
    if (!body.includes("sensitivityLabelColumn()")) return;
    sql.add(m[2]!);
    drizzle.set(m[1]!, m[2]!);
  });
  return { sql, drizzle };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "migrations" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

describe("an insert into a labelled table", () => {
  const tables = labelledTables();

  it("finds the labelled tables in the schema", () => {
    // Ninety-five of the schema's tables carry a label; tests/db/labels.test.ts lists them.
    expect(tables.sql.size).toBe(95);
    expect(tables.sql.has("agent_steps")).toBe(true);
    expect(tables.sql.has("owl_ledger")).toBe(false);
  });

  it("names sensitivity_label when it is written in SQL", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/INSERT INTO\s+"?(\w+)"?\s*\(/g)) {
        if (!tables.sql.has(m[1]!)) continue;
        seen++;
        // The column list: from the parenthesis that opens it to the one that closes it.
        const open = m.index! + m[0].length;
        const columns = text.slice(open, text.indexOf(")", open));
        if (!/\bsensitivity_label\b/.test(columns)) missing.push(`${relative(ROOT, file)}:${lineOf(text, m.index!)} ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
    // The scan found the inserts it is about.
    expect(seen).toBeGreaterThan(150);
  });

  it("sets sensitivityLabel when it is written through drizzle", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\.insert\((\w+)\)\s*(?:\/\/[^\n]*\n\s*)*\.values\(/g)) {
        if (!tables.drizzle.has(m[1]!)) continue;
        seen++;
        // The values: to the parenthesis that closes the call.
        const open = m.index! + m[0].length;
        let depth = 1;
        let end = open;
        while (end < text.length && depth > 0) {
          if (text[end] === "(") depth++;
          else if (text[end] === ")") depth--;
          end++;
        }
        const values = text.slice(open, end);
        // An object built elsewhere and passed whole (`.values(newClaim)`) is read where it is built.
        const built = /^\s*\w+\s*\)$/.test(values) ? text : values;
        if (!/\bsensitivityLabel\b/.test(built)) missing.push(`${relative(ROOT, file)}:${lineOf(text, m.index!)} ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThan(20);
  });
});
