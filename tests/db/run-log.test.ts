/**
 * The run log as a hash chain (#552): real runs under withAgent against the
 * scratch database, checked by the verifier, then tampered with in SQL to
 * see each kind of damage found. Also record mode: a run that waits on its
 * seal, and one that fails because its log could not be written.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Tracing is off under vitest by default; this file is about the log.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { getUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { recordAgentStep, RunLogError } from "../../src/services/trace-service.js";
import { getRunStep, getRunSummary, verifyRunLog, type RunLogCheck } from "../../src/services/run-view-service.js";
import { genesisHash, stepHash } from "../../src/services/run-log.js";
import { traceRetentionTick } from "../../src/workers/trace-retention.js";

const STEPS: Array<[Parameters<typeof recordAgentStep>[1], unknown]> = [
  ["prompt", { model: "m", system: "the constitution", tools: [{ name: "search" }], z: 1, a: { y: [1.5, "é", null], b: true } }],
  ["assistant", { stopReason: "tool_use", content: [{ type: "tool_use", name: "search", input: { q: "x" } }] }],
  ["tool_results", [{ name: "search", input: { q: "x" }, output: "found: 1e21 and 0.1" }]],
  ["assistant", { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] }],
];

/** A run that records the steps above. In best-effort mode its writes settle after it returns. */
async function run(steps = STEPS): Promise<string> {
  return withAgent("matcher", async () => {
    const trace = getUsageContext().trace!;
    for (const [kind, content] of steps) recordAgentStep(trace, kind, content);
    return trace.runId;
  });
}

async function sealedAt(id: string): Promise<Date | null> {
  const [row] = await rawQuery<{ sealed_at: Date | null }>(`SELECT sealed_at FROM agent_runs WHERE id = $1`, [id]);
  return row?.sealed_at ?? null;
}

async function settled(id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [row] = await rawQuery<{ finished_at: Date | null }>(`SELECT finished_at FROM agent_runs WHERE id = $1`, [id]);
    if (row?.finished_at) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the run did not close");
}

async function verify(id: string): Promise<RunLogCheck> {
  const check = await verifyRunLog(id);
  if (!check || "withheld" in check) throw new Error("expected a check");
  return check;
}

const config = loadConfig() as { runLogMode: "best_effort" | "record" };
afterEach(() => {
  config.runLogMode = "best_effort";
});

describe("a run's log", () => {
  it("is chained step by step and sealed when the run closes whole", async () => {
    const id = await run();
    await settled(id);

    const rows = await rawQuery<{ seq: number; kind: string; content: unknown; prev_hash: string; hash: string }>(
      `SELECT seq, kind, content, prev_hash, hash FROM agent_steps WHERE run_id = $1 ORDER BY seq`,
      [id]
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    // The hashes are over the content as the jsonb column returns it.
    let prev = genesisHash(id);
    for (const r of rows) {
      expect(r.prev_hash).toBe(prev);
      expect(r.hash).toBe(stepHash(prev, r.seq, r.kind, r.content));
      prev = r.hash;
    }

    const summary = await getRunSummary(id);
    if (!summary || "withheld" in summary) throw new Error("expected a public run");
    expect(summary.log_hash).toBe(prev);
    expect(summary.sealed_at).not.toBeNull();

    expect(await verify(id)).toMatchObject({
      sealed: true, log_hash: prev, head: prev, intact: true, problem: null,
      steps_counted: 4, steps_recorded: 4, steps_checked: 4,
    });
    const step = await getRunStep(id, 2);
    expect(step).toMatchObject({ prev_hash: rows[1]!.hash, hash: rows[2]!.hash });
  });

  it("checks a long run a page at a time", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ["assistant", { stopReason: "tool_use", n: i }] as (typeof STEPS)[number]);
    const id = await run(many);
    await settled(id);
    expect(await verify(id)).toMatchObject({ sealed: true, intact: true, steps_checked: 60 });
  });

  it("shows a step altered after the seal", async () => {
    const id = await run();
    await settled(id);
    await rawQuery(
      `UPDATE agent_steps SET content = jsonb_set(content, '{0,output}', '"found: nothing"') WHERE run_id = $1 AND seq = 2`,
      [id]
    );
    expect(await verify(id)).toMatchObject({ intact: false, steps_checked: 2, problem: { seq: 2, reason: "hash_mismatch" } });
  });

  it("shows a step removed, from the middle or from the end", async () => {
    const middle = await run();
    await settled(middle);
    await rawQuery(`DELETE FROM agent_steps WHERE run_id = $1 AND seq = 1`, [middle]);
    expect((await verify(middle)).problem).toEqual({ seq: 1, reason: "missing" });

    const end = await run();
    await settled(end);
    await rawQuery(`DELETE FROM agent_steps WHERE run_id = $1 AND seq = 3`, [end]);
    expect((await verify(end)).problem).toEqual({ seq: 3, reason: "fewer_steps_than_counted" });
  });

  it("shows a step added after the seal", async () => {
    const id = await run();
    await settled(id);
    const [last] = await rawQuery<{ hash: string }>(`SELECT hash FROM agent_steps WHERE run_id = $1 AND seq = 3`, [id]);
    const content = { stopReason: "end_turn", content: [{ type: "text", text: "added later" }] };
    await rawQuery(
      `INSERT INTO agent_steps (run_id, seq, kind, content, prev_hash, hash) VALUES ($1, 4, 'assistant', $2::jsonb, $3, $4)`,
      [id, JSON.stringify(content), last!.hash, stepHash(last!.hash, 4, "assistant", content)]
    );
    expect((await verify(id)).problem).toEqual({ seq: null, reason: "seal_mismatch" });
  });

  it("refuses a second step with a sequence number already chained", async () => {
    const id = await run();
    await settled(id);
    await expect(
      rawQuery(
        `INSERT INTO agent_steps (run_id, seq, kind, content, prev_hash, hash) VALUES ($1, 1, 'assistant', '{}'::jsonb, 'p', 'h')`,
        [id]
      )
    ).rejects.toThrow(/uq_agent_steps_chained/);
  });

  it("reads a run from before the chain as not chained, and unsealed", async () => {
    const [old] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_runs (agent, finished_at, outcome, steps) VALUES ('matcher', now(), 'ok', 1) RETURNING id`
    );
    await rawQuery(`INSERT INTO agent_steps (run_id, seq, kind, content) VALUES ($1, 0, 'assistant', '{}'::jsonb)`, [old!.id]);
    expect(await verify(old!.id)).toMatchObject({
      sealed: false, log_hash: null, intact: false, problem: { seq: 0, reason: "not_chained" },
    });
  });
});

describe("record mode", () => {
  it("does not return until the log is sealed", async () => {
    config.runLogMode = "record";
    const id = await run();
    // No waiting: the seal is there by the time the run's result is.
    expect(await sealedAt(id)).not.toBeNull();
    expect(await verify(id)).toMatchObject({ sealed: true, intact: true, steps_checked: 4 });
  });

  it("keeps a step whole however large it is", async () => {
    config.runLogMode = "record";
    const big = "x".repeat(300_000);
    const id = await run([["tool_results", [{ name: "read_page", output: big }]]]);
    const step = await getRunStep(id, 0);
    if (!step || "withheld" in step) throw new Error("expected a step");
    expect((step.content as Array<{ output: string }>)[0]!.output.length).toBe(300_000);
    expect((await verify(id)).intact).toBe(true);
  });

  it("fails a run whose log could not be written whole, and leaves it unsealed", async () => {
    config.runLogMode = "record";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let id = "";
    await expect(
      withAgent("matcher", async () => {
        const trace = getUsageContext().trace!;
        id = trace.runId;
        recordAgentStep(trace, "assistant", { stopReason: "tool_use" });
        // jsonb cannot hold a NUL character, so this step's insert fails.
        recordAgentStep(trace, "tool_results", [{ name: "read_page", output: "bad \u0000 byte" }]);
        recordAgentStep(trace, "assistant", { stopReason: "end_turn" });
        return "result";
      })
    ).rejects.toBeInstanceOf(RunLogError);
    errors.mockRestore();

    expect(await sealedAt(id)).toBeNull();
    // The step after the lost one still chains from it, so the gap shows.
    expect(await verify(id)).toMatchObject({
      sealed: false, intact: false, steps_counted: 3, steps_recorded: 2, problem: { seq: 1, reason: "missing" },
    });
  });

  it("expires nothing", async () => {
    const id = await run();
    await settled(id);
    await rawQuery(`UPDATE agent_runs SET started_at = now() - interval '400 days' WHERE id = $1`, [id]);
    config.runLogMode = "record";
    expect(await traceRetentionTick()).toEqual({ deleted: 0, swept: false });
    expect(await sealedAt(id)).not.toBeNull();
  });
});
