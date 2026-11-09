/**
 * Runs that wrote to the graph are kept; the rest expire (#552 groundwork).
 *
 * Real agent runs under withAgent, with tracing on, against the scratch
 * database: the statement observer marks a run on its first graph write,
 * the question assessment write stamps its run, and the retention sweep
 * deletes only unmarked runs.
 */
import { describe, it, expect, vi } from "vitest";

// Tracing is off under vitest by default; this file is about traces.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

import { rawQuery } from "../../src/db/client.js";
import { withAgent, getUsageContext } from "../../src/llm/usage-context.js";
import { traceRetentionTick } from "../../src/workers/trace-retention.js";
import { seedClaim } from "./helpers.js";

/** Fire-and-forget trace writes settle on their own; wait for them. */
async function settle(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("trace writes did not settle");
}

async function runRow(id: string) {
  const [row] = await rawQuery<{ wrote_to_graph: boolean; finished_at: Date | null }>(
    `SELECT wrote_to_graph, finished_at FROM agent_runs WHERE id = $1`,
    [id]
  );
  return row;
}

describe("graph-writing runs", () => {
  it("marks a run on its first graph write, and not on bookkeeping", async () => {
    const claimId = await seedClaim("retention");

    const writer = await withAgent("steward", async () => {
      await rawQuery(`INSERT INTO audit_log (claim_id, action) VALUES ($1, 'test')`, [claimId]);
      return getUsageContext().runId!;
    });
    const reader = await withAgent("grantmaker", async () => {
      await rawQuery(`SELECT id FROM claims WHERE id = $1`, [claimId]);
      // Telemetry about runs is not graph state.
      await rawQuery(
        `INSERT INTO enqueue_events (queue, trigger) VALUES ('test', 'test')`
      );
      return getUsageContext().runId!;
    });

    await settle(async () => (await runRow(writer))?.finished_at != null && (await runRow(reader))?.finished_at != null);
    await settle(async () => (await runRow(writer))!.wrote_to_graph);
    expect((await runRow(reader))!.wrote_to_graph).toBe(false);
  });

  it("stamps the writing run on a question assessment", async () => {
    const { markQuestion, recordQuestionAssessment } = await import(
      "../../src/services/question-service.js"
    );
    const q = { id: await seedClaim("question") };
    await markQuestion(q.id);
    const runId = await withAgent("steward", async () => {
      await recordQuestionAssessment({
        claimId: q!.id,
        standing: "open",
        reasoningTrace: "Nothing settles it yet.",
      });
      return getUsageContext().runId!;
    });
    const [row] = await rawQuery<{ run_id: string | null }>(
      `SELECT run_id FROM question_assessments WHERE claim_id = $1 AND is_current`,
      [q!.id]
    );
    expect(row!.run_id).toBe(runId);
    await settle(async () => (await runRow(runId))?.wrote_to_graph === true);
  });

  it("expires old runs that wrote nothing and keeps old runs that wrote", async () => {
    const [kept] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_runs (agent, started_at, wrote_to_graph)
       VALUES ('steward', now() - interval '400 days', true) RETURNING id`
    );
    const [expired] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_runs (agent, started_at)
       VALUES ('lookout', now() - interval '400 days') RETURNING id`
    );
    await traceRetentionTick();
    expect(await runRow(kept!.id)).toBeDefined();
    expect(await runRow(expired!.id)).toBeUndefined();
  });
});
