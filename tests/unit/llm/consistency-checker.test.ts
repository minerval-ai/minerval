import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Consistency Checker run (llm/agents/consistency-checker.ts): the
 * briefing carries the partition and the last sweep's note; the toolset is
 * the graph reads plus the partition listing, the comparison, the flag and
 * the closing note; flag_inconsistency stops at the per-sweep cap and
 * passes the expected gain through; a dry run records proposals and writes
 * nothing; finish_sweep closes the sweep and ends the loop on the next
 * tool call. The tool loop and the services are mocked.
 */

const PRIMARY = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const { state } = vi.hoisted(() => ({
  state: {
    loop: null as null | {
      tools: Array<{ name: string }>;
      briefing: string;
      model: string | undefined;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
      onFinalTool?: (name: string, input: Record<string, unknown>) => unknown;
    },
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    finalAfter: [] as boolean[],
    flags: [] as Array<Record<string, unknown>>,
    listed: [] as Array<Record<string, unknown>>,
    curation: [] as Array<Record<string, unknown>>,
    openFlags: [] as Array<Record<string, unknown>>,
    listing: null as null | Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ consistencyModel: "openai/gpt-6-luna" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  budgetRefusal: () => null,
  withAgent: (_a: string, fn: () => unknown) => fn(),
  getUsageContext: () => ({ runId: "run-1" }),
  runBudget: () => null,
}));
vi.mock("../../../src/llm/prompts/consistency-checker.js", () => ({
  getConsistencyCheckerSystemPromptBlocks: () => ["SYSTEM"],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [{ name: "raise_issue" }], execute: async () => null }),
}));
vi.mock("../../../src/llm/tools/finding-tools.js", () => ({
  createFindingTools: () => ({ definitions: [{ name: "note_finding" }], execute: async () => null }),
}));
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({
    definitions: [{ name: "load_skill" }],
    execute: async () => null,
    pointed: [],
    pointerNote: "",
  }),
}));
vi.mock("../../../src/services/curation-service.js", () => ({
  CURATION_CONCERN_MAX_CHARS: 4_000,
  requestCuration: vi.fn(async (input: Record<string, unknown>) => {
    state.curation.push(input);
    return { ok: true, requestId: "r", actionId: "a", repeat: false };
  }),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () => [{ name: "search_claims" }, { name: "get_claim" }],
  executeGraphReadTool: async (name: string) => (name === "get_claim" ? '{"claim":"x"}' : null),
}));
vi.mock("../../../src/services/consistency-service.js", () => ({
  CONSISTENCY_BOUNDS: {
    maxClaims: 8,
    noteChars: 4_000,
    rationaleChars: 2_000,
    listingTextChars: 300,
    listingSummaryChars: 500,
  },
  CONSISTENCY_FLAG_KINDS: ["unweighed_consideration", "reasoning_conflict", "overlooked_evidence", "other"],
  TRACE_EXCERPT_CHARS: 5_000,
  OPEN_FLAG_RATIONALE_CHARS: 200,
  openFlagsInScope: vi.fn(async () => state.openFlags),
  compareAssessments: vi.fn(async () => ({ claims: [], relations: [], unknown: [] })),
  checkFlagInput: vi.fn(async (input: { primaryClaimId: string; claimIds: string[] }) =>
    input.primaryClaimId.length === 36
      ? { ok: true, claimIds: input.claimIds }
      : { ok: false, code: "CLAIM", problem: "bad id" }),
  partitionClaims: vi.fn(async (_scope: unknown, opts: Record<string, unknown>) => {
    state.listed.push(opts);
    return { total: 20, claims: state.listing ?? [{ claim_id: PRIMARY, text: "t", summary: "s" }] };
  }),
  flagInconsistency: vi.fn(async (input: Record<string, unknown>) => {
    state.flags.push(input);
    return { ok: true, duplicate: false, flag_id: "f", action_id: "a", expected_gain: input.expectedGain, note: "" };
  }),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string }>;
    model?: string;
    initialMessages: Array<{ content: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
    onFinalTool?: (name: string, input: Record<string, unknown>) => unknown;
  }) => {
    state.loop = {
      tools: opts.tools,
      briefing: opts.initialMessages[0]!.content,
      model: opts.model,
      executeTool: opts.executeTool,
      onFinalTool: opts.onFinalTool,
    };
    for (const step of state.script) {
      // The loop checks the final tool before executing a turn's tools.
      const fin = opts.onFinalTool?.(step.name, step.input);
      state.finalAfter.push(fin !== null && fin !== undefined);
      if (fin !== null && fin !== undefined) break;
      state.outputs.push(await opts.executeTool(step.name, step.input));
    }
    return { content: "closing text" };
  }),
}));

import { runConsistencyChecker } from "../../../src/llm/agents/consistency-checker.js";

const base = {
  sweepId: "sweep-1",
  partitionLabel: "covid-origins",
  scope: { tagId: "tag-1" },
  claimsInScope: 20,
  lastSweep: { started_at: new Date("2026-09-20T00:00:00Z"), note: "Read the market cluster; all sound." },
};

const flag = (primary = PRIMARY) => ({
  name: "flag_inconsistency",
  input: {
    kind: "overlooked_evidence",
    primary_claim_id: primary,
    claim_ids: [primary, OTHER],
    rationale: "The primary never weighs the neighbor's evidence.",
    expected_gain: 0.7,
  },
});

beforeEach(() => {
  state.loop = null;
  state.script = [];
  state.outputs = [];
  state.finalAfter = [];
  state.flags = [];
  state.listed = [];
  state.curation = [];
  state.openFlags = [];
  state.listing = null;
});

describe("runConsistencyChecker", () => {
  it("briefs the partition with the last sweep's note and carries the checker's tools", async () => {
    await runConsistencyChecker(base);
    expect(state.loop!.briefing).toContain("covid-origins");
    expect(state.loop!.briefing).toContain("Read the market cluster; all sound.");
    expect(state.loop!.model).toBe("openai/gpt-6-luna");
    const names = state.loop!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "raise_issue", "note_finding", "load_skill", "search_claims", "get_claim",
      "list_partition_claims", "compare_assessments", "flag_inconsistency",
      "escalate_to_curator", "finish_sweep",
    ]));
    expect(state.loop!.briefing).toContain("No flag in this partition is still waiting");
  });

  it("briefs the flags still waiting in the partition (#745)", async () => {
    state.openFlags = [{
      flag_id: "f1", primary_claim_id: PRIMARY, kind: "stale_premise",
      rationale: "x".repeat(200), repeats: 1, created_at: "2026-10-01T00:00:00.000Z",
    }];
    await runConsistencyChecker(base);
    expect(state.loop!.briefing).toContain(`${PRIMARY} (stale_premise, flagged 2026-10-01, 1 repeat(s))`);
  });

  it("states its limits and marks a listing field it cut (#753)", async () => {
    state.listing = [{ claim_id: PRIMARY, text: "t".repeat(400), summary: "s".repeat(600) }];
    state.script = [{ name: "list_partition_claims", input: {} }];
    await runConsistencyChecker(base);
    const listed = JSON.parse(state.outputs[0]!).claims[0];
    expect(listed.text).toHaveLength(300);
    expect(listed.text_truncated).toBe(true);
    expect(listed.summary_truncated).toBe(true);
    const tools = state.loop!.tools as Array<{ name: string; description: string; input_schema: { properties: Record<string, { description?: string }> } }>;
    const describe = (n: string) => JSON.stringify(tools.find((t) => t.name === n));
    expect(describe("list_partition_claims")).toContain("first 300 characters");
    expect(describe("compare_assessments")).toContain("5000");
    expect(describe("flag_inconsistency")).toContain("At most 2000 characters");
    expect(describe("finish_sweep")).toContain("At most 4000 characters");
    // The precision line is gone from what the agent reads (#745).
    expect(describe("flag_inconsistency")).not.toContain("precision");
  });

  it("refuses an over-long note and keeps the sweep open, never cutting it (#753)", async () => {
    state.script = [
      { name: "finish_sweep", input: { note: "n".repeat(4_001) } },
      { name: "finish_sweep", input: { note: "Short note." } },
    ];
    const res = await runConsistencyChecker(base);
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ ok: false });
    expect(res.note).toBe("Short note.");
  });

  it("sends a structural defect to the Curator as a consistency_sweep request (#742)", async () => {
    state.script = [{
      name: "escalate_to_curator",
      input: { claim_id: PRIMARY, other_claim_id: OTHER, concern: "These two nodes are one claim." },
    }];
    const res = await runConsistencyChecker(base);
    expect(state.curation[0]).toMatchObject({
      anchorClaimId: PRIMARY, otherClaimId: OTHER, source: "consistency_sweep", requestedByRunId: "run-1",
    });
    expect(res.escalations).toBe(1);
  });

  it("sends nothing to the Curator in a dry run", async () => {
    state.script = [{ name: "escalate_to_curator", input: { claim_id: PRIMARY, concern: "Duplicate." } }];
    const res = await runConsistencyChecker({ ...base, sweepId: null, dryRun: true });
    expect(state.curation).toHaveLength(0);
    expect(res.escalations).toBe(1);
  });

  it("lists the partition from the last sweep's start, paginated", async () => {
    state.script = [{ name: "list_partition_claims", input: { offset: 15 } }];
    await runConsistencyChecker(base);
    expect(state.listed[0]).toMatchObject({ since: base.lastSweep.started_at, offset: 15, limit: 15 });
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ total: 20, offset: 15 });
  });

  it("passes the expected gain through, with no count on the flags a sweep may raise", async () => {
    state.script = [flag(), flag(OTHER), flag("dd99c243-0000-4000-8000-000000000003")];
    const res = await runConsistencyChecker(base);
    expect(state.flags).toHaveLength(3);
    expect(state.flags[0]).toMatchObject({ sweepId: "sweep-1", primaryClaimId: PRIMARY, expectedGain: 0.7 });
    expect(res.flagsRaised).toBe(3);
    expect(res.proposed).toHaveLength(3);
  });

  it("writes nothing in a dry run, and counts only valid, distinct proposals", async () => {
    state.script = [flag(), flag(OTHER), flag(), flag("dd99c243")];
    const res = await runConsistencyChecker({ ...base, sweepId: null, dryRun: true });
    expect(state.flags).toHaveLength(0);
    expect(res.proposed.map((p) => p.primary_claim_id)).toEqual([PRIMARY, OTHER]);
    expect(res.repeats).toBe(1);
    expect(JSON.parse(state.outputs[3]!)).toMatchObject({ ok: false, code: "CLAIM" });
  });

  it("closes on finish_sweep, keeps its note, and ends the loop at the next tool call", async () => {
    state.script = [
      flag(),
      { name: "finish_sweep", input: { note: "Flagged one overlooked study." } },
      { name: "get_claim", input: { claim_id: PRIMARY } },
    ];
    const res = await runConsistencyChecker(base);
    expect(res.note).toBe("Flagged one overlooked study.");
    expect(res.runId).toBe("run-1");
    // The flag executed before the close; the call after it ended the loop.
    expect(state.flags).toHaveLength(1);
    expect(state.finalAfter).toEqual([false, false, true]);
  });
});
