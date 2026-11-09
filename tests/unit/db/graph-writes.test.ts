import { describe, expect, it } from "vitest";
import { BOOKKEEPING_TABLES, writesGraph } from "../../../src/db/graph-writes.js";

describe("writesGraph", () => {
  it("counts writes to graph tables, in drizzle's form and hand-written SQL", () => {
    expect(writesGraph(`insert into "assessments" ("claim_id") values ($1)`)).toBe(true);
    expect(writesGraph(`update "claims" set "text" = $1 where "id" = $2`)).toBe(true);
    expect(writesGraph(`delete from "taggings" where "id" = $1`)).toBe(true);
    expect(writesGraph(`INSERT INTO question_assessments (claim_id) VALUES ($1)`)).toBe(true);
    expect(writesGraph(`UPDATE public.arguments SET name = $1`)).toBe(true);
  });

  it("finds a write inside a CTE", () => {
    expect(
      writesGraph(`WITH moved AS (DELETE FROM claim_links WHERE id = $1 RETURNING *) SELECT 1`)
    ).toBe(true);
  });

  it("ignores reads, including row locks", () => {
    expect(writesGraph(`select * from "claims" where "id" = $1`)).toBe(false);
    expect(writesGraph(`SELECT id FROM claims WHERE id = $1 FOR UPDATE SKIP LOCKED`)).toBe(false);
  });

  it("ignores bookkeeping: run telemetry, money, the queue, credentials", () => {
    for (const table of BOOKKEEPING_TABLES) {
      expect(writesGraph(`INSERT INTO ${table} (id) VALUES ($1)`)).toBe(false);
    }
    expect(writesGraph(`update "agent_runs" set "wrote_to_graph" = $1`)).toBe(false);
  });

  it("ignores targets that are not schema tables", () => {
    expect(writesGraph(`INSERT INTO not_a_table (id) VALUES ($1)`)).toBe(false);
  });

  it("counts a statement that writes bookkeeping and graph state together", () => {
    expect(
      writesGraph(
        `WITH l AS (INSERT INTO owl_ledger (user_id) VALUES ($1)) INSERT INTO bounties (claim_id) VALUES ($2)`
      )
    ).toBe(true);
  });
});
