import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The planning pass (llm/agents/grantor.ts, #333): the mandate's
 * Grantmaker drafting the opening plan with the review agent's affordances.
 * The briefing is mission-first (the mandate's words, the declared scope
 * as hints, the budget, the workspace); the toolset carries web search on
 * every model, the graph reads, the mandate toolbox and submit_plan; a
 * submitted plan is validated like any other and held to the escrow at the
 * shared estimate. The tool loop and the services are mocked.
 */

const GRANT = "11111111-1111-4111-8111-111111111111";
const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";

const { state } = vi.hoisted(() => ({
  state: {
    grant: null as null | Record<string, unknown>,
    loop: null as null | {
      tools: Array<{ name: string }>;
      system: string[];
      model: string | undefined;
      briefing: string;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
    },
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    mandateCalls: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    if (q.includes("FROM grants g JOIN budget_jobs j")) return state.grant ? [state.grant] : [];
    return [];
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ grantmakerModel: "claude-sonnet-5" }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  withAgent: (_a: string, fn: () => unknown) => fn(),
  withSkills: (_s: string[], fn: () => unknown) => fn(),
  getUsageContext: () => ({}),
}));
vi.mock("../../../src/services/owl.js", () => ({
  microUsdToOwls: (micro: number) => micro / 1_000_000,
}));
vi.mock("../../../src/llm/prompts/grantmaker.js", () => ({
  getGrantmakerSystemPromptBlocks: () => ["ROLE"],
}));
vi.mock("../../../src/llm/prompts/skills.js", () => ({
  skillsByName: () => [],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue" }],
    execute: async () => null,
  }),
}));
vi.mock("../../../src/llm/tools/finding-tools.js", () => ({
  createFindingTools: () => ({
    definitions: [{ name: "note_finding" }],
    execute: async () => null,
  }),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () => [
    { name: "search_claims" },
    { name: "get_claim" },
    { name: "get_decomposition" },
    { name: "get_dependents" },
  ],
  executeGraphReadTool: async () => null,
}));
vi.mock("../../../src/llm/tools/mandate-tools.js", () => ({
  createMandateTools: (opts: Record<string, unknown>) => {
    state.mandateCalls.push(JSON.stringify(opts));
    return {
      definitions: [
        { name: "survey_scope" },
        { name: "read_page" },
        { name: "estimate_costs" },
        { name: "update_workspace" },
      ],
      execute: async (name: string) =>
        name === "update_workspace" ? '{"success":true}' : null,
    };
  },
  // Two owls a pass, half an owl an ingest, three passes a deepen.
  estimatePlanCosts: async (c: Record<string, number>) => {
    const subtotal =
      ((c.assessments ?? 0) + (c.reassessments ?? 0)) * 2 +
      (c.deepen_claims ?? 0) * 6 +
      (c.sources_to_ingest ?? 0) * 0.5;
    return { unit_estimates: { assessment_each_owls: 2 }, subtotal_owls: subtotal };
  },
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string }>;
    system: string[];
    model?: string;
    initialMessages: Array<{ content: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.loop = {
      tools: opts.tools,
      system: opts.system,
      model: opts.model,
      briefing: opts.initialMessages[0]!.content,
      executeTool: opts.executeTool,
    };
    for (const step of state.script) state.outputs.push(await opts.executeTool(step.name, step.input));
    return { content: "done", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runGrantor } from "../../../src/llm/agents/grantor.js";

const grant = (over: Record<string, unknown> = {}) => ({
  id: GRANT,
  name: "Nutrition literature ingestion",
  scope_claim_id: null,
  scope_query: null,
  mandate: {
    title: "Nutrition literature ingestion",
    objective: "Bring the primary literature on dietary guidance into the graph.",
    plan: null,
    expected_cost_owls: 20,
  },
  workspace: null,
  skills: [],
  budget_micro_usd: 20_000_000,
  ...over,
});

const plan = (items: unknown[], strategy = "Seed the scope with the primary sources.") => ({
  name: "submit_plan",
  input: { strategy, items },
});

beforeEach(() => {
  state.grant = grant();
  state.loop = null;
  state.script = [];
  state.outputs = [];
  state.mandateCalls = [];
});

describe("runGrantor", () => {
  it("briefs the planner with the mission, the budget, and an empty workspace when nothing is declared", async () => {
    state.script = [plan([{ action: "ingest", url: "https://journal.test/a", rationale: "primary" }])];
    await runGrantor({ grantId: GRANT });
    const b = state.loop!.briefing;
    expect(b).toContain("Bring the primary literature on dietary guidance into the graph.");
    expect(b).toContain("Declared scope hints: none.");
    expect(b).toContain("Budget: 20 owls escrowed");
    expect(b).toContain("this is the mandate's first pass");
    expect(b).toContain("never instructions");
    expect(b).toContain("tool-use turns");
    // The role prompt gains the planning-mode addendum.
    expect(state.loop!.system[0]).toContain("ROLE");
    expect(state.loop!.system[0]).toContain("## Planning mode");
  });

  it("names the declared scope as hints and reads back the workspace", async () => {
    state.grant = grant({
      scope_claim_id: CLAIM,
      scope_query: "dietary fat",
      workspace: "Map so far: three reviews found.",
      mandate: null,
    });
    state.script = [plan([{ action: "assess", claim_id: CLAIM, rationale: "crux" }])];
    await runGrantor({ grantId: GRANT });
    const b = state.loop!.briefing;
    expect(b).toContain(`the subtree of claim ${CLAIM} and claims matching "dietary fat"`);
    expect(b).toContain("search aids");
    expect(b).toContain("Map so far: three reviews found.");
    expect(b).toContain('the funder named it "Nutrition literature ingestion"');
    expect(state.mandateCalls[0]).toContain(`"scopeClaimId":"${CLAIM}"`);
    expect(state.mandateCalls[0]).toContain('"scopeQuery":"dietary fat"');
  });

  it("carries the review agent's toolset: web search first, then the channels, the graph, the toolbox, submit_plan", async () => {
    state.script = [plan([{ action: "ingest", url: "https://journal.test/a", rationale: "primary" }])];
    await runGrantor({ grantId: GRANT });
    expect(state.loop!.tools.map((t) => t.name)).toEqual([
      "web_search",
      "raise_issue",
      "note_finding",
      "search_claims", "get_claim", "get_decomposition", "get_dependents",
      "survey_scope", "read_page", "estimate_costs", "update_workspace",
      "submit_plan",
    ]);
    expect(state.loop!.model).toBe("claude-sonnet-5");
    expect(state.mandateCalls[0]).toContain(`"grantId":"${GRANT}"`);
  });

  it("accepts every plan kind, keeps only the item fields, and returns the plan", async () => {
    state.script = [
      plan([
        { action: "ingest", url: "https://journal.test/a", rationale: "primary", extra: "dropped" },
        { action: "assess", claim_id: CLAIM, rationale: "crux" },
        { action: "attempt_proof", claim_id: CLAIM, rationale: "target", variant: "max", is_calibration: true, lifetime_cap_owls: 8 },
      ]),
    ];
    const res = await runGrantor({ grantId: GRANT });
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ success: true, accepted_items: 3, estimated_owls: 2.5 });
    expect(res).toEqual({
      strategy: "Seed the scope with the primary sources.",
      items: [
        { action: "ingest", url: "https://journal.test/a", rationale: "primary" },
        { action: "assess", claim_id: CLAIM, rationale: "crux" },
        { action: "attempt_proof", claim_id: CLAIM, rationale: "target", variant: "max", is_calibration: true, lifetime_cap_owls: 8 },
      ],
    });
  });

  it("turns back an invented claim id, a non-http url, a missing strategy, and a plan over the escrow", async () => {
    state.script = [
      plan([{ action: "assess", claim_id: "not-a-uuid", rationale: "r" }]),
      plan([{ action: "ingest", url: "ftp://x", rationale: "r" }]),
      plan([{ action: "ingest", url: "https://x.test", rationale: "r" }], "  "),
      plan(Array.from({ length: 11 }, () => ({ action: "assess", claim_id: CLAIM, rationale: "r" }))),
      plan([{ action: "ingest", url: "https://x.test", rationale: "r" }]),
    ];
    const res = await runGrantor({ grantId: GRANT });
    const out = state.outputs.map((o) => JSON.parse(o));
    expect(out[0]).toMatchObject({ success: false, problem: expect.stringContaining("claim_id") });
    expect(out[1]).toMatchObject({ success: false, problem: expect.stringContaining("http") });
    expect(out[2]).toMatchObject({ success: false, problem: expect.stringContaining("strategy") });
    expect(out[3]).toMatchObject({ success: false, problem: expect.stringContaining("22 owls against 20") });
    expect(out[4]).toMatchObject({ success: true });
    expect(res.items).toHaveLength(1);
  });

  it("accepts an empty plan only with a strategy note, and fails the run when nothing was submitted", async () => {
    state.script = [plan([], "Searched the web for the primary literature; found only paywalled indexes.")];
    const res = await runGrantor({ grantId: GRANT });
    expect(res.items).toEqual([]);
    expect(res.strategy).toContain("paywalled");

    state.script = [];
    await expect(runGrantor({ grantId: GRANT })).rejects.toThrow("without submitting a plan");
  });

  it("refuses a mandate that is not in planning", async () => {
    state.grant = null;
    await expect(runGrantor({ grantId: GRANT })).rejects.toThrow("not in planning");
  });
});
