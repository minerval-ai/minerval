import { describe, it, expect, vi, beforeEach } from "vitest";

// The delegation tools (#298) over a mocked run service and a scripted
// researcher: the brief is validated, the tier resolves to a model, the
// ceiling is capped, the per-pass count and the daily cap and the pause
// flag refuse a launch, the run row is opened and closed around the run,
// and the report comes back as the tool result.

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  openResearchRun: vi.fn(),
  closeResearchRun: vi.fn(),
  getResearchRun: vi.fn(),
  checkResearcherBudget: vi.fn(async () => undefined),
  readResearcherPaused: vi.fn(async () => false),
  config: {
    researcherEnabled: true,
    researcherStrongModel: "claude-fable-5-1",
    researcherStandardModel: "claude-sonnet-5",
    researcherCheapModel: "z-ai/glm-5.3-flash",
    researcherMaxCeilingOwls: 3,
    researcherMaxRunsPerLauncherRun: 2,
    researcherMaxWallMinutes: 20,
    researcherMaxTurns: 60,
    owlCostMicroUsd: 1_000_000,
  },
}));

vi.mock("../../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery, getDb: vi.fn() }));
vi.mock("../../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/config.js")>();
  return { ...original, loadConfig: () => ({ ...original.loadConfig(), ...mocks.config }) };
});
vi.mock("../../../../src/services/research-run-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/services/research-run-service.js")>();
  return {
    ...original,
    openResearchRun: mocks.openResearchRun,
    closeResearchRun: mocks.closeResearchRun,
    getResearchRun: mocks.getResearchRun,
    checkResearcherBudget: mocks.checkResearcherBudget,
    readResearcherPaused: mocks.readResearcherPaused,
  };
});

import { LlmBudgetExceededError } from "../../../../src/llm/errors.js";
import {
  createResearchTools,
  getResearchToolDefinitions,
} from "../../../../src/llm/tools/research-tools.js";
import type { ResearcherInput, ResearcherResult } from "../../../../src/llm/agents/researcher.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";
const BRIEF =
  "Trace the 40 percent figure in the report to its origin: which study, which table, what population, and whether the qualifications survived. Start from the report's own citation.";

const okResult = (over: Partial<ResearcherResult> = {}): ResearcherResult => ({
  status: "completed",
  report: { answer: "It traces to one study.", findings: [], sources_consulted: [], provenance_recorded: "none", caveats: "", what_would_change: "", suggested_next_steps: "" },
  turns: 7,
  stopReason: "final_tool",
  servedModels: ["claude-sonnet-5"],
  toolNames: ["search_claims", "provenance_get_map", "report"],
  error: null,
  ...over,
});

beforeEach(() => {
  for (const fn of [mocks.openResearchRun, mocks.closeResearchRun, mocks.getResearchRun]) fn.mockReset();
  mocks.checkResearcherBudget.mockReset().mockResolvedValue(undefined);
  mocks.readResearcherPaused.mockReset().mockResolvedValue(false);
  mocks.rawQuery.mockReset().mockImplementation(async (sql: string) =>
    sql.includes("FROM claims") ? [{ id: CLAIM, text: "The claim.", domains: [] }] : []
  );
  mocks.openResearchRun.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "run-1",
    claim_id: input.claimId,
    grant_id: input.grantId,
    task: input.task,
    model: input.model,
    model_tier: input.modelTier,
    effort: input.effort,
    include_constitution: input.includeConstitution,
    ceiling_micro_usd: input.ceilingMicroUsd,
    notebook: {},
  }));
  mocks.closeResearchRun.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
    id: "run-1",
    notebook: { "thread 1": "x" },
    ...input,
  }));
  mocks.config.researcherEnabled = true;
});

describe("definitions", () => {
  it("names the tiers, the ceiling, and the per-pass cap, and offers claim_id only off a claim", () => {
    const [delegate, get] = getResearchToolDefinitions({ claimScoped: true });
    expect(delegate!.name).toBe("delegate_research");
    expect(get!.name).toBe("get_research_run");
    expect(delegate!.description).toMatch(/'strong'.*'standard'.*'cheap'/s);
    expect(delegate!.description).toContain("at most 3 per run");
    expect(delegate!.description).toContain("at most 2 runs");
    const props = (delegate!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["task", "model_tier", "budget_usd", "effort", "include_constitution"]);
    const off = getResearchToolDefinitions({ claimScoped: false })[0]!;
    expect(Object.keys((off.input_schema as { properties: Record<string, unknown> }).properties)).toContain("claim_id");
  });
});

describe("delegate_research", () => {
  it("refuses a thin brief, an unknown tier, and a bad budget before touching anything", async () => {
    const runResearcher = vi.fn();
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    for (const input of [
      { task: "look into it", model_tier: "standard", budget_usd: 1 },
      { task: BRIEF, model_tier: "huge", budget_usd: 1 },
      { task: BRIEF, model_tier: "standard", budget_usd: 0 },
    ]) {
      const out = JSON.parse((await tools.execute("delegate_research", input))!);
      expect(out.success).toBe(false);
    }
    expect(runResearcher).not.toHaveBeenCalled();
    expect(mocks.openResearchRun).not.toHaveBeenCalled();
    expect(await tools.execute("something_else", {})).toBeNull();
  });

  it("resolves the tier, caps the ceiling, opens and closes the run, and returns the report", async () => {
    const runResearcher = vi.fn(async (_input: ResearcherInput) => okResult());
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const out = JSON.parse(
      (await tools.execute("delegate_research", {
        task: BRIEF,
        model_tier: "standard",
        budget_usd: 12,
        include_constitution: false,
      }))!
    );
    expect(out.success).toBe(true);
    expect(out.research_run_id).toBe("run-1");
    expect(out.status).toBe("completed");
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.report.answer).toBe("It traces to one study.");
    expect(out.tools_offered).toContain("provenance_get_map");
    expect(out.notebook_sections).toEqual(["thread 1"]);
    expect(out.note).toMatch(/data, not a verified result/);

    expect(mocks.openResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: CLAIM,
        requestedBy: "claim_steward",
        model: "claude-sonnet-5",
        modelTier: "standard",
        effort: null,
        includeConstitution: false,
        // 12 USD asked, 3 owls (3 USD) is the most a run may be given.
        ceilingMicroUsd: 3_000_000,
      })
    );
    const passed = runResearcher.mock.calls[0]![0];
    expect(passed.claim).toEqual({ id: CLAIM, text: "The claim.", domains: [] });
    expect(passed.run.include_constitution).toBe(false);
    expect(mocks.closeResearchRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "completed", turns: 7, servedModels: ["claude-sonnet-5"] })
    );
    expect(tools.launchedCount).toBe(1);
  });

  it("keeps effort on the strong tier only", async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    await tools.execute("delegate_research", { task: BRIEF, model_tier: "strong", budget_usd: 1, effort: "max" });
    expect(mocks.openResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-fable-5-1", modelTier: "strong", effort: "max" })
    );
  });

  it("refuses past the per-pass cap, when paused, over the daily cap, and when disabled", async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const call = () => tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 });
    expect(JSON.parse((await call())!).success).toBe(true);
    expect(JSON.parse((await call())!).success).toBe(true);
    const third = JSON.parse((await call())!);
    expect(third.success).toBe(false);
    expect(third.message).toMatch(/already launched 2 research run\(s\)/);

    const fresh = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    mocks.readResearcherPaused.mockResolvedValueOnce(true);
    expect(JSON.parse((await fresh.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/paused/);
    mocks.checkResearcherBudget.mockRejectedValueOnce(new LlmBudgetExceededError("researcher_daily_cap_micro_usd", 5, 4));
    expect(JSON.parse((await fresh.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/daily spend cap/);
    expect(fresh.launchedCount).toBe(0);
    // The kill switch is read when the bundle is created, once per launcher run.
    mocks.config.researcherEnabled = false;
    const disabled = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    expect(JSON.parse((await disabled.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/disabled/);
  });

  it("closes the run as failed when the researcher throws, and never throws itself", async () => {
    const runResearcher = vi.fn(async () => {
      throw new Error("provider down");
    });
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const out = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "standard", budget_usd: 1 }))!);
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.message).toMatch(/provider down/);
    expect(mocks.closeResearchRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed", error: "provider down" }));
  });

  it("lets a Grantmaker name a claim per call, and runs without one", async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "grantmaker", grantId: "grant-1", runResearcher });
    await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 });
    expect(mocks.openResearchRun).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: null, grantId: "grant-1", requestedBy: "grantmaker" }));
    expect(runResearcher.mock.calls[0]![0].claim).toBeNull();
    await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1, claim_id: CLAIM });
    expect(mocks.openResearchRun).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: CLAIM }));
    mocks.rawQuery.mockResolvedValueOnce([]);
    const missing = JSON.parse((await createResearchTools({ requestedBy: "grantmaker", runResearcher }).execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1, claim_id: "nope" }))!);
    expect(missing.message).toMatch(/No claim nope exists/);
  });
});

describe("get_research_run", () => {
  it("returns the run with its report and notebook, and refuses another claim's run", async () => {
    mocks.getResearchRun.mockResolvedValue({
      id: "run-1", claim_id: CLAIM, requested_by: "claim_steward", task: BRIEF, model: "m", model_tier: "cheap",
      status: "completed", spent_micro_usd: 123_456, turns: 3, tools: ["report"], started_at: new Date(0),
      finished_at: new Date(1), report: { answer: "a" }, notebook: { n: "x" }, error: null,
    });
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM });
    const out = JSON.parse((await tools.execute("get_research_run", { research_run_id: "run-1" }))!);
    expect(out.success).toBe(true);
    expect(out.research_run.spent_usd).toBe(0.12);
    expect(out.research_run.report).toEqual({ answer: "a" });
    expect(out.research_run.notebook).toEqual({ n: "x" });
    const other = createResearchTools({ requestedBy: "claim_steward", claimId: "bbbbbbbb-0000-4000-8000-000000000001" });
    expect(JSON.parse((await other.execute("get_research_run", { research_run_id: "run-1" }))!).message).toMatch(/another claim/);
    mocks.getResearchRun.mockResolvedValueOnce(null);
    expect(JSON.parse((await tools.execute("get_research_run", { research_run_id: "x" }))!).success).toBe(false);
  });
});
