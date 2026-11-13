/**
 * How many connections the session pools hold open between them
 * (src/db/client.ts, makeRoom).
 *
 * Where a deployment has more than one label, each session (a label, or a
 * reader's clearance) has a pool of its own. The pools were bounded in how
 * many connections they had in use at once, and not in how many they held
 * open: each kept its idle connections for ten seconds, so work that moved
 * through several sessions inside that time held a multiple of what it
 * used. tests/db/private-on-mirror.test.ts held about seventy connections
 * that way, of the hundred a server allows, and failed with "remaining
 * connection slots are reserved" when anything else was on the cluster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openSessionConnections, rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runAtLabel } from "../../src/llm/usage-context.js";

const LABELS = ["pool-a", "pool-b", "pool-c", "pool-d"];
const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test defines and removes labels.", fn);

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    for (const label of LABELS) {
      await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'A label for the pool test.') ON CONFLICT (name) DO NOTHING`, [label]);
    }
  });
  await ensureEnforcement();
});

afterAll(async () => {
  await system(() => rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [LABELS])).catch(() => undefined);
});

describe("the session pools together", () => {
  it("hold open no more connections than they may have in use, however many sessions the work moves through", async () => {
    const most: number[] = [];
    for (let round = 0; round < 2; round++) {
      for (const label of ["public", ...LABELS]) {
        // Fifteen statements at once at this label: fifteen connections of its pool.
        await runAtLabel(label, "a burst of work at one label", () =>
          Promise.all(Array.from({ length: 15 }, () => rawQuery(`SELECT pg_sleep(0.05)`)))
        );
        most.push(openSessionConnections());
      }
    }
    // Twenty, and for a moment the one or two being closed.
    expect(Math.max(...most)).toBeLessThanOrEqual(22);
    // The server agrees: this process's connections as the cleared role.
    const [held] = await system(() =>
      rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'minerval_cleared'`
      )
    );
    expect(held!.n).toBeLessThanOrEqual(22);
  });
});
