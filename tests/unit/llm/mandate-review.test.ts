import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The mandate review pass (llm/agents/mandate-review.ts): what it is
 * offered and what it is told. The pass is where a mandate is stewarded,
 * so it carries the research and request tools its prompt describes and
 * the read tools that show what its money bought (#683); a judgment
 * mandate values the ledger and may set its maintenance ceiling, a formula
 * mandate amends its formula (#687); extend_plan takes the shared item
 * schema, focus included (#684); valued rows the closing allocation could
 * not fund are recorded for the next briefing (#688); a note to the funder
 * is kept on the mandate (#701). The loop and the services are mocked.
 */

const GRANT = "11111111-1111-4111-8111-111111111111";

const { state } = vi.hoisted(() => ({
  state: {
    grant: null as null | Record<string, unknown>,
    loop: null as null | {
      tools: Array<{ name: string; input_schema?: Record<string, unknown> }>;
      briefing: string;
      maxTokens?: number;
    },
    script: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    updates: [] as Array<{ sql: string; params: unknown[] }>,
    allocator: { allocated: 0, allocatedMicroUsd: 0, thresholdRatio: null } as Record<string, unknown>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM grants g JOIN budget_jobs j") && sql.includes("g.workspace")) {
      return state.grant ? [state.grant] : [];
    }
    if (sql.includes("SELECT policy FROM grants")) return [{ policy: state.grant?.policy }];
    if (sql.startsWith("UPDATE grants") || sql.trimStart().startsWith("UPDATE grants")) {
      state.updates.push({ sql, params });
      return [{ before: 0 }];
    }
    return [];
  }),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ grantmakerModel: "m", owlCostMicroUsd: 1_000_000 }),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  runBudget: () => null,
  budgetRefusal: () => null,
  withAgent: (_a: string, fn: () => unknown) => fn(),
  withSkills: (_s: string[], fn: () => unknown) => fn(),
  getUsageContext: () => ({}),
}));
vi.mock("../../../src/llm/prompts/grantmaker.js", () => ({
  getGrantmakerSystemPromptBlocks: () => ["ROLE"],
}));
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({ definitions: [], execute: async () => null, pointed: [], pointerNote: "" }),
}));
vi.mock("../../../src/llm/tools/research-tools.js", () => ({
  createResearchTools: () => ({
    definitions: [{ name: "delegate_research" }, { name: "get_research_run" }, { name: "fund_request" }],
    execute: async () => null,
  }),
}));
vi.mock("../../../src/llm/tools/kind-tools.js", () => ({
  getRequestToolDefinitions: () => [{ name: "list_requests" }],
  executeKindTool: async () => "{}",
}));
vi.mock("../../../src/services/regrant-service.js", () => ({
  grantCommittedMicroUsd: async () => 0,
  createRegrant: vi.fn(),
  spawnFundedMandate: vi.fn(),
}));
vi.mock("../../../src/services/mandate-event-service.js", () => ({
  WAKE_AFTER_MINUTES: 30,
  consumeMandateEvents: async () => {},
  describeMandateEvent: () => "",
  pendingMandateEvents: async () => ({ events: [], total: 0 }),
}));
vi.mock("../../../src/services/lookout-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/lookout-service.js")>()),
  listMandateLookoutFlags: async () => [],
  summarizeLookouts: async () => [],
}));
vi.mock("../../../src/services/allocation-service.js", () => ({
  runMandateAllocator: vi.fn(async () => state.allocator),
}));
vi.mock("../../../src/services/allocation-policy-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/allocation-policy-service.js")>()),
  getMandateAllocationPolicy: async () => ({ maintenance_share: 0.1 }),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  materializePlanItems: async () => [],
  grantmakerShareLeftMicroUsd: async () => null,
}));
vi.mock("../../../src/services/mandate-valuer-service.js", () => ({
  setMandateValuations: async () => ({ written: 1, unknownActionIds: [], recusedActionIds: [] }),
  listOpenActions: async () => ({ rows: [] }),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: {
    tools: Array<{ name: string; input_schema?: Record<string, unknown> }>;
    initialMessages: Array<{ content: string }>;
    maxTokens?: number;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    state.loop = { tools: opts.tools, briefing: opts.initialMessages[0]!.content, maxTokens: opts.maxTokens };
    for (const step of state.script) state.outputs.push(await opts.executeTool(step.name, step.input));
    return { content: "done", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runMandateReview } from "../../../src/llm/agents/mandate-review.js";

const grant = (over: Record<string, unknown> = {}) => ({
  id: GRANT,
  name: "Grid reliability",
  policy: "agent",
  mandate: { title: "Grid reliability", objective: "o" },
  plan: { items: [] },
  plan_cursor: 0,
  daily_budget_micro_usd: 5_000_000,
  budget_job_id: "job-1",
  budget_micro_usd: 100_000_000,
  workspace: null,
  funder_user_id: "u-1",
  skills: [],
  ...over,
});

beforeEach(() => {
  state.grant = grant();
  state.loop = null;
  state.script = [];
  state.outputs = [];
  state.updates = [];
  state.allocator = { allocated: 0, allocatedMicroUsd: 0, thresholdRatio: null };
});

const names = () => state.loop!.tools.map((t) => t.name);

describe("runMandateReview", () => {
  it("offers a judgment mandate the research, request and read tools, its valuations, and its policy lever", async () => {
    await runMandateReview({ grantId: GRANT });
    for (const n of [
      "delegate_research", "get_research_run", "fund_request", "list_requests",
      "list_funded_assessments", "claims_from_source", "allocation_report",
      "list_open_actions", "set_valuations", "update_allocation_policy", "note_to_funder",
    ]) {
      expect(names()).toContain(n);
    }
    const policy = state.loop!.tools.find((t) => t.name === "update_allocation_policy") as unknown as { description: string };
    expect(policy.description).toContain("maintenance_share (0 to 1, now 0.1)");
    // The whole-workspace rewrite fits in a turn (#690).
    expect(state.loop!.maxTokens).toBe(16384);
  });

  it("gives the Governance mandate its formula lever and not set_valuations", async () => {
    state.grant = grant({ policy: "governance" });
    await runMandateReview({ grantId: GRANT });
    expect(names()).toContain("update_allocation_policy");
    expect(names()).not.toContain("set_valuations");
    const policy = state.loop!.tools.find((t) => t.name === "update_allocation_policy") as unknown as { description: string };
    expect(policy.description).toContain("audit_value_overturn");
  });

  it("states the maintenance share and that the allocator never part-funds an action", async () => {
    await runMandateReview({ grantId: GRANT });
    expect(state.loop!.briefing).toContain("maintenance_share 0.1");
    expect(state.loop!.briefing).toContain("never part-funds");
  });

  it("extend_plan takes the shared item schema and keeps an ingest's focus", async () => {
    state.script = [{
      name: "extend_plan",
      input: {
        items: [{ action: "ingest", url: "https://x.test/r", rationale: "r", focus: " grid prices " }],
        note: "found a report",
      },
    }];
    await runMandateReview({ grantId: GRANT });
    const ext = state.loop!.tools.find((t) => t.name === "extend_plan")!;
    const items = (ext.input_schema!.properties as Record<string, { items: { properties: Record<string, unknown> } }>).items;
    expect(items.items.properties).toHaveProperty("focus");
    const append = state.updates.find((u) => u.sql.includes("plan->'items'"))!;
    expect(JSON.parse(append.params[1] as string)).toEqual([
      { action: "ingest", url: "https://x.test/r", rationale: "r", focus: "grid prices" },
    ]);
  });

  it("records valued rows the closing allocation skipped for room, and briefs the next pass on them", async () => {
    state.script = [{ name: "set_valuations", input: { entries: [] } }];
    state.allocator = {
      allocated: 0,
      allocatedMicroUsd: 0,
      thresholdRatio: null,
      skippedForRoom: [{ group: "attempt:x", actionId: "a-1", claimId: null, neededMicroUsd: 60_000_000, reason: "daily_rate" }],
    };
    state.grant = grant({
      mandate: {
        title: "t",
        objective: "o",
        last_allocation: { skipped: [{ group: "g", action_id: "a-1", needed_owls: 60, reason: "daily_rate" }] },
      },
    });
    await runMandateReview({ grantId: GRANT });
    expect(state.loop!.briefing).toContain("a-1 needs 60 owls (more than the whole daily rate");
    const rec = state.updates.find((u) => u.sql.includes("last_allocation"))!;
    expect(JSON.parse(rec.params[1] as string)).toEqual([
      { group: "attempt:x", action_id: "a-1", needed_owls: 60, reason: "daily_rate" },
    ]);
  });

  it("keeps a note for the funder on the mandate", async () => {
    state.script = [{ name: "note_to_funder", input: { note: "A 40-owl regrant needs you." } }];
    await runMandateReview({ grantId: GRANT });
    expect(JSON.parse(state.outputs[0]!)).toMatchObject({ success: true });
    const u = state.updates.find((x) => x.sql.includes("funder_notes"))!;
    expect(u.params).toEqual([GRANT, "A 40-owl regrant needs you.", 20]);
  });
});
