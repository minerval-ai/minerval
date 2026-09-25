import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

// The researcher (#298) over scripted loops and a recording DB: the toolset
// follows the model (web search on every tier, the sandbox on Claude only; the
// long-run loop on the strong tier, the ordinary loop elsewhere), the
// constitution is prepended when asked and not otherwise, the Provenance
// skill's researcher view is spliced and its tools offered while
// provenance_write_map is not, the report ends the run, the ceiling and the
// pause flag stop it, and the only tables it writes are its own run, the
// provenance tables, and a fetched source's stored copy.

const mocks = vi.hoisted(() => ({
  writes: [] as Array<{ verb: string; table: string }>,
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
    researcherMaxTurns: 40,
    researcherWebSearchMaxUses: 15,
    researcherElicitMaxCalls: 5,
    leanCheckerUrl: "",
    elicitApiKey: "",
  },
}));

function recordSql(q: string) {
  const m = /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(q);
  if (m) mocks.writes.push({ verb: m[1]!.toUpperCase(), table: m[2]! });
}

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string) => {
    recordSql(q);
    if (/FROM platform_flags/.test(q)) return mocks.paused ? [{ value: true }] : [];
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: () => ({
    insert: (table: unknown) => ({
      values: async () => {
        mocks.writes.push({ verb: "INSERT INTO", table: getTableName(table as never) });
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

vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  elicitConfigured: () => false,
  getElicitToolDefinitions: async () => [],
  executeElicitTool: async () => "{}",
  isElicitTool: (n: string) => n.startsWith("elicit_"),
}));

import { runResearcher } from "../../../src/llm/agents/researcher.js";
import { getConstitution } from "../../../src/llm/prompts/constitution.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";

function input(over: Partial<{ model: string; model_tier: string; include_constitution: boolean; domains: string[]; claim: boolean; ceiling: number }> = {}) {
  return {
    run: {
      id: "run-1",
      claim_id: over.claim === false ? null : CLAIM,
      grant_id: null,
      requested_by: "claim_steward",
      task: "Trace the figure to its origin.",
      model: over.model ?? "claude-sonnet-5",
      model_tier: over.model_tier ?? "standard",
      effort: "high",
      include_constitution: over.include_constitution ?? true,
      ceiling_micro_usd: over.ceiling ?? 2_000_000,
      notebook: {},
    },
    claim: over.claim === false ? null : { id: CLAIM, text: "The claim.", domains: over.domains ?? [] },
  };
}

beforeEach(() => {
  mocks.writes.length = 0;
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
    expect(result.report).toMatchObject({ answer: "done", harness: { model: "claude-sonnet-5" } });
    expect(mocks.longRunCalls).toHaveLength(0);
    expect(mocks.toolLoopCalls).toHaveLength(1);
    const names = (mocks.toolLoopCalls[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("code_execution");
    expect(names).toContain("provenance_get_map");
    expect(names).toContain("provenance_record_edge");
    expect(names).not.toContain("provenance_write_map");
    expect(names).not.toContain("delegate_research");
    expect(names).not.toContain("record_claim_instance");
    expect(names).not.toContain("lean_search");
    expect(names).toContain("read_page");
    expect(names.slice(-3)).toEqual(["report", "web_search", "code_execution"]);
    expect(result.toolNames).toEqual(names);
    const task = (mocks.toolLoopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("Trace the figure to its origin.");
    // The budget in units the model can act on: turns on this model, what a
    // page costs over the run, and what the tools cost beyond tokens.
    expect(task).toMatch(/Budget: \$2\.00 of metered work\. On claude-sonnet-5 that is roughly \d+ turns/);
    expect(task).toMatch(/a page read in full early on costs about \$0\.\d\d by the end of the run/);
    expect(task).toContain("web_search carries a fee");
    expect(task).toContain("read_page has no fee");
    expect(task).toContain("code_execution is billed at $0.05 per container-hour");
    expect(task).toContain("capped at 40 turns");
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
    await runResearcher(input({ model: "z-ai/glm-5.3-flash", model_tier: "cheap" }));
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

  it("names the launcher in the task message", async () => {
    const i = input();
    i.run.requested_by = "grantmaker";
    await runResearcher(i);
    const task = (mocks.toolLoopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(task).toContain("launched by the Grantmaker of a funded mandate");
  });
});

describe("the prompt", () => {
  it("prepends the constitution by default and splices the Provenance skill's researcher view", async () => {
    await runResearcher(input());
    const system = mocks.toolLoopCalls[0]!.system as string[];
    expect(system).toHaveLength(2);
    expect(system[0]).toContain(getConstitution().slice(0, 200));
    expect(system[0]).toContain("# Your Specific Role");
    expect(system[0]).toContain("You are the researcher");
    expect(system[1]!.startsWith("# Method skill: Provenance")).toBe(true);
    expect(system[1]).toContain("## For the researcher");
    expect(system[1]).not.toContain("## For the Claim Steward");
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
      { name: "record_claim_instance", input: {} },
      { name: "provenance_record_reading", input: { claim_id: "bbbbbbbb-0000-4000-8000-000000000002" } },
    ];
    await runResearcher(input());
    expect(JSON.parse(mocks.script.outputs[0]!).message).toMatch(/not in this run's toolset/);
    expect(JSON.parse(mocks.script.outputs[1]!).message).toMatch(/not in this run's toolset/);
    expect(JSON.parse(mocks.script.outputs[2]!).message).toMatch(/provenance tools work on it alone/);
    const tables = new Set(mocks.writes.map((w) => w.table));
    expect(tables.has("claim_source_maps")).toBe(false);
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
