import { describe, it, expect, vi, beforeEach } from "vitest";

// The delegation tools (#298) over a mocked run service and a scripted
// researcher: the brief is validated, the tier resolves to a model, the
// ceiling is paid from the launcher's own budget (a Steward's pass, a
// Grantmaker's mandate) with no count of runs, the daily cap on unfunded
// research and the pause flag refuse a launch, the run row is opened and
// closed around the run, and the report comes back as the tool result.

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  openResearchRun: vi.fn(),
  closeResearchRun: vi.fn(),
  getResearchRun: vi.fn(),
  checkResearcherBudget: vi.fn(async () => undefined),
  readResearcherPaused: vi.fn(async () => false),
  openExamination: vi.fn(),
  linkResearchRun: vi.fn(async () => undefined),
  grantBudget: 100_000_000,
  grantCommitted: 0,
  config: {
    researcherEnabled: true,
    researcherStrongModel: "claude-opus-5-5",
    researcherStandardModel: "claude-sonnet-5-5",
    researcherCheapModel: "openai/gpt-6-luna",
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

vi.mock("../../../../src/services/regrant-service.js", () => ({
  grantCommittedMicroUsd: vi.fn(async () => mocks.grantCommitted),
}));

vi.mock("../../../../src/services/examination-service.js", () => {
  class ExaminationError extends Error {}
  return { ExaminationError, openExamination: mocks.openExamination, linkResearchRun: mocks.linkResearchRun };
});

import { LlmBudgetExceededError } from "../../../../src/llm/errors.js";
import { ExaminationError } from "../../../../src/services/examination-service.js";
import {
  createResearchTools,
  getResearchToolDefinitions,
} from "../../../../src/llm/tools/research-tools.js";
import type { ResearcherInput, ResearcherResult } from "../../../../src/llm/agents/researcher.js";
import { getUsageContext, runWithUsageContext, withPassBudget } from "../../../../src/llm/usage-context.js";

/** Run `fn` as a Steward pass the test lane funds with `microUsd`. */
const funded = async <T>(fn: () => Promise<T>, microUsd = 5_000_000): Promise<T> =>
  (await withPassBudget({ microUsd, source: "the test lane" }, fn)).value;

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN = "cccccccc-0000-4000-8000-000000000001";
const BRIEF =
  "Trace the 40 percent figure in the report to its origin: which study, which table, what population, and whether the qualifications survived. Start from the report's own citation.";

const okResult = (over: Partial<ResearcherResult> = {}): ResearcherResult => ({
  status: "completed",
  report: { answer: "It traces to one study.", findings: [], sources_consulted: [], provenance_recorded: "none", caveats: "", what_would_change: "", suggested_next_steps: "" },
  turns: 7,
  stopReason: "final_tool",
  servedModels: ["claude-sonnet-5-5"],
  toolNames: ["search_claims", "provenance_get_map", "report"],
  error: null,
  ...over,
});

beforeEach(() => {
  for (const fn of [mocks.openResearchRun, mocks.closeResearchRun, mocks.getResearchRun]) fn.mockReset();
  mocks.checkResearcherBudget.mockReset().mockResolvedValue(undefined);
  mocks.readResearcherPaused.mockReset().mockResolvedValue(false);
  mocks.rawQuery.mockReset().mockImplementation(async (sql: string) =>
    sql.includes("FROM claims")
      ? [{ id: CLAIM, text: "The claim.", domains: [] }]
      : sql.includes("FROM grants g JOIN budget_jobs")
        ? [{ id: "grant-1", budget_job_id: "job-1", budget: mocks.grantBudget }]
        : []
  );
  mocks.grantBudget = 100_000_000;
  mocks.grantCommitted = 0;
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
  mocks.openExamination.mockReset();
  mocks.linkResearchRun.mockClear();
});

describe("definitions", () => {
  it("names the tiers, where the budget comes from, and the wall cap, and offers claim_id only off a claim", () => {
    const [delegate, get] = getResearchToolDefinitions({ claimScoped: true });
    expect(delegate!.name).toBe("delegate_research");
    expect(get!.name).toBe("get_research_run");
    expect(delegate!.description).toMatch(/'strong'.*'standard'.*'cheap'/s);
    expect(delegate!.description).toContain("paid from this pass's own budget");
    expect(delegate!.description).not.toMatch(/at most \d+ per run/);
    expect(delegate!.description).not.toMatch(/at most \d+ runs/);
    expect(delegate!.description).toContain("wall-clock cap of 20 minutes");
    const props = (delegate!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual([
      "task", "model_tier", "budget_usd", "effort", "include_constitution", "examine_source_id", "facets",
    ]);
    const off = getResearchToolDefinitions({ claimScoped: false })[0]!;
    expect(Object.keys((off.input_schema as { properties: Record<string, unknown> }).properties)).toContain("claim_id");
    // A mandate's run writes nothing to the graph: no claim to record on, no document to examine.
    const mandate = getResearchToolDefinitions({ claimScoped: false, graphWrites: false })[0]!;
    // It may submit what it finds as contributions, paid from contribution_budget_usd.
    expect(Object.keys((mandate.input_schema as { properties: Record<string, unknown> }).properties)).toEqual([
      "task", "model_tier", "budget_usd", "effort", "include_constitution", "contribution_budget_usd",
    ]);
    expect(mandate.description).toContain("writes nothing to the graph directly (research a mandate launches");
    expect(mandate.description).not.toContain("provenance tools on a claim-scoped task");
  });
});

describe("delegate_research", () => {
  it("refuses a thin brief, an unknown tier, and a bad budget before touching anything", () => funded(async () => {
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
  }));

  it("resolves the tier, opens and closes the run with the ceiling asked for, and returns the report", () => funded(async () => {
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
    expect(out.budget_left).toBe("$20.00 left in this pass's budget (the test lane)");
    expect(out.success).toBe(true);
    expect(out.research_run_id).toBe("run-1");
    expect(out.status).toBe("completed");
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.report.answer).toBe("It traces to one study.");
    expect(out.tools_offered).toContain("provenance_get_map");
    expect(out.notebook_sections).toEqual(["thread 1"]);
    expect(out.note).toMatch(/data, not a verified result/);

    expect(mocks.openResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: CLAIM,
        requestedBy: "claim_steward",
        model: "claude-sonnet-5-5",
        modelTier: "standard",
        effort: null,
        includeConstitution: false,
        // What the Steward asked for, within what its pass holds: no deployment cap.
        ceilingMicroUsd: 12_000_000,
      })
    );
    const passed = runResearcher.mock.calls[0]![0];
    expect(passed.claim).toEqual({ id: CLAIM, text: "The claim.", domains: [] });
    expect(passed.run.include_constitution).toBe(false);
    expect(mocks.closeResearchRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "completed", turns: 7, servedModels: ["claude-sonnet-5-5"] })
    );
    expect(tools.launchedCount).toBe(1);
  }, 20_000_000));

  it("launches an examination of a document: opened before the run, linked to it, and handed to the researcher (#507)", () => funded(async () => {
    const SOURCE = "dddddddd-0000-4000-8000-000000000001";
    mocks.openExamination.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "exam-1", source_id: input.sourceId, source_title: "Registry study", source_url: "https://x.org/s",
      facets: ["data", "method"], scope: input.scope,
    }));
    const runResearcher = vi.fn(async (_input: ResearcherInput) => okResult());
    const steward = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const out = JSON.parse(
      (await steward.execute("delegate_research", {
        task: BRIEF, model_tier: "standard", budget_usd: 1, examine_source_id: SOURCE, facets: ["data", "method"],
      }))!
    );
    expect(out.examination_id).toBe("exam-1");
    expect(out.note).toMatch(/under examinations/);
    expect(mocks.openExamination).toHaveBeenCalledWith({
      scope: "claim", trigger: "claim", claimId: CLAIM, grantId: null, sourceId: SOURCE,
      brief: BRIEF, facets: ["data", "method"], requestedBy: "claim_steward",
    });
    expect(mocks.linkResearchRun).toHaveBeenCalledWith("exam-1", "run-1");
    expect(runResearcher.mock.calls[0]![0].examination).toEqual({
      id: "exam-1", source_id: SOURCE, source_title: "Registry study", source_url: "https://x.org/s",
      facets: ["data", "method"], scope: "claim",
    });

    // A Grantmaker's run writes nothing to the graph, so it examines no document.
    const grantmaker = createResearchTools({ requestedBy: "grantmaker", grantId: "g-1", runResearcher });
    const refused = JSON.parse(
      (await grantmaker.execute("delegate_research", {
        task: BRIEF, model_tier: "cheap", budget_usd: 1, examine_source_id: SOURCE, facets: ["quotation"],
      }))!
    );
    expect(refused.message).toMatch(/writes nothing to the graph/);
    expect(mocks.openExamination).toHaveBeenCalledTimes(1);
    expect(grantmaker.definitions[0]!.input_schema).not.toHaveProperty("properties.examine_source_id");
  }));

  it("refuses a malformed examination before any spend, and facets without a document", () => funded(async () => {
    const runResearcher = vi.fn();
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    mocks.openExamination.mockRejectedValue(new ExaminationError("That source is not in this claim's map"));
    const refused = JSON.parse(
      (await tools.execute("delegate_research", {
        task: BRIEF, model_tier: "standard", budget_usd: 1, examine_source_id: "x", facets: ["data"],
      }))!
    );
    expect(refused).toEqual({ success: false, message: "That source is not in this claim's map" });
    const stray = JSON.parse(
      (await tools.execute("delegate_research", { task: BRIEF, model_tier: "standard", budget_usd: 1, facets: ["data"] }))!
    );
    expect(stray.message).toMatch(/facets go with examine_source_id/);
    expect(mocks.openResearchRun).not.toHaveBeenCalled();
    expect(runResearcher).not.toHaveBeenCalled();
  }));

  it("keeps effort on the strong tier only", () => funded(async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    await tools.execute("delegate_research", { task: BRIEF, model_tier: "strong", budget_usd: 1, effort: "max" });
    expect(mocks.openResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5-5", modelTier: "strong", effort: "max" })
    );
  }));

  it("launches without a count, and refuses when paused, over the daily cap on unfunded research, and when disabled", () => funded(async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const call = () => tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 });
    // No count of launches: three in one pass are fine while the pass can pay.
    for (let i = 0; i < 3; i++) expect(JSON.parse((await call())!).success).toBe(true);

    const fresh = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    mocks.readResearcherPaused.mockResolvedValueOnce(true);
    expect(JSON.parse((await fresh.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/paused/);
    mocks.checkResearcherBudget.mockRejectedValueOnce(new LlmBudgetExceededError("researcher_daily_cap_micro_usd", 5, 4));
    expect(JSON.parse((await fresh.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/not paid for by a funder/);
    expect(fresh.launchedCount).toBe(0);
    // The kill switch is read when the bundle is created, once per launcher run.
    mocks.config.researcherEnabled = false;
    const disabled = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    // Off, the launcher is offered nothing, and a call anyway is refused.
    expect(disabled.definitions).toEqual([]);
    expect(JSON.parse((await disabled.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message).toMatch(/disabled/);
  }));

  it("closes the run as failed when the researcher throws, and never throws itself", () => funded(async () => {
    const runResearcher = vi.fn(async () => {
      throw new Error("provider down");
    });
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const out = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "standard", budget_usd: 1 }))!);
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.message).toMatch(/provider down/);
    expect(mocks.closeResearchRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed", error: "provider down" }));
  }));

  it("runs a Grantmaker's research with no claim, and refuses one named per call", () => funded(async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "grantmaker", grantId: "grant-1", runResearcher });
    await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 });
    expect(mocks.openResearchRun).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: null, grantId: "grant-1", requestedBy: "grantmaker" }));
    expect(runResearcher.mock.calls[0]![0].claim).toBeNull();
    const named = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1, claim_id: CLAIM }))!);
    expect(named.message).toMatch(/writes nothing to the graph, so it takes no claim_id/);
    expect(mocks.openResearchRun).toHaveBeenCalledTimes(1);
    expect(runResearcher).toHaveBeenCalledTimes(1);
  }));

  it("adds what the researcher billed to the launcher's meter, and attributes the claim", () => funded(async () => {
    let seenClaim: string | null | undefined;
    const runResearcher = vi.fn(async () => {
      seenClaim = getUsageContext().claimId;
      getUsageContext().meter!.billedMicroUsd += 250_000;
      return okResult();
    });
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    const launcher = { billedMicroUsd: 1_000 };
    await runWithUsageContext({ meter: launcher }, () =>
      tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 })
    );
    expect(launcher.billedMicroUsd).toBe(251_000);
    expect(seenClaim).toBe(CLAIM);
    expect(mocks.closeResearchRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ spentMicroUsd: 250_000 }));
  }));

  it("holds a Steward to what its pass has left, and offers it no launch without a pass budget", async () => {
    const runResearcher = vi.fn(async () => {
      getUsageContext().meter!.billedMicroUsd += 700_000;
      return okResult();
    });
    await funded(async () => {
      const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
      expect(tools.definitions[0]!.description).toContain("(the test lane), which holds $2.00 now");
      // The pass has spent some of its budget on its own work.
      getUsageContext().meter!.billedMicroUsd += 500_000;
      const over = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1.6 }))!);
      expect(over).toEqual({
        success: false,
        message: "This run asks for $1.60, and this pass's budget (the test lane) has $1.50 left. Ask for what that covers, or do the work inline.",
      });
      const ok = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1.5 }))!);
      // What the research billed is the pass's spend too.
      expect(ok.budget_left).toBe("$0.80 left in this pass's budget (the test lane)");
    }, 2_000_000);
    expect(runResearcher).toHaveBeenCalledTimes(1);

    const unfunded = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
    expect(unfunded.definitions.map((t) => t.name)).toEqual(["get_research_run"]);
    expect(JSON.parse((await unfunded.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).message)
      .toMatch(/no budget of your own/);
  });

  it("lets a Grantmaker give a run any budget its mandate's uncommitted money covers", async () => {
    const runResearcher = vi.fn(async () => okResult());
    const tools = createResearchTools({ requestedBy: "grantmaker", grantId: "grant-1", runResearcher });
    mocks.grantCommitted = 30_000_000;
    const big = JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "strong", budget_usd: 60 }))!);
    expect(big.success).toBe(true);
    expect(mocks.openResearchRun).toHaveBeenLastCalledWith(expect.objectContaining({ ceilingMicroUsd: 60_000_000 }));
    expect(big.budget_left).toBe("$70.00 left in the mandate's uncommitted budget");
    const over = JSON.parse(
      (await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 60, contribution_budget_usd: 15 }))!
    );
    expect(over.message).toBe(
      "This run asks for $75.00, and the mandate's uncommitted budget has $70.00 left. Ask for what that covers, or do the work inline."
    );
  });

  it("applies the daily cap only to research no funder pays for", async () => {
    const runResearcher = vi.fn(async () => okResult());
    mocks.checkResearcherBudget.mockRejectedValue(new LlmBudgetExceededError("researcher_daily_cap_micro_usd", 5, 4));
    await runWithUsageContext({ jobId: "job-1" }, () =>
      funded(async () => {
        const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM, runResearcher });
        expect(JSON.parse((await tools.execute("delegate_research", { task: BRIEF, model_tier: "cheap", budget_usd: 1 }))!).success).toBe(true);
      })
    );
    expect(mocks.checkResearcherBudget).not.toHaveBeenCalled();
  });
});

describe("get_research_run", () => {
  it("returns the run with its report and notebook, and refuses another claim's or mandate's run", async () => {
    mocks.getResearchRun.mockResolvedValue({
      id: RUN, claim_id: CLAIM, grant_id: null, requested_by: "claim_steward", task: BRIEF, model: "m", model_tier: "cheap",
      status: "completed", spent_micro_usd: 123_456, turns: 3, tools: ["report"], started_at: new Date(0),
      finished_at: new Date(1), report: { answer: "a" }, notebook: { n: "x" }, error: null,
    });
    const tools = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM });
    const out = JSON.parse((await tools.execute("get_research_run", { research_run_id: RUN }))!);
    expect(out.success).toBe(true);
    expect(out.research_run.spent_usd).toBe(0.12);
    expect(out.research_run.report).toEqual({ answer: "a" });
    expect(out.research_run.notebook).toEqual({ n: "x" });
    const other = createResearchTools({ requestedBy: "claim_steward", claimId: "bbbbbbbb-0000-4000-8000-000000000001" });
    expect(JSON.parse((await other.execute("get_research_run", { research_run_id: RUN }))!).message).toMatch(/another claim or mandate/);
    // A Grantmaker reads only what its mandate launched.
    const grantmaker = createResearchTools({ requestedBy: "grantmaker", grantId: "grant-1" });
    expect(JSON.parse((await grantmaker.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(false);
    mocks.getResearchRun.mockResolvedValueOnce({ id: RUN, claim_id: null, grant_id: "grant-1", tools: [], notebook: {} });
    expect(JSON.parse((await grantmaker.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(true);
    // A malformed id is refused before it reaches the database.
    const calls = mocks.getResearchRun.mock.calls.length;
    expect(JSON.parse((await tools.execute("get_research_run", { research_run_id: "x" }))!).message).toMatch(/not a research run id/);
    expect(mocks.getResearchRun.mock.calls.length).toBe(calls);
    mocks.getResearchRun.mockResolvedValueOnce(null);
    expect(JSON.parse((await tools.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(false);
  });
});
