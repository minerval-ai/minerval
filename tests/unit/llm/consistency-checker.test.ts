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
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ consistencyModel: "z-ai/glm-5.3-flash", consistencyMaxFlagsPerSweep: 2 }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  withAgent: (_a: string, fn: () => unknown) => fn(),
  getUsageContext: () => ({ runId: "run-1" }),
}));
vi.mock("../../../src/llm/prompts/consistency-checker.js", () => ({
  getConsistencyCheckerSystemPromptBlocks: () => ["SYSTEM"],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [{ name: "raise_issue" }], execute: async () => null }),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () => [{ name: "search_claims" }, { name: "get_claim" }],
  executeGraphReadTool: async (name: string) => (name === "get_claim" ? '{"claim":"x"}' : null),
}));
vi.mock("../../../src/services/consistency-service.js", () => ({
  CONSISTENCY_BOUNDS: { maxClaims: 8, noteChars: 4_000 },
  CONSISTENCY_FLAG_KINDS: ["reasoning_conflict", "overlooked_evidence", "other"],
  compareAssessments: vi.fn(async () => ({ claims: [], relations: [], unknown: [] })),
  partitionClaims: vi.fn(async (_scope: unknown, opts: Record<string, unknown>) => {
    state.listed.push(opts);
    return { total: 20, claims: [{ claim_id: PRIMARY, text: "t", summary: "s" }] };
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
});

describe("runConsistencyChecker", () => {
  it("briefs the partition with the last sweep's note and carries the checker's tools", async () => {
    await runConsistencyChecker(base);
    expect(state.loop!.briefing).toContain("covid-origins");
    expect(state.loop!.briefing).toContain("Read the market cluster; all sound.");
    expect(state.loop!.model).toBe("z-ai/glm-5.3-flash");
    const names = state.loop!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "raise_issue", "search_claims", "get_claim", "list_partition_claims",
      "compare_assessments", "flag_inconsistency", "finish_sweep",
    ]));
  });

  it("lists the partition from the last sweep's start, paginated", async () => {
    state.script = [{ name: "list_partition_claims", input: { offset: 15 } }];
    await runConsistencyChecker(base);
    expect(state.listed[0]).toMatchObject({ since: base.lastSweep.started_at, offset: 15, limit: 15 });
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ total: 20, offset: 15 });
  });

  it("passes the expected gain through and stops at the per-sweep cap", async () => {
    state.script = [flag(), flag(OTHER), flag()];
    const res = await runConsistencyChecker(base);
    expect(state.flags).toHaveLength(2);
    expect(state.flags[0]).toMatchObject({ sweepId: "sweep-1", primaryClaimId: PRIMARY, expectedGain: 0.7 });
    expect(JSON.parse(state.outputs[2]!)).toMatchObject({ ok: false, code: "SWEEP_LIMIT" });
    expect(res.flagsRaised).toBe(2);
    expect(res.proposed).toHaveLength(2);
  });

  it("writes nothing in a dry run but records every proposal", async () => {
    state.script = [flag(), flag(OTHER)];
    const res = await runConsistencyChecker({ ...base, sweepId: null, dryRun: true });
    expect(state.flags).toHaveLength(0);
    expect(res.proposed.map((p) => p.primary_claim_id)).toEqual([PRIMARY, OTHER]);
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
