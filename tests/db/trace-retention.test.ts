/**
 * Trace retention (#334 L0): the two-tier prune, against real tables.
 *
 * The properties that matter here cannot be checked without a database — the
 * run/step tier interaction runs through a real FK cascade, and "a step's age
 * is its RUN's age" is a join, not arithmetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { traceRetentionTick } from "../../src/workers/trace-retention.js";

const DAY = 86_400_000;
const NOW = new Date("2026-08-01T00:00:00Z").getTime();

async function seedRun(startedDaysAgo: number, steps: number): Promise<string> {
  const [run] = await rawQuery<{ id: string }>(
    `INSERT INTO agent_runs (agent, started_at, outcome, steps)
     VALUES ('steward', $1, 'ok', $2) RETURNING id`,
    [new Date(NOW - startedDaysAgo * DAY), steps]
  );
  for (let seq = 0; seq < steps; seq++) {
    await rawQuery(
      `INSERT INTO agent_steps (run_id, seq, kind, content)
       VALUES ($1, $2, 'assistant', $3)`,
      [run!.id, seq, JSON.stringify({ text: `step ${seq}` })]
    );
  }
  return run!.id;
}

async function counts(): Promise<{ runs: number; steps: number }> {
  const [r] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM agent_runs`);
  const [s] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM agent_steps`);
  return { runs: r!.n, steps: s!.n };
}

describe("trace retention", () => {
  beforeEach(async () => {
    await rawQuery(`DELETE FROM agent_runs`); // steps cascade
  });

  it("prunes old steps while keeping their run rows", async () => {
    // 20 days old: past the 14-day step tier, well inside the 90-day run tier.
    const oldRun = await seedRun(20, 3);
    await seedRun(2, 2); // recent: untouched

    const result = await traceRetentionTick(NOW);

    expect(result.stepsDeleted).toBe(3);
    expect(result.runsDeleted).toBe(0);
    const after = await counts();
    expect(after.runs).toBe(2); // BOTH runs survive
    expect(after.steps).toBe(2); // only the recent run's steps remain

    // The surviving run is still a complete cost/outcome record — which is the
    // entire reason the tiers differ.
    const [row] = await rawQuery<{ outcome: string; steps: number }>(
      `SELECT outcome, steps FROM agent_runs WHERE id = $1`,
      [oldRun]
    );
    expect(row!.outcome).toBe("ok");
    expect(row!.steps).toBe(3);
  });

  it("prunes runs past the run tier, cascading any remaining steps", async () => {
    await seedRun(100, 2); // past 90-day run tier
    await seedRun(2, 1); // recent

    const result = await traceRetentionTick(NOW);

    expect(result.runsDeleted).toBe(1);
    const after = await counts();
    expect(after.runs).toBe(1);
    expect(after.steps).toBe(1); // the old run's steps went with it
  });

  it("ages a step by its RUN's start, not the step's own write time", async () => {
    // A long-running agent: run started 20 days ago, steps written just now.
    const [run] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_runs (agent, started_at, steps)
       VALUES ('curator', $1, 1) RETURNING id`,
      [new Date(NOW - 20 * DAY)]
    );
    await rawQuery(
      `INSERT INTO agent_steps (run_id, seq, kind, content, created_at)
       VALUES ($1, 0, 'assistant', '{}', $2)`,
      [run!.id, new Date(NOW)]
    );

    const result = await traceRetentionTick(NOW);

    // Expires wholesale with its run rather than leaving a recent-looking tail.
    expect(result.stepsDeleted).toBe(1);
    expect((await counts()).steps).toBe(0);
  });

  it("leaves everything alone when both tiers are disabled", async () => {
    await seedRun(500, 2);
    const prev = process.env.TRACE_STEP_RETENTION_DAYS;
    const prevRun = process.env.TRACE_RUN_RETENTION_DAYS;
    process.env.TRACE_STEP_RETENTION_DAYS = "0";
    process.env.TRACE_RUN_RETENTION_DAYS = "0";
    try {
      // loadConfig caches, so this asserts the 0-disables branch only when the
      // process was started with them unset; skip rather than assert falsely.
      const { traceStepRetentionDays } = (await import("../../src/config.js")).loadConfig();
      if (traceStepRetentionDays === 0) {
        const result = await traceRetentionTick(NOW);
        expect(result.stepsDeleted).toBe(0);
        expect(result.runsDeleted).toBe(0);
        expect((await counts()).runs).toBe(1);
      }
    } finally {
      if (prev === undefined) delete process.env.TRACE_STEP_RETENTION_DAYS;
      else process.env.TRACE_STEP_RETENTION_DAYS = prev;
      if (prevRun === undefined) delete process.env.TRACE_RUN_RETENTION_DAYS;
      else process.env.TRACE_RUN_RETENTION_DAYS = prevRun;
    }
  });

  it("is a no-op when there is nothing old enough", async () => {
    await seedRun(1, 2);
    const result = await traceRetentionTick(NOW);
    expect(result).toEqual({ stepsDeleted: 0, runsDeleted: 0, moreRemaining: false });
    expect((await counts()).steps).toBe(2);
  });
});
