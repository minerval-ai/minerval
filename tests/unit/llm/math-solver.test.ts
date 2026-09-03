import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The solver agent (docs/mathematics.md §7.1, §7.3): the tools it declares
 * at run start, the hooks that stop it at the ceiling and on the kill
 * switches, the wrap-up reminder at 85 percent, the per-turn heartbeat,
 * the Lean caps, the notebook, refusal handling, and the report validator
 * that downgrades an unchecked proof to partial. The long-run loop is
 * replaced by a scripted fake that drives the same hooks in the same order.
 */
type ScriptTurn =
  | {
      tools: Array<{ name: string; input: Record<string, unknown> }>;
      cost?: number;
      servedModel?: string;
      raw?: unknown[];
    }
  | { throw: Error };

const script = vi.hoisted(() => ({
  turns: [] as ScriptTurn[],
  outputs: [] as string[],
  reminders: [] as Array<string | null>,
  options: null as null | Record<string, unknown>,
}));

const svc = vi.hoisted(() => ({
  paused: false,
  status: "running" as string,
  progress: [] as Array<Record<string, unknown>>,
  notebook: {} as Record<string, string>,
  checks: new Map<string, { id: string; verdict: string; kind: string; submission_source: string }>(),
  recorded: [] as Array<Record<string, unknown>>,
  stamped: [] as Array<unknown[]>,
  seq: 0,
  metered: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/llm/client.js", async () => {
  const { getUsageContext } = await import("../../../src/llm/usage-context.js");
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return {
    longRunToolLoop: vi.fn(async (options: any) => {
      script.options = options;
      const messages = [...options.initialMessages];
      let turns = 0;
      let lastResult: any = null;
      const state = () => ({ turn: turns, messages, startedAt: 0, elapsedMs: 0, lastResult, usage });
      for (const t of script.turns) {
        if (options.beforeTurn) {
          const v = await options.beforeTurn(state());
          if (v && v.stop !== undefined) {
            return { result: lastResult, turns, stopReason: "hook", hookStop: v.stop };
          }
        }
        if ("throw" in t) throw t.throw;
        const ctx = getUsageContext();
        if (ctx.meter) ctx.meter.billedMicroUsd += t.cost ?? 0;
        turns++;
        const result = {
          content: "",
          model: "claude-fable-5-1",
          servedModel: t.servedModel ?? "claude-fable-5-1",
          usage,
          stopReason: t.tools.length > 0 ? "tool_use" : "end_turn",
          toolUses: t.tools.map((u, i) => ({ id: `t${turns}-${i}`, name: u.name, input: u.input })),
          rawContent: (t.raw ?? []) as Anthropic.ContentBlock[],
        };
        lastResult = result;
        if (t.tools.length === 0) {
          await options.afterTurn?.(state(), result);
          return { result, turns, stopReason: "end_turn" };
        }
        for (const tu of result.toolUses) {
          const final = options.onFinalTool?.(tu.name, tu.input);
          if (final !== null && final !== undefined) {
            await options.afterTurn?.(state(), result);
            return { result, turns, stopReason: "final_tool" };
          }
        }
        for (const tu of result.toolUses) {
          script.outputs.push(await options.executeTool(tu.name, tu.input));
        }
        script.reminders.push(options.reminder ? options.reminder(state()) : null);
        await options.afterTurn?.(state(), result);
      }
      return { result: lastResult, turns, stopReason: "max_iterations" };
    }),
  };
});

vi.mock("../../../src/services/attempt-service.js", () => ({
  NOTEBOOK_MAX_SECTION_CHARS: 40_000,
  NOTEBOOK_MAX_SECTIONS: 200,
  stampAttemptRun: vi.fn(async (...args: unknown[]) => {
    svc.stamped.push(args);
  }),
  updateAttemptProgress: vi.fn(async (input: Record<string, unknown>) => {
    svc.progress.push(input);
  }),
  readAttemptStatus: vi.fn(async () => svc.status),
  readSolverPaused: vi.fn(async () => svc.paused),
  readNotebook: vi.fn(async () => ({ ...svc.notebook })),
  writeNotebookSection: vi.fn(async (_id: string, section: string, content: string) => {
    svc.notebook[section] = content;
    return { ...svc.notebook };
  }),
  findStoredAttemptCheck: vi.fn(async () => null),
  findAttemptLeanCheck: vi.fn(async (_attemptId: string, id: string) => svc.checks.get(id) ?? null),
  recordAttemptLeanCheck: vi.fn(async (input: Record<string, unknown>) => {
    svc.recorded.push(input);
    const id = `chk-${++svc.seq}`;
    const row = {
      id,
      verdict: input.verdict as string,
      kind: input.kind as string,
      submission_source: input.submissionSource as string,
    };
    svc.checks.set(id, row);
    return row;
  }),
}));

vi.mock("../../../src/services/usage-service.js", async () => {
  const { getUsageContext } = await import("../../../src/llm/usage-context.js");
  return {
    meterExternalUsage: vi.fn(async (usage: Record<string, unknown>) => {
      svc.metered.push(usage);
      const ctx = getUsageContext();
      if (ctx.meter) ctx.meter.billedMicroUsd += Math.round(Number(usage.costMicroUsd));
    }),
  };
});

vi.mock("../../../src/services/trace-service.js", () => ({
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
  recordAgentStep: vi.fn(),
  recordAgentRunSkills: vi.fn(),
}));

const config = vi.hoisted(() => ({
  env: "test",
  solverModel: "claude-fable-5-1",
  solverLeanMaxChecks: 60,
  solverLeanMaxElaborations: 200,
  attemptMaxIterations: 500,
  attemptMaxWallHours: 6,
  attemptOverageFraction: 0.25,
  leanCpuHourCostMicroUsd: 200_000,
  leanCheckOverheadMicroUsd: 20_000,
  traceAlwaysAgents: [] as string[],
  traceLevel: "off",
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => config }));

import {
  CODE_EXECUTION_TOOL,
  REPORT_TOOL,
  SOLVER_STOP_CANCELLED,
  SOLVER_STOP_CEILING,
  SOLVER_STOP_PAUSED,
  SOLVER_TASK_BUDGET_TOKENS,
  WRAP_UP_NOTICE,
  runMathSolver,
  validateSolverReport,
} from "../../../src/llm/agents/math-solver.js";
import { LlmRefusalError } from "../../../src/llm/errors.js";
import { getUsageContext, runWithUsageContext, withCostMeter } from "../../../src/llm/usage-context.js";
import { FakeLeanCheckerClient } from "../../../src/services/lean-checker-fake.js";
import type { FormalizationRow } from "../../../src/services/attempt-service.js";

const formalization: FormalizationRow = {
  id: "f1f1f1f1-0000-4000-8000-000000000001",
  claim_id: "c1c1c1c1-0000-4000-8000-000000000001",
  version: 1,
  status: "published",
  pin_id: "mathlib-v4.33.0",
  lean_toolchain: "leanprover/lean4:v4.33.0",
  mathlib_rev: "0".repeat(40),
  mathlib_tag: "v4.33.0",
  image_digest: "sha256:fake",
  namespace: "Minerval.S0a1b2c3d_v1",
  statement_source:
    "import Mathlib\nnamespace Minerval.S0a1b2c3d_v1\ndef Statement : Prop := True\nend Minerval.S0a1b2c3d_v1",
  source_hash: "src",
  expr_hash: "expr",
  pp_type: "True",
  correspondence: "exact",
  published_at: new Date("2026-08-01T00:00:00Z"),
  review_period_ends_at: null,
};

const attempt = {
  id: "a1a1a1a1-0000-4000-8000-000000000001",
  claim_id: formalization.claim_id,
  formalization_id: formalization.id,
  action_id: "ac1",
  variant: "max" as const,
  effort: "max",
  model: "claude-fable-5-1",
  is_calibration: false,
};

const CEILING = 10_000_000;

function run(opts: { checker?: FakeLeanCheckerClient | null; ceiling?: number } = {}) {
  const checker = opts.checker === undefined ? new FakeLeanCheckerClient() : opts.checker;
  return withCostMeter(() =>
    runWithUsageContext({ jobId: "job-1", claimId: attempt.claim_id }, () =>
      runMathSolver({
        attempt,
        claim: { id: attempt.claim_id, text: "True holds." },
        formalization,
        variant: "max",
        effort: "max",
        ceilingMicroUsd: opts.ceiling ?? CEILING,
        checker,
        now: () => 0,
      })
    )
  );
}

const report = (over: Record<string, unknown> = {}) => ({
  name: "report",
  input: {
    outcome: "negative",
    lean_proof: null,
    lean_check_id: null,
    informal_argument: "nothing worked",
    reduction_statement: null,
    counterexample: null,
    approaches_tried: ["a"],
    obstruction: "b",
    what_would_help: "c",
    confidence: 0.2,
    ...over,
  },
});

beforeEach(() => {
  script.turns = [];
  script.outputs = [];
  script.reminders = [];
  script.options = null;
  svc.paused = false;
  svc.status = "running";
  svc.progress = [];
  svc.notebook = {};
  svc.checks.clear();
  svc.recorded = [];
  svc.stamped = [];
  svc.seq = 0;
  svc.metered = [];
  config.solverLeanMaxChecks = 60;
  config.solverLeanMaxElaborations = 200;
});

describe("runMathSolver: the run shape", () => {
  it("declares the fixed toolset, the effort, the task budget, and fallbacks off, on the two cached blocks", async () => {
    script.turns = [{ tools: [report()] }];
    const { value } = await run();
    expect(value.status).toBe("completed");
    const o = script.options!;
    expect((o.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "code_execution",
      "notebook_write",
      "notebook_read",
      "report",
    ]);
    expect((o.tools as unknown[])[3]).toBe(CODE_EXECUTION_TOOL);
    expect((o.tools as unknown[])[6]).toBe(REPORT_TOOL);
    expect(o.fallbacks).toBe("none");
    expect(o.effort).toBe("max");
    expect(o.taskBudgetTokens).toBe(SOLVER_TASK_BUDGET_TOKENS.max);
    expect(o.model).toBe("claude-fable-5-1");
    expect(o.maxIterations).toBe(500);
    expect(o.maxWallMs).toBe(6 * 3_600_000);
    const system = o.system as string[];
    expect(system).toHaveLength(2);
    expect(system[0]).toContain("## For the solver");
    expect(system[1]).toMatch(/^# Harness/);
    const initial = o.initialMessages as Array<{ role: string; content: string }>;
    expect(initial[0]!.content).toContain(formalization.statement_source);
    // lean_check is bound to the statement: no formalization_id in its schema.
    const leanCheck = (o.tools as Array<{ name: string; input_schema: { properties: Record<string, unknown>; required: string[] } }>)[2]!;
    expect(Object.keys(leanCheck.input_schema.properties)).toEqual(["kind", "proof", "replay", "force"]);
    expect(leanCheck.input_schema.required).toEqual(["kind", "proof"]);
  });

  it("runs under the math_solver agent and stamps the run on the attempt", async () => {
    let agent: string | undefined;
    script.turns = [{ tools: [report()] }];
    const { longRunToolLoop } = await import("../../../src/llm/client.js");
    (longRunToolLoop as unknown as { mockImplementationOnce: (f: any) => void }).mockImplementationOnce(
      async () => {
        agent = getUsageContext().agent;
        return { result: null, turns: 0, stopReason: "end_turn" };
      }
    );
    await run();
    expect(agent).toBe("math_solver");
    expect(svc.stamped).toEqual([[attempt.id, null]]);
  });

  it("omits the Lean tools and says so in the task when no checker is configured", async () => {
    script.turns = [{ tools: [report()] }];
    await run({ checker: null });
    const o = script.options!;
    expect((o.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "code_execution",
      "notebook_write",
      "notebook_read",
      "report",
    ]);
    const initial = o.initialMessages as Array<{ content: string }>;
    expect(initial[0]!.content).toContain("no checker is configured");
  });
});

describe("runMathSolver: hooks", () => {
  it("stops at the dollar ceiling read from the meter, with the wrap-up notice at 85 percent", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }], cost: 0.6 * CEILING },
      { tools: [{ name: "notebook_read", input: {} }], cost: 0.6 * CEILING },
      { tools: [report()] },
    ];
    const { value, billedMicroUsd } = await run();
    expect(value.status).toBe("budget");
    expect(value.stopReason).toBe("hook");
    expect(value.hookStop).toBe(SOLVER_STOP_CEILING);
    expect(value.turns).toBe(2);
    expect(value.report).toBeNull();
    expect(billedMicroUsd).toBe(1.2 * CEILING);
    // No reminder after turn 1 (60%), the notice after turn 2 (120%), once.
    expect(script.reminders).toEqual([null, WRAP_UP_NOTICE]);
  });

  it("sends the reminder once and then stays quiet", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }], cost: 0.9 * CEILING },
      { tools: [{ name: "notebook_read", input: {} }], cost: 0.05 * CEILING },
      { tools: [report()] },
    ];
    const { value } = await run();
    expect(value.status).toBe("completed");
    expect(script.reminders).toEqual([WRAP_UP_NOTICE, null]);
  });

  it("stops when the operator pauses the solver", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }] },
      { tools: [report()] },
    ];
    const { readSolverPaused } = await import("../../../src/services/attempt-service.js");
    (readSolverPaused as unknown as { mockImplementation: (f: any) => void }).mockImplementation(
      async () => svc.progress.length >= 1
    );
    const { value } = await run();
    expect(value.status).toBe("cancelled");
    expect(value.hookStop).toBe(SOLVER_STOP_PAUSED);
    expect(value.turns).toBe(1);
    expect(value.error).toMatch(/paused/);
    (readSolverPaused as unknown as { mockImplementation: (f: any) => void }).mockImplementation(
      async () => svc.paused
    );
  });

  it("stops when the attempt row is set to cancelling", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }] },
      { tools: [report()] },
    ];
    const { readAttemptStatus } = await import("../../../src/services/attempt-service.js");
    (readAttemptStatus as unknown as { mockImplementation: (f: any) => void }).mockImplementation(
      async () => (svc.progress.length >= 1 ? "cancelling" : "running")
    );
    const { value } = await run();
    expect(value.status).toBe("cancelled");
    expect(value.hookStop).toBe(SOLVER_STOP_CANCELLED);
    (readAttemptStatus as unknown as { mockImplementation: (f: any) => void }).mockImplementation(
      async () => svc.status
    );
  });

  it("updates the heartbeat, turns, spend, and served models after every turn", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }], cost: 1_000, servedModel: "claude-fable-5-1-20260901" },
      { tools: [report()], cost: 500, servedModel: "claude-fable-5-1-20260901" },
    ];
    const { value } = await run();
    expect(svc.progress).toEqual([
      {
        attemptId: attempt.id,
        actionId: "ac1",
        turns: 1,
        spentMicroUsd: 1_000,
        servedModels: ["claude-fable-5-1-20260901"],
      },
      {
        attemptId: attempt.id,
        actionId: "ac1",
        turns: 2,
        spentMicroUsd: 1_500,
        servedModels: ["claude-fable-5-1-20260901"],
      },
    ]);
    expect(value.servedModels).toEqual(["claude-fable-5-1-20260901"]);
    expect(value.turns).toBe(2);
  });

  it("meters container time for a turn that used code execution", async () => {
    let clock = 0;
    script.turns = [
      {
        tools: [{ name: "notebook_read", input: {} }],
        raw: [{ type: "server_tool_use", id: "s1", name: "code_execution", input: {} }],
      },
      { tools: [report()] },
    ];
    await withCostMeter(() =>
      runMathSolver({
        attempt,
        claim: { id: attempt.claim_id, text: "t" },
        formalization,
        variant: "standard",
        effort: "high",
        ceilingMicroUsd: CEILING,
        checker: new FakeLeanCheckerClient(),
        now: () => (clock += 3_600_000),
      })
    );
    const container = svc.metered.filter((m) => m.provider === "anthropic_code_execution");
    expect(container).toHaveLength(1);
    expect(container[0]).toMatchObject({ unitKind: "container_seconds", units: 3600 });
    expect(container[0]!.costMicroUsd).toBeCloseTo(50_000, 0);
  });

  it("records a refusal as refused rather than continuing on another model", async () => {
    script.turns = [
      { tools: [{ name: "notebook_read", input: {} }], cost: 100 },
      { throw: new LlmRefusalError("claude-fable-5-1", "harmful") },
    ];
    const { value, billedMicroUsd } = await run();
    expect(value.status).toBe("refused");
    expect(value.stopReason).toBe("refusal");
    expect(value.error).toMatch(/refused/);
    expect(billedMicroUsd).toBe(100);
  });

  it("propagates other errors to the worker", async () => {
    script.turns = [{ throw: new Error("overloaded") }];
    await expect(run()).rejects.toThrow(/overloaded/);
  });
});

describe("runMathSolver: tools", () => {
  it("writes the notebook through the service and reads it back", async () => {
    script.turns = [
      { tools: [{ name: "notebook_write", input: { section: "plan", content: "induct" } }] },
      { tools: [{ name: "notebook_read", input: {} }] },
      { tools: [report()] },
    ];
    await run();
    expect(JSON.parse(script.outputs[0]!)).toEqual({ success: true, section: "plan", sections: ["plan"] });
    expect(JSON.parse(script.outputs[1]!)).toEqual({ success: true, notebook: { plan: "induct" } });
    expect(svc.notebook).toEqual({ plan: "induct" });
  });

  it("checks a proof against the fixed statement in attempt mode, records the row, and meters the call", async () => {
    const checker = new FakeLeanCheckerClient();
    checker.scriptDefault({ verdict: "accepted", wall_ms: 36_000 });
    script.turns = [
      { tools: [{ name: "lean_check", input: { kind: "proof", proof: "theorem proof : Statement := trivial" } }] },
      { tools: [report()] },
    ];
    await run({ checker });
    const out = JSON.parse(script.outputs[0]!);
    expect(out).toMatchObject({ success: true, lean_check_id: "chk-1", verdict: "accepted" });
    expect(checker.submissions[0]).toMatchObject({
      mode: "attempt",
      kind: "proof",
      statement_source: formalization.statement_source,
      submission_source: "theorem proof : Statement := trivial",
    });
    expect(svc.recorded[0]).toMatchObject({
      attemptId: attempt.id,
      formalizationId: formalization.id,
      kind: "proof",
      verdict: "accepted",
      submissionSource: "theorem proof : Statement := trivial",
      costMicroUsd: 22_000,
    });
    expect(svc.metered[0]).toMatchObject({
      provider: "lean",
      model: "lean-checker/mathlib-v4.33.0",
      unitKind: "wall_ms",
      units: 36_000,
      costMicroUsd: 22_000,
    });
  });

  it("refuses checks and elaborations past the per-attempt caps", async () => {
    config.solverLeanMaxChecks = 1;
    config.solverLeanMaxElaborations = 1;
    script.turns = [
      {
        tools: [
          { name: "lean_check", input: { kind: "proof", proof: "p1" } },
          { name: "lean_check", input: { kind: "proof", proof: "p2" } },
          { name: "lean_elaborate", input: { statement: "example : True := trivial" } },
          { name: "lean_elaborate", input: { statement: "example : True := trivial" } },
        ],
      },
      { tools: [report()] },
    ];
    await run();
    expect(JSON.parse(script.outputs[0]!).success).toBe(true);
    expect(JSON.parse(script.outputs[1]!)).toMatchObject({ success: false });
    expect(JSON.parse(script.outputs[1]!).message).toMatch(/1 of its 1 proof checks/);
    expect(JSON.parse(script.outputs[2]!)).toMatchObject({ success: true, ok: true });
    expect(JSON.parse(script.outputs[3]!).message).toMatch(/cap \(1\)/);
  });

  it("answers a checker outage as a structured result, never a thrown error", async () => {
    const checker = new FakeLeanCheckerClient();
    checker.submitCheck = async () => {
      throw new Error("checker unreachable");
    };
    script.turns = [
      { tools: [{ name: "lean_check", input: { kind: "proof", proof: "p" } }] },
      { tools: [report()] },
    ];
    const { value } = await run({ checker });
    expect(value.status).toBe("completed");
    expect(JSON.parse(script.outputs[0]!)).toMatchObject({ success: false });
    expect(JSON.parse(script.outputs[0]!).message).toMatch(/lean_check failed \(checker unreachable\)/);
  });
});

describe("runMathSolver: the report", () => {
  it("downgrades a proof without an accepted check from this attempt to partial and records why", async () => {
    script.turns = [{ tools: [report({ outcome: "proof", lean_check_id: "chk-nope", lean_proof: "x" })] }];
    const { value } = await run();
    expect(value.status).toBe("completed");
    expect(value.outcome).toBe("partial");
    expect(value.leanCheckId).toBeNull();
    expect(value.leanProof).toBeNull();
    expect(value.report).toMatchObject({
      outcome: "partial",
      lean_check_id: null,
      validation: {
        downgraded_from: "proof",
        claimed_lean_check_id: "chk-nope",
        reason: "lean_check_id chk-nope names no check this attempt wrote",
      },
      harness: { stop_reason: "final_tool", turns: 1 },
    });
  });

  it("keeps a proof whose accepted check this attempt wrote, taking the source from the row", async () => {
    script.turns = [
      { tools: [{ name: "lean_check", input: { kind: "proof", proof: "theorem proof : Statement := trivial" } }] },
      { tools: [report({ outcome: "proof", lean_check_id: "chk-1", lean_proof: null })] },
    ];
    const { value } = await run();
    expect(value.status).toBe("completed");
    expect(value.outcome).toBe("proof");
    expect(value.leanCheckId).toBe("chk-1");
    expect(value.leanProof).toBe("theorem proof : Statement := trivial");
    expect(value.report!.validation).toBeUndefined();
  });

  it("downgrades a disproof backed by a rejected check", async () => {
    const checker = new FakeLeanCheckerClient();
    checker.scriptDefault({ verdict: "rejected", failed_gate: "compile" });
    script.turns = [
      { tools: [{ name: "lean_check", input: { kind: "disproof", proof: "bad" } }] },
      { tools: [report({ outcome: "disproof", lean_check_id: "chk-1" })] },
    ];
    const { value } = await run({ checker });
    expect(value.outcome).toBe("partial");
    expect((value.report!.validation as Record<string, unknown>).reason).toBe(
      "check chk-1 has verdict rejected"
    );
  });

  it("records a run that ends without a report as completed with outcome none", async () => {
    script.turns = [{ tools: [] }];
    const { value } = await run();
    expect(value.status).toBe("completed");
    expect(value.outcome).toBe("none");
    expect(value.stopReason).toBe("end_turn");
    expect(value.error).toMatch(/without calling report/);
  });
});

describe("validateSolverReport", () => {
  const accepted = async (id: string) =>
    id === "ok" ? { id, verdict: "accepted", kind: "proof", submissionSource: "src" } : null;

  it("normalizes fields and clamps confidence", async () => {
    const v = await validateSolverReport(
      { outcome: "negative", confidence: 7, approaches_tried: [1, "two"], obstruction: null },
      accepted
    );
    expect(v.outcome).toBe("negative");
    expect(v.report).toMatchObject({
      outcome: "negative",
      confidence: 1,
      approaches_tried: ["1", "two"],
      obstruction: "",
      lean_proof: null,
      counterexample: null,
    });
    expect(v.report.validation).toBeUndefined();
  });

  it("treats an unknown outcome as partial", async () => {
    const v = await validateSolverReport({ outcome: "solved!" }, accepted);
    expect(v.outcome).toBe("partial");
    expect(v.report.validation).toEqual({ invalid_outcome: "solved!" });
  });

  it("downgrades a disproof whose check is a proof", async () => {
    const v = await validateSolverReport({ outcome: "disproof", lean_check_id: "ok" }, accepted);
    expect(v.outcome).toBe("partial");
    expect(v.report.validation).toMatchObject({
      downgraded_from: "disproof",
      reason: "check ok is a proof, not a disproof",
    });
  });

  it("accepts a proof with a matching accepted check", async () => {
    const v = await validateSolverReport({ outcome: "proof", lean_check_id: "ok" }, accepted);
    expect(v).toMatchObject({ outcome: "proof", leanCheckId: "ok", leanProof: "src" });
  });
});
