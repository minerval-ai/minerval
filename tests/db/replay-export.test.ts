/**
 * The replay exporter's database half (#334), against real rows: a tiny
 * synthetic run — one source, an Extractor, a Matcher and a Steward run
 * with their steps, the claim and instance the Matcher's decision produced,
 * the Steward's subclaim, edge and assessment, the enqueue events between
 * them and their llm_usage — read back by collectArm over the run window
 * and checked for the events, deltas, causality and costs the recording
 * relies on. No LLM is called; the rows are what the agents would have
 * written.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "./urls.js";
import { collectArm } from "../../scripts/corpus/replay.js";
import type { ReplayArm } from "../../scripts/corpus/replay-types.js";

// A window in the past no other suite's rows can land in: the DB suite shares one
// scratch database and every other file stamps its rows with now().
const T0 = Date.parse("2001-01-01T00:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);

const SOURCE = randomUUID();
const CLAIM = randomUUID();
const SUB = randomUUID();
const RUN_EXTRACTOR = randomUUID();
const RUN_MATCHER = randomUUID();
const RUN_STEWARD = randomUUID();

const fingerprint = {
  pipelineEpoch: "dbtest",
  gitCommit: null,
  profile: null,
  swap: null,
  order: null,
  models: { extractor: "m-x", matcher: "m-m", steward: "m-s" },
  caps: {},
};

async function seed(): Promise<void> {
  await rawQuery(
    `INSERT INTO sources (id, url, title, raw_content, retrieved_at) VALUES ($1, $2, $3, $4, $5)`,
    [SOURCE, `https://example.org/${SOURCE}`, "A post about eggs", "eggs raise LDL cholesterol in most people", at(1)]
  );
  const runs: Array<[string, string, string | null, Date, Date | null, string | null]> = [
    [RUN_EXTRACTOR, "extractor", null, at(2), at(5), "ok"],
    [RUN_MATCHER, "matcher", null, at(6), at(9), "ok"],
    [RUN_STEWARD, "steward", CLAIM, at(12), at(40), "ok"],
  ];
  for (const [id, agent, claimId, started, finished, outcome] of runs) {
    await rawQuery(
      `INSERT INTO agent_runs (id, agent, claim_id, started_at, finished_at, outcome) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, agent, claimId, started, finished, outcome]
    );
  }
  const steps: Array<[string, number, string, unknown, Date]> = [
    [RUN_EXTRACTOR, 0, "prompt", { model: "m-x", system: "Extractor system", initialMessages: [{ role: "user", content: "doc" }], tools: [] }, at(2)],
    [RUN_EXTRACTOR, 1, "completion", { model: "m-x", output: { items: [{ text: "Eggs raise LDL cholesterol." }] } }, at(5)],
    [RUN_MATCHER, 0, "prompt", { model: "m-m", system: "Matcher system", initialMessages: [], tools: [{ name: "search_similar_claims", description: "d", input_schema: {} }] }, at(6)],
    [RUN_MATCHER, 1, "assistant", { stopReason: "tool_use", content: [{ type: "text", text: "Searching." }, { type: "tool_use", id: "t1", name: "search_similar_claims", input: { query: "eggs" } }] }, at(7)],
    [RUN_MATCHER, 2, "tool_results", [{ name: "search_similar_claims", input: { query: "eggs" }, output: JSON.stringify({ results: [] }) }], at(8)],
    [RUN_MATCHER, 3, "assistant", { stopReason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "submit_match_decision", input: { is_match: false, matched_claim_id: null, new_canonical_form: "Dietary eggs raise LDL cholesterol.", instance_stance: "affirms", confidence: 0.9, reasoning: "new" } }] }, at(9)],
    [RUN_STEWARD, 0, "prompt", { model: "m-s", system: "Steward system", initialMessages: [], tools: [] }, at(12)],
    [RUN_STEWARD, 1, "assistant", { stopReason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "add_decomposition_edge", input: { parent_id: CLAIM, child_text: "LDL cholesterol predicts heart disease.", relation: "requires", reasoning: "r" } }] }, at(25)],
    [RUN_STEWARD, 2, "tool_results", [{ name: "add_decomposition_edge", input: {}, output: JSON.stringify({ success: true, claim_id: SUB }) }], at(27)],
    [RUN_STEWARD, 3, "assistant", { stopReason: "tool_use", content: [{ type: "tool_use", id: "s2", name: "update_claim_assessment", input: { claim_id: CLAIM, status: "supported", confidence: 0.8, claim_credence: 0.75, assessment: "Modestly.", reasoning_trace: "…" } }] }, at(30)],
    [RUN_STEWARD, 4, "tool_results", [{ name: "update_claim_assessment", input: {}, output: JSON.stringify({ success: true }) }], at(32)],
  ];
  for (const [runId, seq, kind, content, created] of steps) {
    await rawQuery(
      `INSERT INTO agent_steps (run_id, seq, kind, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [runId, seq, kind, JSON.stringify(content), created]
    );
  }
  await rawQuery(
    `INSERT INTO claims (id, text, created_by, created_at, importance) VALUES ($1, $2, 'extractor', $3, 0.6), ($4, $5, 'claim_steward', $6, 0.5)`,
    [CLAIM, "Dietary eggs raise LDL cholesterol.", at(9.5), SUB, "LDL cholesterol predicts heart disease.", at(26)]
  );
  await rawQuery(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, proposed_canonical_form, stance, created_by, created_at)
     VALUES ($1, $2, 'eggs raise LDL', 'Eggs raise LDL cholesterol.', 'affirms', 'extractor', $3)`,
    [CLAIM, SOURCE, at(9.6)]
  );
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, created_by, created_at)
     VALUES ($1, $2, 'requires', 'r', 'claim_steward', $3)`,
    [CLAIM, SUB, at(26.5)]
  );
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, summary, reasoning_trace, trigger, is_current, assessed_at)
     VALUES ($1, 'supported', 0.8, 0.75, 'Modestly.', '…', 'structure_and_assess', true, $2)`,
    [CLAIM, at(31)]
  );
  const enqueues: Array<[string, string | null, string, string | null, boolean | null, Date]> = [
    ["claim_pipeline", null, CLAIM, null, null, at(10)],
    ["steward", "structure_and_assess", CLAIM, null, false, at(11)],
    ["steward", "structure_and_assess", SUB, RUN_STEWARD, false, at(27)],
  ];
  for (const [queue, trigger, claimId, sourceRun, coalesced, created] of enqueues) {
    await rawQuery(
      `INSERT INTO enqueue_events (queue, trigger, claim_id, source_run_id, coalesced, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [queue, trigger, claimId, sourceRun, coalesced, created]
    );
  }
  const usage: Array<[string, string, number, string, Date]> = [
    ["extractor", "m-x", 1500, RUN_EXTRACTOR, at(4)],
    ["matcher", "m-m", 400, RUN_MATCHER, at(8)],
    ["matcher", "m-m", 300, RUN_MATCHER, at(9)],
    ["steward", "m-s", 9000, RUN_STEWARD, at(30)],
  ];
  for (const [agent, model, cost, runId, created] of usage) {
    await rawQuery(
      `INSERT INTO llm_usage (agent, model, cost_micro_usd, run_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [agent, model, cost, runId, created]
    );
  }
}

describe("collectArm", () => {
  let arm: ReplayArm;
  beforeAll(async () => {
    await seed();
    arm = await collectArm({
      databaseUrl: TEST_DATABASE_URL,
      since: at(0),
      until: at(60),
      key: "run",
      label: "dbtest",
      variation: null,
      fingerprint,
      sourceKeys: { [`https://example.org/${SOURCE}`]: "post-1" },
    });
  });

  it("reads the window back as one event per source and per agent run, in order", () => {
    expect(arm.events.map((e) => e.agent)).toEqual(["system", "extractor", "matcher", "steward"]);
    expect(arm.events.map((e) => e.runId)).toEqual([null, RUN_EXTRACTOR, RUN_MATCHER, RUN_STEWARD]);
    expect(arm.sources).toEqual([
      expect.objectContaining({ id: SOURCE, key: "post-1", title: "A post about eggs", order: 0, words: 7 }),
    ]);
    expect(arm.database).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1));
  });

  it("credits the graph rows to the runs that wrote them, exactly", () => {
    const [, extractor, matcher, steward] = arm.events;
    expect(extractor!.title).toBe("Extractor reads «A post about eggs»");
    expect(matcher!.attribution).toBe("exact");
    expect(matcher!.deltas).toEqual([
      { op: "claim_created", claimId: CLAIM, text: "Dietary eggs raise LDL cholesterol.", createdBy: "extractor", topLevel: true, sourceId: SOURCE },
      { op: "steward_notified", claimId: CLAIM, trigger: "structure_and_assess", coalesced: false },
    ]);
    expect(steward!.attribution).toBe("exact");
    expect(steward!.deltas.map((d) => d.op)).toEqual(["claim_created", "edge_added", "assessment_recorded", "steward_notified"]);
    expect(steward!.deltas[2]).toEqual({
      op: "assessment_recorded",
      claimId: CLAIM,
      status: "supported",
      credence: 0.75,
      confidence: 0.8,
      trigger: "structure_and_assess",
      summary: "Modestly.",
    });
  });

  it("derives causality and steps from the trace tables", () => {
    const [, , matcher, steward] = arm.events;
    expect(steward!.causedBy).toBe(matcher!.seq);
    expect(steward!.trigger).toBe("structure_and_assess");
    expect(steward!.title).toBe("Steward: structure and assess «Dietary eggs raise LDL cholesterol.»");
    expect(matcher!.steps.map((s) => s.kind)).toEqual(["prompt", "thought", "tool_call", "tool_result", "decision"]);
    expect(matcher!.steps[0]!.full).toMatchObject({ system: "Matcher system" });
    expect(arm.promptsUsed!.map((p) => p.agents)).toEqual([["extractor"], ["matcher"], ["steward"]]);
  });

  it("sums llm_usage per run and over the window", () => {
    const [, extractor, matcher, steward] = arm.events;
    expect(extractor!.costMicroUsd).toBe(1500);
    expect(matcher!.costMicroUsd).toBe(700);
    expect(steward!.costMicroUsd).toBe(9000);
    expect(arm.costMicroUsd).toBe(11200);
    expect(steward!.durationMs).toBe(28_000);
  });

  it("carries the final graph", () => {
    const ids = arm.final.claims.map((c) => c.id);
    expect(ids).toContain(CLAIM);
    expect(ids).toContain(SUB);
    expect(arm.final.claims.find((c) => c.id === CLAIM)).toMatchObject({ topLevel: true, status: "supported", credence: 0.75, sourceIds: [SOURCE] });
    expect(arm.final.edges).toContainEqual(expect.objectContaining({ parentId: CLAIM, childId: SUB, relation: "requires" }));
  });
});
