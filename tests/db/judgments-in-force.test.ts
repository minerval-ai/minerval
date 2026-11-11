/**
 * The judgment in force (#566) against real Postgres: each of the four views
 * (assessments_in_force, argument_evaluations_in_force,
 * quantity_estimates_in_force, question_assessments_in_force) returns exactly
 * the rows of its table where is_current is true, column for column.
 *
 * Every row is seeded on a fresh claim or argument of its own, so nothing
 * here touches a node another file reads.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";

async function seedArgument(): Promise<string> {
  const claimId = await seedClaim("in-force-argument");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO arguments (claim_id, stance, content, created_by)
     VALUES ($1, 'for', 'in-force test', 'dbtest') RETURNING id`,
    [claimId]
  );
  return row!.id;
}

interface Judgment {
  table: string;
  view: string;
  /** The column that names the node (or argument) the judgment is of. */
  key: string;
  /** A fresh node or argument to hang rows on. */
  owner: () => Promise<string>;
  /** Insert one row for `owner`, current or superseded, and return its id. */
  insert: (owner: string, isCurrent: boolean) => Promise<string>;
}

const JUDGMENTS: Judgment[] = [
  {
    table: "assessments",
    view: "assessments_in_force",
    key: "claim_id",
    owner: () => seedClaim("in-force-assessment"),
    insert: async (owner, isCurrent) => {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current)
         VALUES ($1, 'supported', 0.7, 'dbtest', $2) RETURNING id`,
        [owner, isCurrent]
      );
      return row!.id;
    },
  },
  {
    table: "argument_evaluations",
    view: "argument_evaluations_in_force",
    key: "argument_id",
    owner: seedArgument,
    insert: async (owner, isCurrent) => {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO argument_evaluations (argument_id, verdict, content, is_current)
         VALUES ($1, 'likely', 'dbtest', $2) RETURNING id`,
        [owner, isCurrent]
      );
      return row!.id;
    },
  },
  {
    table: "quantity_estimates",
    view: "quantity_estimates_in_force",
    key: "claim_id",
    owner: () => seedClaim("in-force-estimate"),
    insert: async (owner, isCurrent) => {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO quantity_estimates (claim_id, estimate, work, is_current)
         VALUES ($1, '{"form":"point","central":1}', 'dbtest', $2) RETURNING id`,
        [owner, isCurrent]
      );
      return row!.id;
    },
  },
  {
    table: "question_assessments",
    view: "question_assessments_in_force",
    key: "claim_id",
    owner: () => seedClaim("in-force-standing"),
    insert: async (owner, isCurrent) => {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, is_current)
         VALUES ($1, 'open', 'dbtest', $2) RETURNING id`,
        [owner, isCurrent]
      );
      return row!.id;
    },
  },
];

describe("the judgment in force", () => {
  for (const j of JUDGMENTS) {
    describe(j.view, () => {
      it("returns the current row and none of the superseded ones", async () => {
        // One owner judged three times: two superseded rows, one current.
        const revised = await j.owner();
        const old1 = await j.insert(revised, false);
        const old2 = await j.insert(revised, false);
        const current = await j.insert(revised, true);
        // One owner whose only rows are superseded: nothing is in force.
        const retired = await j.owner();
        const gone = await j.insert(retired, false);

        const inForce = await rawQuery<{ id: string; is_current: boolean }>(
          `SELECT id, is_current FROM ${j.view} WHERE ${j.key} = ANY($1::uuid[])`,
          [[revised, retired]]
        );
        expect(inForce).toEqual([{ id: current, is_current: true }]);

        // The table still holds all four: the view hides history, it does not remove it.
        const all = await rawQuery<{ id: string }>(
          `SELECT id FROM ${j.table} WHERE ${j.key} = ANY($1::uuid[])`,
          [[revised, retired]]
        );
        expect(all.map((r) => r.id).sort()).toEqual([old1, old2, current, gone].sort());
      });

      it("is exactly the table's current rows, column for column", async () => {
        const owner = await j.owner();
        await j.insert(owner, false);
        await j.insert(owner, true);

        // Compared as jsonb so that neither the order of the columns nor a
        // column left out of the view can pass unnoticed.
        const [diff] = await rawQuery<{ only_in_view: number; only_in_table: number; in_view: number }>(
          `SELECT
             (SELECT count(*)::int FROM (
                SELECT to_jsonb(v) FROM ${j.view} v
                EXCEPT
                SELECT to_jsonb(t) FROM ${j.table} t WHERE t.is_current = true) a) AS only_in_view,
             (SELECT count(*)::int FROM (
                SELECT to_jsonb(t) FROM ${j.table} t WHERE t.is_current = true
                EXCEPT
                SELECT to_jsonb(v) FROM ${j.view} v) b) AS only_in_table,
             (SELECT count(*)::int FROM ${j.view}) AS in_view`
        );
        expect(diff!.only_in_view).toBe(0);
        expect(diff!.only_in_table).toBe(0);
        expect(diff!.in_view).toBeGreaterThan(0);
      });
    });
  }
});
