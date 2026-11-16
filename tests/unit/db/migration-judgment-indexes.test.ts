/**
 * Which index says a node has one current judgment is the database's to
 * say, not a migration's (src/db/schema.ts, idx_assessments_current).
 *
 * On a deployment with one label each judgment table has its index of one
 * current row for each node. Where a second label exists, the step that
 * turns enforcement on (minerval_enforcement_sync) has dropped that index
 * and created one for each node and label in its place. So a migration
 * that drops, recreates or alters one of these by name would fail on one
 * kind of deployment or the other, and one that needs to change them has
 * to change the step. This reads every migration after the one that
 * introduced the swap and fails on one that names them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "src", "db", "migrations");
const INDEXES = [
  "idx_assessments_current",
  "idx_argument_evaluations_current",
  "idx_quantity_estimates_current",
  "idx_question_assessments_current",
];

describe("the indexes that say a node has one current judgment", () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const swap = journal.entries.findIndex((e) => e.tag.endsWith("_judgments_per_label"));

  it("are swapped by the step in the migration that brought a judgment at each label, and not changed by that migration itself", () => {
    expect(swap).toBeGreaterThan(100);
    const sql = readFileSync(join(MIGRATIONS, `${journal.entries[swap]!.tag}.sql`), "utf8");
    for (const index of INDEXES) {
      // Named in the step's list, and nowhere as a statement of the migration's own.
      expect(sql, index).toContain(`'${index}'`);
      expect(sql, index).not.toMatch(new RegExp(`(?:DROP|CREATE(?: UNIQUE)?) INDEX "${index}"`));
    }
    expect(sql).toContain("|| '_at_label'");
  });

  it("are named by no later migration", () => {
    const wrong: string[] = [];
    for (const entry of journal.entries.slice(swap + 1)) {
      const sql = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8");
      for (const index of INDEXES) {
        if (new RegExp(`\\b${index}(?:_at_label)?\\b`).test(sql)) wrong.push(`${entry.tag}.sql names ${index}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
