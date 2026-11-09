/**
 * Reading agent runs (#553): public runs in full, private runs withheld with
 * their reasons, steps as summaries with a cursor and in full.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { getRunStep, getRunSummary, listRunSteps } from "../../src/services/run-view-service.js";
import { hashText } from "../../src/services/setup-split.js";
import { seedClaim } from "./helpers.js";

async function seedRun(opts: { reasons?: string[] } = {}): Promise<string> {
  const claimId = await seedClaim("run-view");
  const [run] = await rawQuery<{ id: string }>(
    `INSERT INTO agent_runs (agent, claim_id, finished_at, outcome, steps, commit_sha, private_reasons, user_id)
     VALUES ('steward', $1, now(), 'ok', 4, 'abc1234', $2::text[], $3) RETURNING id`,
    [claimId, opts.reasons ?? [], randomUUID()]
  );
  const roleHash = hashText(`role ${randomUUID()}`);
  const name = `test-role-${randomUUID()}`;
  await rawQuery(
    `INSERT INTO setup_parts (kind, name, hash, version, content, public) VALUES ('role', $1, $2, 1, 'r', true)`,
    [name, roleHash]
  );
  const steps: Array<[string, unknown]> = [
    ["prompt", { model: "claude-opus-5-5", tools: [{ name: "get_claim" }], initialMessages: [{ role: "user", content: "Assess it." }],
      setup: { commit: "abc1234", model: "claude-opus-5-5", effort: "high", maxTokens: null, temperature: null,
        parts: [{ kind: "role", hash: roleHash, name: null }] } }],
    ["assistant", { stopReason: "tool_use", content: [{ type: "text", text: "Reading the claim." }, { type: "tool_use", name: "get_claim", input: {} }] }],
    ["tool_results", [{ name: "get_claim", input: {}, output: "{\"status\":\"supported\"}" }]],
    ["assistant", { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] }],
  ];
  for (const [i, [kind, content]] of steps.entries()) {
    await rawQuery(`INSERT INTO agent_steps (run_id, seq, kind, content) VALUES ($1, $2, $3, $4::jsonb)`, [
      run!.id, i, kind, JSON.stringify(content),
    ]);
  }
  await rawQuery(
    `INSERT INTO llm_usage (agent, model, cost_micro_usd, run_id) VALUES ('steward', 'claude-opus-5-5', 250000, $1)`,
    [run!.id]
  );
  return run!.id;
}

describe("reading agent runs", () => {
  it("serves a public run with its setup versions, cost and commit, and no account", async () => {
    const id = await seedRun();
    const run = await getRunSummary(id);
    expect(run).toMatchObject({
      public: true, private_reasons: [], agent: "steward", steps_counted: 4, steps_recorded: 4,
      model_calls: 1, cost_usd: 0.25, commit: "abc1234",
    });
    if (!run || "withheld" in run) throw new Error("expected a public run");
    expect(run.setup!.parts[0]).toMatchObject({ kind: "role", version: 1 });
    expect(run.setup!.parts[0]!.name).toMatch(/^test-role-/);
    expect(JSON.stringify(run)).not.toMatch(/user_id|job_id/);
  });

  it("lists steps as summaries, a page at a time, filterable by tool", async () => {
    const id = await seedRun();
    const first = await listRunSteps(id, { limit: 2 });
    if (!first || !("steps" in first)) throw new Error("expected steps");
    expect(first.steps.map((s) => s.kind)).toEqual(["prompt", "assistant"]);
    expect(first.steps[1]!.summary).toContain("calls get_claim");
    expect(first.next_after).toBe(1);
    const rest = await listRunSteps(id, { after: first.next_after!, limit: 2 });
    expect(rest && "steps" in rest && rest.steps.map((s) => s.seq)).toEqual([2, 3]);
    const byTool = await listRunSteps(id, { tool: "get_claim" });
    expect(byTool && "steps" in byTool && byTool.steps.map((s) => s.seq)).toEqual([1, 2]);
    const step = await getRunStep(id, 2);
    expect(step && "content" in step && step.content).toEqual([
      { name: "get_claim", input: {}, output: "{\"status\":\"supported\"}" },
    ]);
  });

  it("withholds a private run, its steps and each step, except from a service read", async () => {
    const id = await seedRun({ reasons: ["tool:inspect_ledger"] });
    const withheld = { id, agent: "steward", withheld: true, public: false, private_reasons: ["tool:inspect_ledger"] };
    expect(await getRunSummary(id)).toEqual(withheld);
    expect(await listRunSteps(id)).toEqual(withheld);
    expect(await getRunStep(id, 0)).toEqual(withheld);
    // A service read gets the run, still marked as not public.
    const service = await getRunSummary(id, { isService: true });
    expect(service).toMatchObject({ public: false, private_reasons: ["tool:inspect_ledger"], steps_recorded: 4 });
    expect(service && "withheld" in service).toBe(false);
  });

  it("finds no run for an unknown or malformed id", async () => {
    expect(await getRunSummary(randomUUID())).toBeNull();
    expect(await getRunSummary("not-a-uuid")).toBeNull();
    expect(await getRunStep(randomUUID(), 0)).toBeNull();
  });
});
