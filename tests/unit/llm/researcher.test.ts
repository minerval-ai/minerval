import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

// The researcher (#298) over scripted loops and a recording DB: the toolset
// follows the model (web search on every tier, the sandbox on Claude only; the
// long-run loop on the strong tier, the ordinary loop elsewhere), the
// constitution is prepended when asked and not otherwise, the Provenance
// skill's researcher view is spliced and its tools offered while
// provenance_write_map is not, the report ends the run, the ceiling and the
// pause flag stop it, and the only tables it writes are its own run, the
// provenance tables, the claim's instances (on a Steward's claim-scoped run),
// and a fetched source's stored copy.

const mocks = vi.hoisted(() => ({
  writes: [] as Array<{ verb: string; table: string }>,
  // The rows inserted through the query builder, by table.
  inserted: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // Raw INSERTs, with their parameters.
  rawInserts: [] as Array<{ table: string; params: unknown[] }>,
  // The graph as the question tools read it: the run's node's kind, the
  // question each instance is on, and the question's answer set.
  graph: {
    kind: "claim",
    instanceQuestion: {} as Record<string, string>,
    answers: [] as string[],
  },
  longRunCalls: [] as Array<Record<string, unknown>>,
  toolLoopCalls: [] as Array<Record<string, unknown>>,
  script: {
    report: true,
    hookStop: null as string | null,
    // Extra tool calls the ordinary loop's model makes before it reports.
    calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
    outputs: [] as string[],
    // The turn notes the ordinary loop's model saw, and what each later turn billed.
    notes: [] as string[],
    bills: [] as number[],
    // Turns the ordinary loop runs through beforeTurn after the first.
    extraTurns: 0,
  },
  paused: false,
  meter: { billedMicroUsd: 0 },
  config: {
    researcherMaxWallMinutes: 20,
    leanCheckerUrl: "",
    elicitApiKey: "",
  },
}));

function recordSql(q: string) {
  const m = /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(q);
  if (m) mocks.writes.push({ verb: m[1]!.toUpperCase(), table: m[2]! });
}

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params?: unknown[]) => {
    recordSql(q);
    const insert = /^\s*INSERT INTO\s+([a-z_]+)/i.exec(q);
    if (insert) mocks.rawInserts.push({ table: insert[1]!, params: params ?? [] });
    if (/FROM platform_flags/.test(q)) return mocks.paused ? [{ value: true }] : [];
    if (/SELECT id, kind FROM claims WHERE id = \$1/.test(q)) return [{ id: params?.[0], kind: "claim" }];
    if (/SELECT kind FROM claims WHERE id = \$1 AND state = 'active'/.test(q)) return [{ kind: mocks.graph.kind }];
    if (/SELECT claim_id FROM claim_instances WHERE id = \$1/.test(q)) {
      const on = mocks.graph.instanceQuestion[String(params?.[0])];
      return on ? [{ claim_id: on }] : [];
    }
    if (/FROM claim_relationships/.test(q) && /relation_type = 'answers'/.test(q)) {
      return mocks.graph.answers.includes(String(params?.[1])) ? [{ child_claim_id: params?.[1] }] : [];
    }
    if (/INSERT INTO claim_instances[\s\S]*RETURNING id/.test(q)) return [{ id: "qinstance-1" }];
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: () => ({
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table as never);
        mocks.writes.push({ verb: "INSERT INTO", table: name });
        mocks.inserted.push({ table: name, values });
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: "instance-1", ...values }],
        });
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: async () => {
          mocks.writes.push({ verb: "UPDATE", table: getTableName(table as never) });
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  }),
}));

vi.mock("../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config.js")>();
  return { ...original, loadConfig: () => ({ ...original.loadConfig(), ...mocks.config }) };
});

vi.mock("../../../src/llm/usage-context.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/llm/usage-context.js")>();
  return {
    ...original,
    getUsageContext: () => ({ agent: "researcher", runId: "agent-run-1", meter: mocks.meter }),
  };
});

vi.mock("../../../src/llm/client.js", () => ({
  longRunToolLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.longRunCalls.push(options);
    const before = options.beforeTurn as (s: unknown) => Promise<{ stop?: string } | void>;
    const stop = await before({ turn: 0 });
    if (stop && stop.stop) return { result: null, turns: 0, stopReason: "hook", hookStop: stop.stop };
    const exec = options.executeTool as (n: string, i: Record<string, unknown>) => Promise<string>;
    await exec("notebook_write", { section: "thread", content: "started" });
    if (mocks.script.report) {
      const onFinal = options.onFinalTool as (n: string, i: Record<string, unknown>) => unknown;
      onFinal("report", { answer: "done", findings: [], sources_consulted: [], provenance_recorded: "none", caveats: "", what_would_change: "", suggested_next_steps: "" });
      return { result: null, turns: 2, stopReason: "final_tool" };
    }
    return { result: null, turns: 2, stopReason: "max_wall" };
  }),
  toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.toolLoopCalls.push(options);
    const beforeTurn = options.beforeTurn as ((i: number) => Promise<void>) | undefined;
    await beforeTurn?.(0);
    const exec = options.executeTool as (n: string, i: Record<string, unknown>) => Promise<string>;
    const turnNote = options.turnNote as ((u: number, m: number) => string) | undefined;
    for (const c of mocks.script.calls) mocks.script.outputs.push(await exec(c.name, c.input));
    if (mocks.script.calls.length > 0 && turnNote) mocks.script.notes.push(turnNote(1, 40));
    for (const bill of mocks.script.bills) {
      mocks.meter.billedMicroUsd += bill;
      if (turnNote) mocks.script.notes.push(turnNote(2, 40));
    }
    for (let t = 1; t <= mocks.script.extraTurns; t++) await beforeTurn?.(t);
    const first = JSON.parse(await exec("notebook_write", { section: "thread", content: "started" }));
    if (!first.success) {
      // Halted by the ceiling or the pause flag: the model reports, as told.
      const onFinal = options.onFinalTool as (n: string, i: Record<string, unknown>) => unknown;
      if (mocks.script.report) onFinal("report", { answer: "partial", findings: [], sources_consulted: [], provenance_recorded: "none", caveats: "", what_would_change: "", suggested_next_steps: "" });
      return { stopReason: "tool_use", toolUses: [], rawContent: [], content: "", model: options.model };
    }
    if (mocks.script.report) {
      const onFinal = options.onFinalTool as (n: string, i: Record<string, unknown>) => unknown;
      onFinal("report", { answer: "done", findings: [], sources_consulted: [], provenance_recorded: "none", caveats: "", what_would_change: "", suggested_next_steps: "" });
    }
    return { stopReason: "end_turn", toolUses: [], rawContent: [], content: "", model: options.model };
  }),
}));

vi.mock("../../../src/services/source-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/services/source-service.js")>();
  return {
    ...original,
    getOrCreateSource: vi.fn(async (input: { url: string }) => ({ id: "source-1", url: input.url })),
  };
});

vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  elicitConfigured: () => false,
  getElicitToolDefinitions: async () => [],
  executeElicitTool: async () => "{}",
  isElicitTool: (n: string) => n.startsWith("elicit_"),
}));

import { runResearcher } from "../../../src/llm/agents/researcher.js";
import { getConstitution } from "../../../src/llm/prompts/constitution.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";

function input(over: Partial<{ model: string; model_tier: string; include_constitution: boolean; domains: string[]; claim: boolean; ceiling: number; kind: string }> = {}) {
  return {
    run: {
      id: "run-1",
      claim_id: over.claim === false ? null : CLAIM,
      grant_id: null,
      requested_by: "claim_steward",
      task: "Trace the figure to its origin.",
      model: over.model ?? "claude-sonnet-5-5",
      model_tier: over.model_tier ?? "standard",
      effort: "high",
      include_constitution: over.include_constitution ?? true,
      ceiling_micro_usd: over.ceiling ?? 2_000_000,
      notebook: {},
    },
    claim: over.claim === false ? null : { id: CLAIM, text: "The claim.", domains: over.domains ?? [], ...(over.kind ? { kind: over.kind } : {}) },
  };
}

beforeEach(() => {
  mocks.writes.length = 0;
  mocks.inserted.length = 0;
  mocks.rawInserts.length = 0;
  mocks.graph.kind = "claim";
  mocks.graph.instanceQuestion = {};
  mocks.graph.answers = [];
  mocks.longRunCalls.length = 0;
  mocks.toolLoopCalls.length = 0;
  mocks.script.report = true;
  mocks.script.calls = [];
  mocks.script.outputs = [];
  mocks.script.notes = [];
  mocks.script.bills = [];
  mocks.script.extraTurns = 0;
  mocks.paused = false;
  mocks.meter.billedMicroUsd = 0;
});

const FORBIDDEN_TABLES = [
  "claims",
  "assessments",
  "arguments",
  "argument_evaluations",
  "claim_relationships",
  "claim_instances",
  "contributions",
  "claim_source_maps",
  "owl_ledger",
  "bounties",
  "prize_claims",
];

describe("toolset by model", () => {
  it("runs a standard Claude model on the ordinary loop with web search and the sandbox", async () => {
    const result = await runResearcher(input());
    expect(result.status).toBe("completed");
    expect(result.report).toMatchObject({ answer: "done", harness: { model: "claude-sonnet-5-5" } });
    expect(mocks.longRunCalls).toHaveLength(0);
    expect(mocks.toolLoopCalls).toHaveLength(1);
    const names = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("code_execution");
    expect(names).toContain("provenance_get_map");
    expect(names).toContain("provenance_record_edge");
    expect(names).not.toContain("provenance_write_map");
    expect(names).not.toContain("provenance_record_root");
    expect(names).not.toContain("delegate_research");
    expect(names).toContain("record_claim_instance");
    expect(names).not.toContain("update_claim_instance");
    expect(names).not.toContain("detach_claim_instance");
    expect(names).not.toContain("lean_search");
    expect(names).toContain("read_page");
    expect(names.slice(-3)).toEqual(["report", "web_search", "code_execution"]);
    expect(result.toolNames).toEqual(names);
    const task = (mocks.toolLoopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("Trace the figure to its origin.");
    // The budget in units the model can act on: turns on this model, what a
    // page costs over the run, and what the tools cost beyond tokens.
    expect(task).toMatch(/Budget: \$2\.00 of metered work\. On claude-sonnet-5-5 that is roughly \d+ turns/);
    expect(task).toMatch(/a page read in full early on costs about \$0\.\d\d by the end of the run/);
    expect(task).toContain("web_search carries a fee");
    expect(task).toContain("read_page has no fee");
    expect(task).toContain("code_execution is billed at $0.05 per container-hour");
    expect(task).toContain("a guard of 200 turns stops a stuck loop");
    expect(task).toContain("must report within 20 minutes of wall-clock time");
    expect(task).toContain("launched by the Claim Steward of the claim below");
    expect(task).toContain("The code-execution sandbox is available");
  });

  it("runs the strong tier on the long-run loop with effort and a task budget", async () => {
    const result = await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
    expect(result.status).toBe("completed");
    expect(mocks.longRunCalls).toHaveLength(1);
    const opts = mocks.longRunCalls[0]!;
    expect(opts.effort).toBe("high");
    expect(opts.fallbacks).toBe("none");
    expect(typeof opts.taskBudgetTokens).toBe("number");
    expect(opts.maxWallMs).toBe(20 * 60_000);
    const names = (opts.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("code_execution");
  });

  it("runs the cheap tier with client-side web search and no sandbox, and says so in the task", async () => {
    await runResearcher(input({ model: "openai/gpt-6-luna", model_tier: "cheap" }));
    expect(mocks.longRunCalls).toHaveLength(0);
    const opts = mocks.toolLoopCalls[0]!;
    const names = (opts.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("code_execution");
    expect(names).toContain("provenance_read_source");
    expect(names).toContain("search_claims");
    expect(names).toContain("read_page");
    // The client-side web_search (OpenRouter), not the Anthropic server tool.
    const search = (opts.tools as Array<{ name: string; type?: string; input_schema?: unknown }>).find(
      (t) => t.name === "web_search"
    )!;
    expect(search.type).toBeUndefined();
    expect(search.input_schema).toBeDefined();
    expect(names.slice(-2)).toEqual(["report", "web_search"]);
    const task = (opts.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("There is no code-execution sandbox this run");
    // A provider-priced model gets no up-front estimate, only the running line.
    expect(task).toContain("priced by its provider per call, so there is no estimate up front");
    expect(task).not.toContain("code_execution is billed");
  });

  it("offers Mathlib search on a mathematical claim only when a checker is configured", async () => {
    await runResearcher(input({ domains: ["mathematics"] }));
    let names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("lean_search");
    mocks.config.leanCheckerUrl = "http://checker";
    try {
      await runResearcher(input({ domains: ["mathematics"] }));
      names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("lean_search");
      expect(names).toContain("lean_elaborate");
      expect(names).not.toContain("lean_check");
      expect(names).not.toContain("publish_formalization");
    } finally {
      mocks.config.leanCheckerUrl = "";
    }
  });

  it("offers no provenance tools off a claim, and says so in the task", async () => {
    await runResearcher(input({ claim: false }));
    const names = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("provenance_"))).toEqual([]);
    const task = (mocks.toolLoopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("serves a mandate rather than one claim");
  });

  it("offers the examination tools, and the read tool off a claim, only on a run launched as an examination (#507)", async () => {
    await runResearcher(input());
    let names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("examination_"))).toEqual([]);

    // A review of the document for its own sake is a request bearing on it
    // alone (#865), taken up like any request.
    const review = input({ claim: false });
    review.run.requested_by = "request";
    review.examination = {
      id: "exam-1", source_id: "s1", source_title: "Registry study", source_url: "https://x.org/s",
      facets: ["data", "method"], scope: "document",
    };
    await runResearcher(review);
    names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("examination_"))).toEqual([
      "examination_outline", "examination_record_coverage", "examination_record_finding",
    ]);
    // Reading the document, yes; recording on a claim, no.
    expect(names.filter((n) => n.startsWith("provenance_"))).toEqual(["provenance_read_source"]);
    expect(names).not.toContain("examination_note_finding");
    const task = (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain(
      'an examination of one document: "Registry study" (https://x.org/s), a review of the document for its own sake (When You Review a Document), checking so far data, method'
    );
    expect(task).toContain("It bears on one document and on no node, so it asks for a review of that document");
    expect(task).toContain("Begin with examination_outline");
    expect(task).not.toContain("serves a mandate");
  });

  it("asks a document review opened with no facets to name them (#865)", async () => {
    const review = input({ claim: false });
    review.run.requested_by = "request";
    review.examination = {
      id: "exam-2", source_id: "s1", source_title: "Registry study", source_url: null,
      facets: [], scope: "document",
    };
    await runResearcher(review);
    const task = (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("with no facets named yet: name what you will check with examination_outline's add_facets");
  });

  it("tells a scoping run on a document review what it will price (#865)", async () => {
    const scope = input({ claim: false });
    scope.run.requested_by = "request_scope";
    scope.documentReview = { title: "Registry study", url: "https://x.org/s", chars: 41000, segments: 17 };
    await runResearcher(scope);
    const task = (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain('The request bears on one document alone, "Registry study" (https://x.org/s), so the full work is a review of it');
    expect(task).toContain("41,000 characters of its text, divided into 17 parts");
    // Scoping prices the work and examines nothing.
    const names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("examination_"))).toEqual([]);
  });

  it("names the launcher in the task message", async () => {
    const i = input();
    i.run.requested_by = "grantmaker";
    await runResearcher(i);
    const task = (mocks.toolLoopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("launched by the Grantmaker of a funded mandate");
  });

  it("serves the Curator and the Audit Agent with reads and a report, writing nothing to the graph", async () => {
    for (const [launcher, name, serves] of [
      ["curator", "the Curator, which keeps the graph's structure", "the Curator's work on the graph's structure"],
      ["audit", "the Audit Agent, reviewing how decisions were made", "the Audit Agent's review of a decision"],
    ] as const) {
      const i = input({ claim: false });
      i.run.requested_by = launcher;
      await runResearcher(i);
      const names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names.filter((n) => n.startsWith("provenance_") || n.startsWith("examination_"))).toEqual([]);
      expect(names).not.toContain("record_claim_instance");
      expect(names).not.toContain("submit_contribution");
      expect(names).toContain("get_source_examinations");
      const task = (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
      expect(task).toContain(`launched by ${name}`);
      expect(task).toContain(`This investigation serves ${serves}. It writes nothing to the graph`);
      expect(task).not.toContain("serves a mandate");
    }
  });

  it("withholds every graph-writing tool from a Grantmaker's run, whatever it was handed", async () => {
    const i = input();
    i.run.requested_by = "grantmaker";
    (i as { examination?: unknown }).examination = {
      id: "exam-1", source_id: "s1", source_title: "Registry study", source_url: "https://x.org/s",
      facets: ["data"], scope: "claim",
    };
    await runResearcher(i);
    const names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("provenance_") || n.startsWith("examination_"))).toEqual([]);
    expect(names).not.toContain("record_claim_instance");
    const task = (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("Research a mandate funds writes nothing to the graph");
  });
});

describe("a run that works a request", () => {
  const requestRun = (requestedBy: "request" | "request_scope") => {
    const i = input({ claim: false, model: "claude-opus-5-5", model_tier: "strong" });
    i.run.requested_by = requestedBy;
    return i;
  };

  it("gets a long backstop rather than the delegated cap, and is told nobody waits on it (#734)", async () => {
    (mocks.config as Record<string, unknown>).researcherRequestMaxWallMinutes = 240;
    try {
      await runResearcher(requestRun("request"));
      expect(mocks.longRunCalls.at(-1)!.maxWallMs).toBe(240 * 60_000);
      const task = (mocks.longRunCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
      expect(task).toContain("a backstop of 240 minutes of wall-clock time ends a run that has stopped making progress");
      expect(task).toContain("Nobody is waiting on this run");
      expect(task).not.toContain("is waiting on the report");

      await runResearcher(requestRun("request_scope"));
      expect(mocks.longRunCalls.at(-1)!.maxWallMs).toBe(240 * 60_000);

      // A delegated run keeps the short cap and its reason.
      await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
      expect(mocks.longRunCalls.at(-1)!.maxWallMs).toBe(20 * 60_000);
      const delegated = (mocks.longRunCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;
      expect(delegated).toContain("because whoever launched it is waiting on the report");
    } finally {
      delete (mocks.config as Record<string, unknown>).researcherRequestMaxWallMinutes;
    }
  });

  it("reads requests on a request run only, and documents on every run (#746)", async () => {
    await runResearcher(requestRun("request"));
    let names = (mocks.longRunCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    for (const n of ["get_request", "list_requests", "get_source", "get_source_examinations", "file_request"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("close_request");
    expect(names).not.toContain("revise_request");

    await runResearcher(requestRun("request_scope"));
    names = (mocks.longRunCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("get_request");
    expect(names).toContain("list_requests");

    await runResearcher(input());
    names = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("get_source");
    expect(names).toContain("get_source_examinations");
    expect(names).not.toContain("get_request");
    expect(names).not.toContain("list_requests");
  });

  it("refuses a malformed id on the document reads, writing nothing", async () => {
    mocks.script.calls = [
      { name: "get_source", input: { source_id: "not-an-id" } },
      { name: "get_source_examinations", input: { source_id: "" } },
    ];
    await runResearcher(input());
    expect(JSON.parse(mocks.script.outputs[0]!).message).toMatch(/is not a source id/);
    expect(JSON.parse(mocks.script.outputs[1]!).message).toMatch(/is not a source id/);
    expect(mocks.writes.filter((w) => w.table !== "research_runs")).toEqual([]);
  });
});

describe("the issue channel (#743)", () => {
  it("carries raise_issue and its companions", async () => {
    await runResearcher(input());
    const names = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    for (const n of ["raise_issue", "update_issue", "search_issues", "get_issue"]) expect(names).toContain(n);
  });
});

describe("a run that takes up a request (#728, #730, #732)", () => {
  const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
  const requestInput = (over: { claim?: boolean; nodes?: boolean; scope?: boolean; kind?: string } = {}) => {
    const i = input({ claim: over.claim ?? false, ...(over.kind ? { kind: over.kind } : {}) }) as ReturnType<typeof input> & {
      requestNodes?: unknown;
      priorRun?: unknown;
      fullWork?: unknown;
    };
    i.run.requested_by = over.scope ? "request_scope" : "request";
    if (over.nodes) {
      i.requestNodes = [
        { id: CLAIM, text: "The first node.", domains: ["mathematics"], kind: "claim" },
        { id: OTHER, text: "The second node.", domains: [], kind: "question" },
      ];
    }
    return i;
  };
  const names = () => (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
  const task = () => (mocks.toolLoopCalls.at(-1)!.initialMessages as Array<{ content: string }>)[0]!.content;

  it("records provenance and instances on the one node a request bears on, and says so", async () => {
    await runResearcher(requestInput({ claim: true }));
    expect(names()).toEqual(expect.arrayContaining([
      "provenance_get_map", "provenance_read_source", "provenance_record_reading", "provenance_record_edge",
      "record_claim_instance", "file_request",
    ]));
    expect(names()).not.toContain("provenance_write_map");
    expect(task()).toContain("It bears on one node");
    expect(task()).toContain("you record no verdict");
    expect(task()).not.toContain("writes nothing to the graph");
  });

  it("limits the node provenance tools to the nodes a request on several bears on", async () => {
    mocks.script.calls = [
      { name: "provenance_record_reading", input: { instance_id: "i1", support: "supports" } },
      { name: "provenance_record_reading", input: { claim_id: "cccccccc-0000-4000-8000-000000000009", instance_id: "i1" } },
    ];
    await runResearcher(requestInput({ nodes: true }));
    const tools = mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string; input_schema: { properties: Record<string, { enum?: string[] }>; required?: string[] } }>;
    const reading = tools.find((t) => t.name === "provenance_record_reading")!;
    expect(reading.input_schema.properties.claim_id!.enum).toEqual([CLAIM, OTHER]);
    expect(reading.input_schema.required).toContain("claim_id");
    // Sources need no node.
    const read = tools.find((t) => t.name === "provenance_read_source")!;
    expect(read.input_schema.properties.claim_id).toBeUndefined();
    // No instance tool: an instance is recorded on one node a run serves.
    expect(names()).not.toContain("record_claim_instance");
    for (const out of mocks.script.outputs) {
      expect(JSON.parse(out).message).toMatch(/one of the nodes this request bears on/);
    }
    expect(task()).toContain("It bears on several nodes");
    expect(task()).toContain(OTHER);
  });

  it("reads sources whole on a request that bears on no node, and records nothing on one", async () => {
    await runResearcher(requestInput());
    expect(names().filter((n) => n.startsWith("provenance_"))).toEqual(["provenance_read_source"]);
    expect(task()).toContain("bears on no node the graph holds");
  });

  it("records nothing on a scoping run, names the tier the full work runs on, and asks for the plan", async () => {
    const i = requestInput({ claim: true, scope: true });
    i.fullWork = { tier: "strong", model: "claude-opus-5-5", effort: "high" };
    await runResearcher(i);
    expect(names().filter((n) => n.startsWith("provenance_"))).toEqual([]);
    expect(names()).not.toContain("record_claim_instance");
    expect(task()).toContain("The full work will run on the strong tier (claude-opus-5-5, high effort)");
    const report = (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string; input_schema: { properties: Record<string, unknown> } }>)
      .find((t) => t.name === "report")!;
    expect(report.input_schema.properties.plan).toBeDefined();
  });

  it("opens with the previous run's notebook and says where it came from", async () => {
    const i = requestInput();
    i.run.notebook = { "from run abcdef12: thread": "where it stood" };
    i.priorRun = { id: "abcdef12-0000-4000-8000-000000000001", status: "budget", requestedBy: "request" };
    await runResearcher(i);
    expect(task()).toContain("the previous run on this request left (research run abcdef12-0000-4000-8000-000000000001, which took it up and ended budget)");
    expect(task()).toContain("from run abcdef12: thread");
  });
});

describe("the prompt", () => {
  it("says which of its writing readers see (#739)", async () => {
    await runResearcher(input());
    const system = (mocks.toolLoopCalls[0]!.system as string[])[0]!.replace(/\s+/g, " ");
    expect(system).not.toContain("nothing you write is shown to the public");
    expect(system).toContain("Your report and notebook go only to the administrator.");
    expect(system).toContain("provenance notes, examination findings, and the instances you record");
  });

  it("restates §9's analysis paragraph only when the constitution is left out", async () => {
    await runResearcher(input());
    const withConstitution = (mocks.toolLoopCalls.at(-1)!.system as string[])[0]!;
    expect(withConstitution).toContain("Hold your own analysis to §9's standard, and higher");
    expect(withConstitution).not.toContain("try analyses until one comes out");
    await runResearcher(input({ include_constitution: false }));
    const without = (mocks.toolLoopCalls.at(-1)!.system as string[])[0]!;
    expect(without).toContain("try analyses until one comes out");
    expect(without).not.toContain("<<analysis>>");
  });

  it("leaves the answer's length to judgment", async () => {
    const { RESEARCH_REPORT_TOOL } = await import("../../../src/llm/agents/researcher.js");
    const answer = (RESEARCH_REPORT_TOOL.input_schema.properties as Record<string, { description: string }>).answer!;
    expect(answer.description).not.toMatch(/sentences/);
    expect(answer.description).toContain("as long as it needs to be");
  });

  it("prepends the constitution by default and lists the skills it can load, splicing none", async () => {
    await runResearcher(input());
    const system = mocks.toolLoopCalls[0]!.system as string[];
    expect(system).toHaveLength(1);
    expect(system[0]).toContain(getConstitution().slice(0, 200));
    expect(system[0]).toContain("# Your Specific Role");
    expect(system[0]).toContain("You are the researcher");
    expect(system[0]).toContain("## Skills");
    expect(system[0]).toContain("- provenance (method). ");
    expect(system[0]).not.toContain("# Method skill:");
  });

  it("loads the Provenance skill with its own section, which carries the procedure, not the Steward's (#765)", async () => {
    await runResearcher(input());
    const call = mocks.toolLoopCalls[0] as unknown as {
      tools: Array<{ name: string }>;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
    };
    expect(call.tools.map((t) => t.name)).toContain("load_skill");
    const view = await call.executeTool("load_skill", { name: "provenance" });
    expect(view.startsWith("# Method skill: Provenance")).toBe(true);
    expect(view).toContain("## For every administrator");
    expect(view).not.toContain("## For the Claim Steward");
    expect(view).toContain("## For the researcher");
    expect(view).toContain("Begin with `provenance_get_map`");
    expect(view).not.toContain("## For the Audit Agent");
  });

  it("carries only the role when the launcher dropped the constitution", async () => {
    await runResearcher(input({ include_constitution: false }));
    const system = mocks.toolLoopCalls[0]!.system as string[];
    expect(system[0]).not.toContain("# Epistemic Graph Administrator Constitution");
    expect(system[0]!.startsWith("# Your Role: Researcher")).toBe(true);
  });
});

describe("harness stops", () => {
  it("stops the long-run loop at the ceiling before the turn, as budget", async () => {
    mocks.meter.billedMicroUsd = 2_000_000;
    const result = await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
    expect(result.status).toBe("budget");
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/cost ceiling/);
  });

  it("stops the long-run loop when the operator pauses, as paused", async () => {
    mocks.paused = true;
    const result = await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
    expect(result.status).toBe("paused");
  });

  it("reports a wall-cap stop without a report as timeout", async () => {
    mocks.script.report = false;
    const result = await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
    expect(result.status).toBe("timeout");
  });

  it("refuses tool calls past the ceiling on the ordinary loop and accepts the report that follows", async () => {
    mocks.meter.billedMicroUsd = 5_000_000;
    const result = await runResearcher(input());
    expect(result.status).toBe("completed");
    expect(result.report).toMatchObject({ answer: "partial" });
    expect(result.stopReason).toBe("final_tool");
  });

  it("stops the ordinary loop at the wall cap, as timeout", async () => {
    mocks.script.report = false;
    mocks.script.extraTurns = 3;
    let t = 0;
    const result = await runResearcher({ ...input(), maxWallMs: 1000, now: () => (t += 600) });
    expect(result.status).toBe("timeout");
    expect(result.stopReason).toBe("max_wall");
  });

  it("gives the ordinary loop one last turn past the ceiling, then stops it, as budget", async () => {
    // Crossed by what the executor never sees (a server tool, a
    // pause_turn continuation): beforeTurn catches it.
    mocks.script.report = false;
    mocks.script.extraTurns = 3;
    mocks.script.calls = [{ name: "notebook_read", input: {} }];
    mocks.meter.billedMicroUsd = 3_000_000;
    const result = await runResearcher(input());
    expect(JSON.parse(mocks.script.outputs[0]!).message).toMatch(/cost ceiling/);
    expect(result.status).toBe("budget");
    expect(result.stopReason).toBe("hook");
    expect(result.turns).toBe(1);
  });

  it("counts model turns, not tool calls", async () => {
    mocks.script.calls = [
      { name: "notebook_read", input: {} },
      { name: "notebook_read", input: {} },
      { name: "notebook_read", input: {} },
    ];
    mocks.script.extraTurns = 1;
    const result = await runResearcher(input());
    expect(result.turns).toBe(2);
  });

  it("shows the spend after every turn, and the wrap-up notice once past 85 percent", async () => {
    mocks.meter.billedMicroUsd = 1_000_000;
    mocks.script.calls = [{ name: "notebook_read", input: {} }];
    mocks.script.bills = [100_000, 700_000, 50_000];
    await runResearcher(input());
    const notes = mocks.script.notes;
    expect(notes[0]).toMatch(/^Budget: \$1\.00 of \$2\.00 spent \(50%\)\./);
    expect(notes[1]).toContain("Your last turn cost $0.10; at that rate about 9 turns remain");
    expect(notes[2]).toMatch(/^Budget: \$1\.80 of \$2\.00 spent \(90%\)/);
    expect(notes[2]).toContain("about fifteen percent");
    expect(notes[3]).not.toContain("about fifteen percent");
  });

  it("marks a run that ended without a report as no_report", async () => {
    mocks.script.report = false;
    const result = await runResearcher(input());
    expect(result.status).toBe("no_report");
    expect(result.report).toBeNull();
    expect(result.error).toMatch(/without calling report/);
  });
});

describe("what the researcher may write", () => {
  it("refuses a tool it was not offered, and a provenance call on another claim", async () => {
    mocks.script.calls = [
      { name: "provenance_write_map", input: { summary: "x" } },
      { name: "update_claim_instance", input: {} },
      { name: "provenance_record_reading", input: { claim_id: "bbbbbbbb-0000-4000-8000-000000000002" } },
    ];
    await runResearcher(input());
    expect(JSON.parse(mocks.script.outputs[0]!).message).toMatch(/not in this run's toolset/);
    expect(JSON.parse(mocks.script.outputs[1]!).message).toMatch(/not in this run's toolset/);
    expect(JSON.parse(mocks.script.outputs[2]!).message).toMatch(/provenance tools work on it alone/);
    const tables = new Set(mocks.writes.map((w) => w.table));
    expect(tables.has("claim_source_maps")).toBe(false);
  });

  const INSTANCE = {
    url: "https://example.org/op-ed",
    verbatim_text: "The claim, as the op-ed puts it.",
    stance: "affirms",
    speaker: "A. Writer",
  };

  it("offers record_claim_instance only on a Steward's run scoped to a claim proper", async () => {
    const offered = async (i: ReturnType<typeof input>) => {
      await runResearcher(i);
      return (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name).includes("record_claim_instance");
    };
    expect(await offered(input())).toBe(true);
    expect(await offered(input({ kind: "claim" }))).toBe(true);
    // Off a claim, on a quantity or a question, and for any launcher that
    // does not write the graph: not offered.
    expect(await offered(input({ claim: false }))).toBe(false);
    expect(await offered(input({ kind: "quantity" }))).toBe(false);
    // A question takes record_question_instance instead.
    expect(await offered(input({ kind: "question" }))).toBe(false);
    for (const launcher of ["grantmaker", "request_scope"]) {
      const i = input();
      i.run.requested_by = launcher;
      expect(await offered(i)).toBe(false);
    }
  });

  it("drops claim_id from the researcher's schema and refuses another claim's id", async () => {
    await runResearcher(input());
    const tool = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string; input_schema: { properties: object; required: string[] } }>)
      .find((t) => t.name === "record_claim_instance")!;
    expect(Object.keys(tool.input_schema.properties)).not.toContain("claim_id");
    expect(tool.input_schema.required).toEqual(["url", "verbatim_text", "stance"]);

    mocks.script.calls = [
      { name: "record_claim_instance", input: { ...INSTANCE, claim_id: "bbbbbbbb-0000-4000-8000-000000000002" } },
    ];
    await runResearcher(input());
    expect(JSON.parse(mocks.script.outputs[0]!)).toMatchObject({
      success: false,
      message: expect.stringMatching(/serves claim aaaaaaaa-0000-4000-8000-000000000001; record_claim_instance records on it alone/),
    });
    expect(mocks.inserted.filter((r) => r.table === "claim_instances")).toEqual([]);
  });

  it("records an instance on the run's claim, attributed to the researcher, through the Steward's executor", async () => {
    mocks.script.calls = [
      { name: "record_claim_instance", input: { ...INSTANCE } },
      { name: "record_claim_instance", input: { ...INSTANCE, claim_id: CLAIM } },
    ];
    await runResearcher(input());
    const first = JSON.parse(mocks.script.outputs[0]!);
    expect(first).toMatchObject({ success: true, instance_id: "instance-1", source_id: "source-1" });
    expect(first.message).toContain("recorded as yours; the Steward owns the instance set and may correct or detach it");
    expect(JSON.parse(mocks.script.outputs[1]!).success).toBe(true);
    const rows = mocks.inserted.filter((r) => r.table === "claim_instances");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.values).toMatchObject({
        claimId: CLAIM,
        sourceId: "source-1",
        stance: "affirms",
        speaker: "A. Writer",
        createdBy: "researcher",
      });
    }
    // The only graph table it wrote is the claim's instances.
    const tables = new Set(mocks.writes.map((w) => w.table));
    for (const forbidden of FORBIDDEN_TABLES.filter((t) => t !== "claim_instances")) {
      expect(tables.has(forbidden)).toBe(false);
    }
  });

  it("writes only its own run row and the notebook; never a claim, an assessment, an argument, an edge, or an instance", async () => {
    await runResearcher(input());
    await runResearcher(input({ model: "claude-opus-5-5", model_tier: "strong" }));
    const tables = new Set(mocks.writes.map((w) => w.table));
    for (const forbidden of FORBIDDEN_TABLES) expect(tables.has(forbidden)).toBe(false);
    expect(tables.has("research_runs")).toBe(true);
    for (const t of tables) {
      expect(["research_runs", "agent_runs", "agent_steps", "llm_usage"]).toContain(t);
    }
  });
});

describe("a question's instances", () => {
  const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
  const ANSWER = "cccccccc-0000-4000-8000-000000000003";
  const ASKING = {
    url: "https://example.org/survey",
    verbatim_text: "Whether the question holds is open.",
    role: "asks",
    speaker: "A. Surveyor",
  };
  const question = () => input({ kind: "question" });
  const toolNames = () => (mocks.toolLoopCalls.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);

  beforeEach(() => {
    mocks.graph.kind = "question";
  });

  it("offers record_question_instance only on a Steward's run scoped to a question", async () => {
    await runResearcher(question());
    expect(toolNames()).toContain("record_question_instance");
    expect(toolNames()).not.toContain("record_claim_instance");
    for (const kind of ["claim", "quantity"]) {
      await runResearcher(input({ kind }));
      expect(toolNames()).not.toContain("record_question_instance");
    }
    for (const launcher of ["grantmaker", "request_scope"]) {
      const i = question();
      i.run.requested_by = launcher;
      await runResearcher(i);
      expect(toolNames()).not.toContain("record_question_instance");
    }
  });

  it("drops question_id from the researcher's schema and refuses another question's id", async () => {
    await runResearcher(question());
    const tool = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string; input_schema: { properties: object; required: string[] } }>)
      .find((t) => t.name === "record_question_instance")!;
    expect(Object.keys(tool.input_schema.properties)).not.toContain("question_id");
    expect(tool.input_schema.required).toEqual(["role"]);

    mocks.script.calls = [{ name: "record_question_instance", input: { ...ASKING, question_id: OTHER } }];
    await runResearcher(question());
    expect(JSON.parse(mocks.script.outputs[0]!)).toMatchObject({
      success: false,
      message: expect.stringMatching(/serves question aaaaaaaa-0000-4000-8000-000000000001; record_question_instance records on it alone/),
    });
    expect(mocks.rawInserts.filter((r) => r.table === "claim_instances")).toEqual([]);
  });

  it("refuses an instance of another question, and an answer outside the answer set, writing nothing", async () => {
    mocks.graph.instanceQuestion = { "inst-elsewhere": OTHER };
    mocks.graph.answers = [ANSWER];
    mocks.script.calls = [
      { name: "record_question_instance", input: { instance_id: "inst-elsewhere", role: "asks" } },
      { name: "record_question_instance", input: { instance_id: "inst-missing", role: "asks" } },
      { name: "record_question_instance", input: { ...ASKING, role: "answers", answer_id: OTHER } },
      { name: "record_question_instance", input: { ...ASKING, role: "asks", answer_id: ANSWER } },
    ];
    await runResearcher(question());
    const outs = mocks.script.outputs.map((o) => JSON.parse(o));
    for (const o of outs) expect(o.success).toBe(false);
    expect(outs[0].message).toMatch(/is not an instance of question aaaaaaaa/);
    expect(outs[1].message).toMatch(/Instance inst-missing not found/);
    expect(outs[2].message).toMatch(/is not in the answer set of question aaaaaaaa/);
    expect(outs[3].message).toMatch(/asks the question matches no answer/);
    expect(mocks.rawInserts.filter((r) => r.table === "claim_instances")).toEqual([]);
  });

  it("records a question's instance on the run's question, attributed to the researcher", async () => {
    mocks.graph.answers = [ANSWER];
    mocks.script.calls = [
      { name: "record_question_instance", input: { ...ASKING } },
      { name: "record_question_instance", input: { ...ASKING, role: "answers", answer_id: ANSWER } },
    ];
    await runResearcher(question());
    const outs = mocks.script.outputs.map((o) => JSON.parse(o));
    expect(outs[0]).toMatchObject({ success: true, instance_id: "qinstance-1" });
    expect(outs[1]).toMatchObject({ success: true, instance_id: "qinstance-1" });
    const rows = mocks.rawInserts.filter((r) => r.table === "claim_instances");
    expect(rows).toHaveLength(2);
    // (claim_id, source_id, verbatim_text, stance, speaker, publication, source_date, created_by)
    expect(rows[0]!.params[0]).toBe(CLAIM);
    expect(rows[0]!.params[3]).toBe("asks");
    expect(rows[1]!.params[3]).toBe("answers");
    for (const row of rows) expect(row.params[7]).toBe("researcher");
  });
});

describe("the budget guide", () => {
  it("states Elicit's per-call price, with no count, when Elicit is in the toolset", async () => {
    const { budgetGuide } = await import("../../../src/llm/prompts/researcher.js");
    const guide = budgetGuide({
      task: "t", requestedBy: "claim_steward", claim: null, budgetUsd: 3, model: "claude-sonnet-5-5",
      estimate: null, maxTurns: 60, elicitUsdPerCall: 2,
      toolNames: ["elicit_search_papers", "report"], sandbox: false, notebook: {},
    });
    expect(guide).toContain("each elicit_ search costs $2.00");
    expect(guide).not.toContain("capped at");
  });

  it("states Pangram's per-call ceiling, with no count, when the Pangram tools are in the toolset", async () => {
    const { budgetGuide } = await import("../../../src/llm/prompts/researcher.js");
    const guide = budgetGuide({
      task: "t", requestedBy: "claim_steward", claim: null, budgetUsd: 3, model: "claude-sonnet-5-5",
      estimate: null, maxTurns: 60, elicitUsdPerCall: 2,
      pangramMaxUsdPerCall: 0.75,
      toolNames: ["pangram_check_ai", "pangram_find_sources", "report"], sandbox: false, notebook: {},
    });
    expect(guide).toContain("each pangram_ analysis is billed per word, up to $0.75 a call");
    expect(guide).not.toContain("capped at");
  });

  it("shows a mandate's research the review budget it submits contributions under", async () => {
    const { buildResearcherTaskMessage } = await import("../../../src/llm/prompts/researcher.js");
    const { contributionBudgetLine } = await import("../../../src/services/contribution-service.js");
    const line = contributionBudgetLine({ budgetMicroUsd: 2_000_000, committedMicroUsd: 500_000, submitted: 2 }, 250_000);
    expect(line).toBe(
      "Contribution reviews: $0.50 of $2.00 committed across 2 submissions, $1.50 left. A review is estimated at " +
        "$0.25 (the average of recent reviews), so about 6 more submissions fit. Reviews not yet run count at the " +
        "estimate until their real cost is known."
    );
    const base = {
      task: "t", requestedBy: "grantmaker", claim: null, budgetUsd: 3, model: "claude-sonnet-5-5",
      estimate: null, maxTurns: 60, elicitMaxCalls: 5, elicitUsdPerCall: 2,
      toolNames: ["report"], sandbox: false, notebook: {},
    };
    expect(buildResearcherTaskMessage({ ...base, contributionBudget: line })).toContain(line);
    expect(buildResearcherTaskMessage({ ...base, contributionBudget: null })).not.toContain("submit_contribution");
  });
});
