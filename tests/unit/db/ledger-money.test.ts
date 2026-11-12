import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { ALLOCATION_MONEY, REGRANT_MONEY } from "../../../src/db/money.js";

/**
 * The ledger's money is read whole (src/db/money.ts).
 *
 * `action_allocations` and `regrants` carry a label, for the text beside
 * the money, so a statement on either table sees the rows at the labels its
 * connection reads. A sum taken that way is short on a deployment with a
 * second label, and short in the direction that spends money twice: a
 * mandate's room looks larger than it is, a run's cost is split across
 * fewer payers than covered it. So money is read and settled through the
 * whole views, and the tables are named only to add a row, which is held to
 * its writer's label, to read the text, or to show a reader what was placed
 * (a listing or a feed, which is for the readers of each row's label).
 *
 * Every statement under src/ that names one of the two tables is listed
 * here with what it is there for. A failure means one was added or moved:
 * if it reads or changes money, it belongs on the view.
 */
const ON_THE_TABLE: Record<string, string[]> = {
  "src/services/action-service.ts": ["INTO action_allocations: the record of a shortfall met, added at the label of the row that ran."],
  "src/services/allocation-service.ts": ["INTO action_allocations: a mandate's money on its own row, added at the label of that row."],
  "src/services/bounty-service.ts": ["INTO action_allocations: a prize reserve's money on an audit, added at the label of the work in progress."],
  "src/services/commission-service.ts": [
    "INTO action_allocations: a mandate's commission, added at the label of the work that placed it.",
    "INTO action_allocations: a person's commission, added at the label of the request that placed it.",
    "INTO action_allocations: a run's commission from its own budget, added at the run's label.",
  ],
  "src/services/graph-change-service.ts": [
    "FROM action_allocations: the change feed's commission events, shown to the readers of the label each was placed at.",
  ],
  "src/services/mandate-service.ts": [
    "FROM action_allocations: a mandate's commissions as a reader is shown them, each with its reason. A listing with text, so it shows the rows the reader's clearance reads.",
  ],
  "src/services/prize-claim-service.ts": ["INTO action_allocations: a prize reserve's money on a review, added at the label of the work in progress."],
  "src/services/regrant-service.ts": [
    "FROM regrants: the note of a regrant into this mandate, read at the labels the reader holds.",
    "FROM regrants: the note of a regrant out of this mandate, read at the labels the reader holds.",
    "INTO regrants: a regrant, added at the label of the work that moved the money.",
  ],
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "migrations" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && entry.name !== "schema.ts" ? [path] : [];
  });
}

const BARE = /\b(FROM|JOIN|UPDATE|INTO)\s+(action_allocations|regrants)\b/g;
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Each statement in a file that names one of the two tables, as "VERB table", in order. */
export function statementsOnTheTables(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !isComment(line))
    .flatMap((line) => [...line.matchAll(BARE)].map((m) => `${m[1]} ${m[2]}`))
    .sort();
}

describe("the ledger's money", () => {
  const rel = (path: string) => relative(repo, path).split("\\").join("/");

  it("is read and settled through the whole views; every statement on the tables is listed with what it is for", () => {
    const found: Record<string, string[]> = {};
    for (const path of sourceFiles(join(repo, "src"))) {
      const statements = statementsOnTheTables(readFileSync(path, "utf-8"));
      if (statements.length > 0) found[rel(path)] = statements;
    }
    const listed = Object.fromEntries(
      Object.entries(ON_THE_TABLE).map(([file, uses]) => [file, uses.map((u) => u.split(":")[0]!).sort()])
    );
    expect(found).toEqual(listed);
  });

  it("adds no row through a view, where it would not be held to its writer's label", () => {
    for (const path of sourceFiles(join(repo, "src"))) {
      const text = readFileSync(path, "utf-8");
      expect(text.includes(`INTO ${ALLOCATION_MONEY}`) || text.includes(`INTO ${REGRANT_MONEY}`), rel(path)).toBe(false);
    }
  });

  it("names the views the migration made", () => {
    const migration = readFileSync(
      join(repo, "src/db/migrations", readdirSync(join(repo, "src/db/migrations")).find((f) => f.endsWith("_label_enforcement.sql"))!),
      "utf-8"
    );
    expect(migration).toContain(`CREATE OR REPLACE VIEW ${ALLOCATION_MONEY} AS`);
    expect(migration).toContain(`CREATE OR REPLACE VIEW ${REGRANT_MONEY} AS`);
    // And the views carry no text an agent wrote.
    const allocation = migration.slice(migration.indexOf(`VIEW ${ALLOCATION_MONEY} AS`), migration.indexOf(`VIEW ${REGRANT_MONEY} AS`));
    expect(allocation).not.toMatch(/\b(brief|reason)\b/);
    const regrant = migration.slice(migration.indexOf(`VIEW ${REGRANT_MONEY} AS`)).split("--> statement-breakpoint")[0]!;
    expect(regrant).not.toMatch(/\bnote\b/);
  });

  it("tells a statement on a table from one on a view, and from a comment", () => {
    expect(statementsOnTheTables("SELECT 1 FROM action_allocations al")).toEqual(["FROM action_allocations"]);
    expect(statementsOnTheTables(`SELECT 1 FROM ${ALLOCATION_MONEY} al JOIN ${REGRANT_MONEY} r ON true`)).toEqual([]);
    expect(statementsOnTheTables("  // SELECT 1 FROM regrants")).toEqual([]);
    expect(statementsOnTheTables("INSERT INTO regrants (a) VALUES (1)")).toEqual(["INTO regrants"]);
  });
});
