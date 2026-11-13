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
    researcherRequestMaxWallMinutes: 240,
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
  readResearchRun,
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
  it("offers reading runs to every launcher and funding requests to the Grantmaker; nothing launches research inline", () => {
    expect(getResearchToolDefinitions().map((t) => t.name)).toEqual(["get_research_run"]);
    expect(createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM }).definitions.map((t) => t.name)).toEqual(["get_research_run"]);
    expect(createResearchTools({ requestedBy: "grantmaker", grantId: "g-1" }).definitions.map((t) => t.name)).toEqual([
      "get_research_run",
      "fund_request",
    ]);
  });

  it("tells whoever writes the brief what the Researcher can use, query_sql included (#847)", async () => {
    const { getSpendToolDefinitions } = await import("../../../../src/llm/tools/spend-tools.js");
    const commission = getSpendToolDefinitions().find((t) => t.name === "commission")!;
    expect(commission.description).toContain(
      "The researcher's tools are web search, read_page, read_arxiv_source (the TeX, tables and data files of an arXiv paper's source), the graph's read tools, query_sql"
    );
    expect(commission.description).toMatch(/code-execution sandbox/);
    // Which tiers can look at a figure (#912), beside which can run code.
    expect(commission.description).toMatch(/look at a figure by its image URL \(view_image\)/);
  });

  it("says in fund_request that the run works to the budget given, not to the quote (#885)", async () => {
    const { getFundRequestToolDefinition } = await import("../../../../src/llm/tools/research-tools.js");
    const d = getFundRequestToolDefinition().description!;
    expect(d).toContain("The run works to the budget you give here, not to the quote");
    expect(d).toContain("A budget below the quote is accepted, and the result says so plainly");
    expect(d).toContain("funded at $X of a $Y quote");
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
    expect(JSON.parse((await other.execute("get_research_run", { research_run_id: RUN }))!).message).toMatch(/another claim, mandate or role/);
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
  it("serves a request's run to its keeper and to the Steward of each node it bears on, and to no one else (#718)", async () => {
    const OTHER = "bbbbbbbb-0000-4000-8000-000000000001";
    const REQUEST = "dddddddd-0000-4000-8000-000000000001";
    mocks.getResearchRun.mockResolvedValue({
      id: RUN, claim_id: null, grant_id: null, request_id: REQUEST, requested_by: "request", task: BRIEF,
      model: "m", model_tier: "strong", status: "completed", spent_micro_usd: 1, turns: 3, tools: [],
      started_at: new Date(0), finished_at: new Date(1), report: { answer: "a" }, notebook: {}, error: null,
    });
    // The request is the Curator's, and bears on CLAIM but not on OTHER.
    mocks.rawQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes("FROM requests r")
        ? [{ keeper_kind: "curator", keeper_claim_id: null, bears: params?.[1] === CLAIM }]
        : []
    );
    const bearsOn = createResearchTools({ requestedBy: "claim_steward", claimId: CLAIM });
    const read = JSON.parse((await bearsOn.execute("get_research_run", { research_run_id: RUN }))!);
    expect(read.success).toBe(true);
    expect(read.research_run.request_id).toBe(REQUEST);
    expect(read.research_run.report).toEqual({ answer: "a" });
    const elsewhere = createResearchTools({ requestedBy: "claim_steward", claimId: OTHER });
    expect(JSON.parse((await elsewhere.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(false);
    // The Curator reads it because it keeps the request.
    expect(JSON.parse(await readResearchRun({ research_run_id: RUN }, { curator: true })).success).toBe(true);
    // A Grantmaker does not, whoever funded the work.
    const gm = createResearchTools({ requestedBy: "grantmaker", grantId: "grant-1" });
    expect(JSON.parse((await gm.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(false);
    // The Steward that keeps a request reads it too.
    mocks.rawQuery.mockImplementation(async (sql: string) =>
      sql.includes("FROM requests r") ? [{ keeper_kind: "steward", keeper_claim_id: OTHER, bears: false }] : []
    );
    expect(JSON.parse((await elsewhere.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(true);
    expect(JSON.parse(await readResearchRun({ research_run_id: RUN }, { curator: true })).message).toMatch(/request you keep/);
  });
});

describe("research the Curator and the Audit Agent commissioned", () => {
  it("reads back the runs its role launched, and no other role's", async () => {
    const curator = createResearchTools({ requestedBy: "curator" });
    mocks.getResearchRun.mockResolvedValueOnce({ id: RUN, claim_id: null, grant_id: null, requested_by: "curator", tools: [], notebook: {} });
    expect(JSON.parse((await curator.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(true);
    mocks.getResearchRun.mockResolvedValueOnce({ id: RUN, claim_id: null, grant_id: null, requested_by: "audit", tools: [], notebook: {} });
    expect(JSON.parse((await curator.execute("get_research_run", { research_run_id: RUN }))!).message).toMatch(/another claim, mandate or role/);
    mocks.getResearchRun.mockResolvedValueOnce({ id: RUN, claim_id: CLAIM, grant_id: null, requested_by: "claim_steward", tools: [], notebook: {} });
    expect(JSON.parse((await curator.execute("get_research_run", { research_run_id: RUN }))!).success).toBe(false);
  });
});

describe("a reader (services/separate-reader.ts)", () => {
  const QUESTIONS = [
    { ask: "How many of the 500 transcripts did the monitor flag?", form: "number", unit: "transcripts" },
    { ask: "Quote where the report states its threshold.", form: "passage" },
  ];
  const stored = [
    { id: "q1", ask: QUESTIONS[0]!.ask, form: "number", unit: "transcripts" },
    { id: "q2", ask: QUESTIONS[1]!.ask, form: "passage" },
  ];

  beforeEach(() => {
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
      questions: input.questions ?? null,
    }));
  });

  it("get_research_run gives a reader's answers and neither its report nor its notebook", async () => {
    mocks.getResearchRun.mockResolvedValueOnce({
      id: RUN, claim_id: CLAIM, grant_id: null, requested_by: "claim_steward", tools: [], spent_micro_usd: 0, contribution_budget_micro_usd: 0,
      report: { answer: "prose the Steward is not given" },
      notebook: { "what I saw": "prose the Steward is not given" },
      questions: stored,
      answers: [{ question: "q1", answer: { form: "number", value: 0 } }],
    });
    const out = await readResearchRun({ research_run_id: RUN }, { claimId: CLAIM });
    const read = JSON.parse(out).research_run;
    expect(read.answers).toEqual([
      { question: "q1", asked: QUESTIONS[0]!.ask, form: "number", unit: "transcripts", answer: 0 },
      { question: "q2", asked: QUESTIONS[1]!.ask, form: "passage", not_answered: "The reader's run ended before it answered this question." },
    ]);
    expect(read.report).toBeUndefined();
    expect(read.notebook).toBeUndefined();
    expect(out).not.toContain("prose the Steward is not given");
  });
});
