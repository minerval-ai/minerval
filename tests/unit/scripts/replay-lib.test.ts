/**
 * The replay builder on fixture rows: one source through the whole
 * organization — Extractor, Matcher (new claim), Steward (assessment, one
 * subclaim through a nested Matcher), plus the enqueue events between them
 * — and the attribution, causality, cost and layout rules the recording
 * relies on.
 */
import { describe, it, expect } from "vitest";
import {
  buildReplayArm,
  buildSteps,
  gist,
  splitReplay,
  systemPromptText,
  type ReplayArmInput,
} from "../../../scripts/corpus/replay-lib.js";
import type { Replay } from "../../../scripts/corpus/replay-types.js";

const T0 = Date.parse("2026-09-18T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const SOURCE = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const RUN_EXTRACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_MATCHER = "aaaaaaaa-0000-4000-8000-000000000002";
const RUN_STEWARD = "aaaaaaaa-0000-4000-8000-000000000003";
const RUN_NESTED = "aaaaaaaa-0000-4000-8000-000000000004";
const RUN_LATE = "aaaaaaaa-0000-4000-8000-000000000005";

const SYSTEM = "You are the constitution.\n\nRole: matcher.";

const fingerprint = {
  pipelineEpoch: "2026-09-test",
  gitCommit: "abc1234",
  profile: null,
  swap: null,
  order: null,
  models: { extractor: "m-x", matcher: "m-m", steward: "m-s" },
  caps: { stewardMaxRuns: 5 },
};

function fixture(): ReplayArmInput {
  return {
    meta: { key: "run", label: "test", variation: null, fingerprint, database: "episteme_corpus", capped: false },
    since: at(0),
    sources: [{ id: SOURCE, url: "https://example.org/post", title: "A post about eggs", retrieved_at: at(1), words: 1200 }],
    runs: [
      { id: RUN_EXTRACTOR, agent: "extractor", claim_id: null, started_at: at(2), finished_at: at(5), outcome: "ok" },
      { id: RUN_MATCHER, agent: "matcher", claim_id: null, started_at: at(6), finished_at: at(9), outcome: "ok" },
      { id: RUN_STEWARD, agent: "steward", claim_id: CLAIM, started_at: at(12), finished_at: at(40), outcome: "ok" },
      { id: RUN_NESTED, agent: "matcher", claim_id: null, started_at: at(20), finished_at: at(23), outcome: "ok" },
      { id: RUN_LATE, agent: "steward", claim_id: SUB, started_at: at(50), finished_at: null, outcome: null },
    ],
    steps: [
      { run_id: RUN_EXTRACTOR, seq: 0, kind: "prompt", content: { model: "m-x", system: "Extractor system", initialMessages: [{ role: "user", content: "doc" }], tools: [], schemaName: "Claims" }, created_at: at(2) },
      { run_id: RUN_EXTRACTOR, seq: 1, kind: "completion", content: { model: "m-x", output: { items: [{ text: "Eggs raise LDL cholesterol." }] } }, created_at: at(5) },
      { run_id: RUN_MATCHER, seq: 0, kind: "prompt", content: { model: "m-m", system: SYSTEM, initialMessages: [{ role: "user", content: "match this" }], tools: [{ name: "search_similar_claims", description: "d", input_schema: {} }] }, created_at: at(6) },
      { run_id: RUN_MATCHER, seq: 1, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "text", text: "Let me search the graph first. ".repeat(20) }, { type: "tool_use", id: "t1", name: "search_similar_claims", input: { query: "eggs cholesterol" } }] }, created_at: at(7) },
      { run_id: RUN_MATCHER, seq: 2, kind: "tool_results", content: [{ name: "search_similar_claims", input: { query: "eggs cholesterol" }, output: JSON.stringify({ results: [{ id: OTHER, canonical_form: "Something else", score: 0.4 }] }) }], created_at: at(8) },
      { run_id: RUN_MATCHER, seq: 3, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "submit_match_decision", input: { is_match: false, matched_claim_id: null, new_canonical_form: "Dietary eggs raise LDL cholesterol.", instance_stance: "affirms", confidence: 0.9, reasoning: "nothing close" } }] }, created_at: at(9) },
      { run_id: RUN_STEWARD, seq: 0, kind: "prompt", content: { model: "m-s", system: "Steward system", initialMessages: [], tools: [] }, created_at: at(12) },
      { run_id: RUN_STEWARD, seq: 1, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "match_claim", input: { text: "LDL cholesterol predicts heart disease." } }] }, created_at: at(19) },
      { run_id: RUN_STEWARD, seq: 2, kind: "tool_results", content: [{ name: "match_claim", input: { text: "LDL cholesterol predicts heart disease." }, output: JSON.stringify({ outcome: "new" }) }], created_at: at(24) },
      { run_id: RUN_STEWARD, seq: 3, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "s2", name: "add_decomposition_edge", input: { parent_id: CLAIM, child_text: "LDL cholesterol predicts heart disease.", relation: "requires", reasoning: "r" } }] }, created_at: at(25) },
      { run_id: RUN_STEWARD, seq: 4, kind: "tool_results", content: [{ name: "add_decomposition_edge", input: {}, output: JSON.stringify({ success: true, claim_id: SUB }) }], created_at: at(27) },
      { run_id: RUN_STEWARD, seq: 5, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "s3", name: "set_claim_importance", input: { claim_id: CLAIM, importance: 0.7 } }, { type: "tool_use", id: "s4", name: "update_claim_assessment", input: { claim_id: CLAIM, status: "supported", confidence: 0.8, claim_credence: 0.75, assessment: "Eggs do raise LDL modestly.", reasoning_trace: "…" } }] }, created_at: at(30) },
      { run_id: RUN_STEWARD, seq: 6, kind: "tool_results", content: [{ name: "set_claim_importance", input: {}, output: "ok" }, { name: "update_claim_assessment", input: {}, output: JSON.stringify({ success: true }) }], created_at: at(32) },
      { run_id: RUN_STEWARD, seq: 7, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "s5", name: "update_canonical_form", input: { claim_id: CLAIM, new_text: "Eating eggs raises LDL cholesterol.", reasoning: "shorter" } }] }, created_at: at(34) },
      { run_id: RUN_STEWARD, seq: 8, kind: "tool_results", content: [{ name: "update_canonical_form", input: {}, output: "Error: wording locked" }], created_at: at(35) },
      { run_id: RUN_NESTED, seq: 0, kind: "prompt", content: { model: "m-m", system: SYSTEM, initialMessages: [], tools: [] }, created_at: at(20) },
      { run_id: RUN_NESTED, seq: 1, kind: "assistant", content: { stopReason: "tool_use", content: [{ type: "tool_use", id: "n1", name: "submit_match_decision", input: { is_match: false, new_canonical_form: "LDL cholesterol predicts heart disease.", instance_stance: "affirms", confidence: 0.8, reasoning: "new" } }] }, created_at: at(23) },
      { run_id: RUN_LATE, seq: 0, kind: "tool_results", content: { truncated: true, originalChars: 300000, preview: "[{\"name\":\"get_claim_details\"" }, created_at: at(51) },
    ],
    enqueueEvents: [
      { id: "e1", queue: "claim_pipeline", trigger: null, claim_id: CLAIM, source_run_id: null, coalesced: null, created_at: at(10) },
      { id: "e2", queue: "steward", trigger: "structure_and_assess", claim_id: CLAIM, source_run_id: null, coalesced: false, created_at: at(11) },
      { id: "e3", queue: "steward", trigger: "structure_and_assess", claim_id: SUB, source_run_id: RUN_STEWARD, coalesced: false, created_at: at(27) },
      { id: "e4", queue: "steward", trigger: "subclaim_changed", claim_id: SUB, source_run_id: RUN_STEWARD, coalesced: true, created_at: at(33) },
    ],
    usage: [
      { run_id: RUN_EXTRACTOR, cost_micro_usd: "1500" },
      { run_id: RUN_MATCHER, cost_micro_usd: 700 },
      { run_id: RUN_STEWARD, cost_micro_usd: 9000 },
      { run_id: null, cost_micro_usd: 100 },
    ],
    claims: [
      { id: CLAIM, text: "Dietary eggs raise LDL cholesterol.", claim_type: "empirical_derived", created_by: "extractor", created_at: at(9.5), importance: 0.7, steward_state: "done", state: "active" },
      { id: SUB, text: "LDL cholesterol predicts heart disease.", claim_type: "empirical_derived", created_by: "claim_steward", created_at: at(26), importance: 0.5, steward_state: "pending", state: "active" },
      { id: OTHER, text: "Something else", claim_type: "empirical_derived", created_by: "extractor", created_at: at(-100), importance: 0.5, steward_state: "done", state: "active" },
    ],
    instances: [
      { id: "i1", claim_id: CLAIM, source_id: SOURCE, stance: "affirms", verbatim_text: "eggs will raise your LDL", proposed_canonical_form: "Eggs raise LDL cholesterol.", created_by: "extractor", created_at: at(9.6) },
    ],
    edges: [{ id: "edge1", parent_claim_id: CLAIM, child_claim_id: SUB, relation_type: "requires", created_by: "decomposer", created_at: at(26.5), argument_id: null }],
    assessments: [
      { id: "as1", claim_id: CLAIM, status: "supported", confidence: 0.8, claim_credence: 0.75, summary: "Eggs do raise LDL modestly.", trigger: "structure_and_assess", is_current: true, assessed_at: at(31) },
      // Nobody's: a row stamped outside every run window.
      { id: "as-orphan", claim_id: OTHER, status: "contested", confidence: 0.5, claim_credence: null, trigger: null, is_current: true, assessed_at: at(200) },
    ],
    sourceKeys: { "https://example.org/post": "post-1" },
  };
}

describe("buildReplayArm", () => {
  const arm = buildReplayArm(fixture());
  const byAgent = (agent: string) => arm.events.filter((e) => e.agent === agent);
  const [source] = byAgent("system");
  const [extractor] = byAgent("extractor");
  const [matcher, nested] = byAgent("matcher");
  const [steward, late] = byAgent("steward");

  it("orders one event per source submission and per agent run, by time", () => {
    expect(arm.events.map((e) => e.agent)).toEqual(["system", "extractor", "matcher", "steward", "matcher", "steward", "system"]);
    expect(arm.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(source!.deltas).toEqual([{ op: "source_submitted", sourceId: SOURCE, title: "A post about eggs", url: "https://example.org/post" }]);
    expect(arm.sources).toEqual([{ id: SOURCE, key: "post-1", title: "A post about eggs", url: "https://example.org/post", order: 0, words: 1200 }]);
  });

  it("titles events in plain language and points them at their source and claim", () => {
    expect(extractor!.title).toBe("Extractor reads «A post about eggs»");
    expect(extractor!.sourceId).toBe(SOURCE);
    expect(matcher!.title).toBe("Matcher decides: new claim «Dietary eggs raise LDL cholesterol.»");
    expect(matcher!.claimId).toBe(CLAIM);
    expect(steward!.title).toBe("Steward: structure and assess «Dietary eggs raise LDL cholesterol.»");
    expect(steward!.trigger).toBe("structure_and_assess");
    expect(nested!.title).toBe("Matcher decides: new claim «LDL cholesterol predicts heart disease.»");
    expect(late!.outcome).toBe("running");
  });

  it("credits the Matcher's new claim exactly, with the instance it came with, and never twice", () => {
    expect(matcher!.attribution).toBe("exact");
    expect(matcher!.deltas).toContainEqual({
      op: "claim_created",
      claimId: CLAIM,
      text: "Dietary eggs raise LDL cholesterol.",
      createdBy: "extractor",
      topLevel: true,
      sourceId: SOURCE,
    });
    // The pipeline's steward enqueue names no source run: it rides with the creator.
    expect(matcher!.deltas).toContainEqual({ op: "steward_notified", claimId: CLAIM, trigger: "structure_and_assess", coalesced: false });
    const everywhere = arm.events.flatMap((e) => e.deltas);
    expect(everywhere.filter((d) => d.op === "claim_created" && d.claimId === CLAIM)).toHaveLength(1);
    expect(everywhere.filter((d) => d.op === "instance_added")).toHaveLength(0);
  });

  it("credits the Steward's subclaim, edge, assessment and importance exactly, and skips a refused tool call", () => {
    expect(steward!.attribution).toBe("exact");
    const ops = steward!.deltas.map((d) => d.op);
    expect(ops).toEqual(["claim_created", "edge_added", "importance_set", "assessment_recorded", "steward_notified", "steward_notified"]);
    expect(steward!.deltas).toContainEqual({ op: "claim_created", claimId: SUB, text: "LDL cholesterol predicts heart disease.", createdBy: "claim_steward", topLevel: false, sourceId: null });
    expect(steward!.deltas).toContainEqual({ op: "edge_added", edgeId: "edge1", parentId: CLAIM, childId: SUB, relation: "requires", argumentId: null });
    expect(steward!.deltas).toContainEqual({ op: "assessment_recorded", claimId: CLAIM, status: "supported", credence: 0.75, confidence: 0.8, trigger: "structure_and_assess", summary: "Eggs do raise LDL modestly." });
    expect(steward!.deltas).toContainEqual({ op: "steward_notified", claimId: SUB, trigger: "subclaim_changed", coalesced: true });
    expect(ops).not.toContain("canonical_form_updated");
    // The nested Matcher decided "new" but the Steward minted the subclaim.
    expect(nested!.deltas).toEqual([]);
  });

  it("derives causedBy from enqueue events, nesting, and claim creation", () => {
    expect(steward!.causedBy).toBe(matcher!.seq);
    expect(nested!.causedBy).toBe(steward!.seq);
    expect(late!.causedBy).toBe(steward!.seq);
    expect(late!.trigger).toBe("structure_and_assess");
  });

  it("sends rows no run claims to a trailing system event", () => {
    const trailing = arm.events.at(-1)!;
    expect(trailing.agent).toBe("system");
    expect(trailing.attribution).toBe("harness");
    expect(trailing.deltas).toEqual([
      { op: "assessment_recorded", claimId: OTHER, status: "contested", credence: null, confidence: 0.5, trigger: null, summary: null },
    ]);
  });

  it("sums llm_usage per run and the whole window for the arm; duration from the run's stamps", () => {
    expect(extractor!.costMicroUsd).toBe(1500);
    expect(steward!.costMicroUsd).toBe(9000);
    expect(nested!.costMicroUsd).toBeNull();
    expect(arm.costMicroUsd).toBe(11300);
    expect(steward!.durationMs).toBe(28_000);
    expect(late!.durationMs).toBeNull();
  });

  it("keeps steps verbatim, marks decisions, and flags only what the trace itself capped", () => {
    const kinds = matcher!.steps.map((s) => s.kind);
    expect(kinds).toEqual(["prompt", "thought", "tool_call", "tool_result", "decision"]);
    const thought = matcher!.steps[1]!;
    expect(thought.full).toBe("Let me search the graph first. ".repeat(20));
    expect(thought.text.length).toBeLessThan(200);
    expect(thought.text.endsWith("…")).toBe(true);
    expect(thought.truncated).toBeUndefined();
    expect(matcher!.steps[4]).toMatchObject({ kind: "decision", tool: "submit_match_decision", input: { is_match: false } });
    expect(matcher!.steps[0]!.text).toBe(`Prompt: m-m, system ${SYSTEM.length} chars, 1 tool(s)`);
    expect(late!.steps).toEqual([expect.objectContaining({ kind: "tool_result", truncated: true })]);
    expect(extractor!.steps.map((s) => s.kind)).toEqual(["prompt", "completion"]);
  });

  it("records what each event read and wrote, and each distinct system prompt once", () => {
    expect(matcher!.dataFlow).toEqual({
      reads: [{ tool: "search_similar_claims", claimIds: [OTHER], sourceIds: [] }],
      writes: [
        { op: "claim_created", claimId: CLAIM, sourceId: SOURCE },
        { op: "steward_notified", claimId: CLAIM },
      ],
    });
    const prompts = arm.promptsUsed!;
    expect(prompts).toHaveLength(3);
    const matcherPrompt = prompts.find((p) => p.agents.includes("matcher"))!;
    expect(matcherPrompt).toMatchObject({ chars: SYSTEM.length, agents: ["matcher"], count: 2, firstEventSeq: matcher!.seq, firstStepSeq: 0 });
  });

  it("reports the final graph with top-level flags and current assessments", () => {
    expect(arm.final.claims.map((c) => [c.id, c.topLevel, c.status])).toEqual([
      [CLAIM, true, "supported"],
      [SUB, false, null],
      [OTHER, false, "contested"],
    ]);
    expect(arm.final.edges).toEqual([{ id: "edge1", parentId: CLAIM, childId: SUB, relation: "requires", argumentId: null, createdAt: at(26.5) }]);
  });

  it("credits by window when a Steward's write names no decision", () => {
    const input = fixture();
    input.steps = input.steps.filter((s) => s.run_id !== RUN_STEWARD);
    const rerun = buildReplayArm(input);
    const stewardRun = rerun.events.find((e) => e.runId === RUN_STEWARD)!;
    expect(stewardRun.attribution).toBe("run-window");
    expect(stewardRun.deltas.map((d) => d.op)).toEqual(["claim_created", "edge_added", "assessment_recorded", "steward_notified", "steward_notified"]);
  });
});

describe("splitReplay", () => {
  it("moves verbatim step content to detail files and leaves sizes and a detail path in the index", () => {
    const arm = buildReplayArm(fixture());
    const replay: Replay = {
      version: 1,
      kind: "ingest",
      name: "test-replay",
      title: "t",
      cluster: "eggs",
      generatedAt: at(0),
      about: "a",
      arms: [arm],
      matching: null,
      scenario: null,
      summary: null,
      evalRunId: null,
      costMicroUsd: arm.costMicroUsd,
    };
    const { index, details } = splitReplay(replay);
    expect(details.map((d) => d.path)).toEqual(arm.events.map((e) => `run/${e.seq}.json`));
    const matcher = index.arms[0]!.events[2]!;
    expect(matcher.detailPath).toBe("run/2.json");
    const thought = matcher.steps[1]!;
    expect(thought.full).toBeUndefined();
    expect(thought.sizes).toEqual({ full: "Let me search the graph first. ".repeat(20).length });
    expect(matcher.steps[3]!.sizes!.output).toBeGreaterThan(10);
    expect(details[2]!.event.steps[1]!.full).toBeDefined();
    // Everything but the verbatim content survives in the index.
    expect(index.arms[0]!.events[2]!.deltas).toEqual(arm.events[2]!.deltas);
    expect(index.name).toBe("test-replay");
    expect(index.version).toBe(1);
  });
});

describe("helpers", () => {
  it("gist collapses whitespace and cuts with an ellipsis", () => {
    expect(gist("a  b\n c")).toBe("a b c");
    expect(gist("x".repeat(500), 10)).toBe("xxxxxxxxx…");
  });
  it("systemPromptText joins cached blocks", () => {
    expect(systemPromptText("s")).toBe("s");
    expect(systemPromptText(["a", { type: "text", text: "b" }])).toBe("a\n\nb");
    expect(systemPromptText(null)).toBeNull();
  });
  it("buildSteps treats a refused decision as not applied", () => {
    const { decisions } = buildSteps([
      { run_id: "r", seq: 0, kind: "assistant", content: { content: [{ type: "tool_use", name: "submit_match_decision", input: { is_match: true } }] } },
      { run_id: "r", seq: 1, kind: "tool_results", content: [{ name: "submit_match_decision", input: {}, output: JSON.stringify({ success: false, message: "Decision NOT recorded" }) }] },
      { run_id: "r", seq: 2, kind: "assistant", content: { content: [{ type: "tool_use", name: "submit_match_decision", input: { is_match: false } }] } },
    ]);
    expect(decisions.map((d) => d.applied)).toEqual([false, true]);
  });
});
