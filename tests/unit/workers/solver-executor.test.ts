import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The solver executor's control flow (docs/mathematics.md §7.9): the kill
 * switch, the breaker, the ledger's next covered attempt_proof action, the
 * refusals that release the action with a note, the run under the funding
 * job's usage context, the close with the metered amount, the stale
 * formalization check at report time, the transient-failure paths before
 * and after spend, and the direct Steward invocation on attempt_completed.
 */
const state = vi.hoisted(() => ({
  config: { solverEnabled: true, solverModel: "claude-fable-5-1" },
  budgetError: null as null | Error,
  calibrationBudgetError: null as null | Error,
  action: null as null | Record<string, unknown>,
  claim: { id: "c1c1c1c1-0000-4000-8000-000000000001", text: "n + 0 = n", state: "active" } as
    | Record<string, unknown>
    | null,
  formalizations: {} as Record<string, Record<string, unknown> | null>,
  formalizationReads: 0,
  freshFormalization: null as null | Record<string, unknown>,
  funder: { jobId: "job-1", grantId: "g1" } as Record<string, unknown>,
  planItem: null as null | Record<string, unknown>,
  openResult: null as null | Record<string, unknown>,
  solverResult: null as null | Record<string, unknown>,
  solverThrows: null as null | Error,
  solverCost: 0,
  closed: [] as Array<{ id: string; input: Record<string, unknown> }>,
  closeReturn: null as null | Record<string, unknown>,
  released: [] as string[],
  completed: [] as Array<{ id: string; metered: number; opts: unknown }>,
  claimed: [] as string[],
  published: [] as string[],
  stewardCalls: [] as Array<Record<string, unknown>>,
  stewardThrows: null as null | Error,
  solverContexts: [] as Array<Record<string, unknown>>,
  sweeps: 0,
  orphans: [] as string[],
}));

vi.mock("../../../src/config.js", () => ({ loadConfig: () => state.config }));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (/FROM claims WHERE id = \$1/.test(q)) return state.claim ? [state.claim] : [];
    if (/spent_micro_usd::bigint AS spent FROM proof_attempts/.test(q)) return [{ spent: state.solverCost }];
    void params;
    return [];
  }),
  closeDb: vi.fn(),
}));
vi.mock("../../../src/llm/solver-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/llm/solver-budget.js")>();
  return {
    ...actual,
    checkSolverBudget: vi.fn(async (opts?: { calibration?: boolean }) => {
      if (opts?.calibration && state.calibrationBudgetError) throw state.calibrationBudgetError;
      if (!opts?.calibration && state.budgetError) throw state.budgetError;
    }),
  };
});
vi.mock("../../../src/services/action-service.js", () => ({
  nextRunnableAction: vi.fn(async () => state.action),
  claimAction: vi.fn(async (id: string) => {
    state.claimed.push(id);
    return true;
  }),
  releaseAction: vi.fn(async (id: string) => {
    state.released.push(id);
  }),
  completeAction: vi.fn(async (id: string, metered: number, opts: unknown) => {
    state.completed.push({ id, metered, opts });
    return metered;
  }),
  largestActionFunder: vi.fn(async () => state.funder),
}));
vi.mock("../../../src/services/attempt-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/services/attempt-service.js")>();
  return {
    ...actual,
    getFormalization: vi.fn(async (id: string) => {
      state.formalizationReads++;
      if (state.formalizationReads > 1 && state.freshFormalization !== null) return state.freshFormalization;
      return state.formalizations[id] ?? null;
    }),
    getPublishedFormalization: vi.fn(async () => null),
    findAttemptPlanItem: vi.fn(async () => state.planItem),
    listPriorAttempts: vi.fn(async () => []),
    openAttempt: vi.fn(async () => state.openResult),
    closeAttempt: vi.fn(async (id: string, input: Record<string, unknown>) => {
      state.closed.push({ id, input });
      return (
        state.closeReturn ?? {
          attempt: { ...(state.openResult as { attempt: Record<string, unknown> }).attempt, ...input, spent_micro_usd: input.spentMicroUsd ?? 0, turns: input.turns ?? 0 },
          bountyMoved: null,
        }
      );
    }),
    publishAttempt: vi.fn(async (id: string) => {
      state.published.push(id);
      return true;
    }),
    sweepOrphanedAttempts: vi.fn(async () => {
      state.sweeps++;
      return state.orphans;
    }),
  };
});
vi.mock("../../../src/llm/agents/math-solver.js", async () => {
  const { getUsageContext } = await import("../../../src/llm/usage-context.js");
  return {
    runMathSolver: vi.fn(async () => {
      const ctx = getUsageContext();
      state.solverContexts.push({ jobId: ctx.jobId, userId: ctx.userId, claimId: ctx.claimId });
      if (ctx.meter) ctx.meter.billedMicroUsd += state.solverCost;
      if (state.solverThrows) throw state.solverThrows;
      return state.solverResult;
    }),
  };
});
vi.mock("../../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    state.stewardCalls.push(input);
    if (state.stewardThrows) throw state.stewardThrows;
    return { model: "strong", billedMicroUsd: 0 };
  }),
}));
vi.mock("../../../src/llm/tools/skill-tools.js", () => ({ assertSkillToolsRegistered: vi.fn() }));

import { LlmBudgetExceededError } from "../../../src/llm/errors.js";
import {
  processNextSolverAction,
  runSolverWorker,
  stewardContextLine,
} from "../../../src/workers/solver-executor.js";

const FORM_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const CLAIM_ID = "c1c1c1c1-0000-4000-8000-000000000001";
const ATTEMPT_ID = "a1a1a1a1-0000-4000-8000-000000000001";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function formalization(over: Record<string, unknown> = {}) {
  return {
    id: FORM_ID,
    claim_id: CLAIM_ID,
    version: 1,
    status: "published",
    statement_source: "def Statement : Prop := True",
    source_hash: "src-1",
    expr_hash: "e",
    pin_id: "p",
    lean_toolchain: "t",
    mathlib_rev: "r",
    mathlib_tag: null,
    image_digest: "d",
    namespace: "N",
    pp_type: "True",
    correspondence: null,
    published_at: new Date(),
    review_period_ends_at: null,
    ...over,
  };
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    claim_id: CLAIM_ID,
    formalization_id: FORM_ID,
    action_id: "ac1",
    run_id: null,
    grant_id: "g1",
    job_id: "job-1",
    model: "claude-fable-5-1",
    variant: "max",
    effort: "max",
    status: "running",
    outcome: null,
    report: null,
    lean_proof: null,
    lean_check_id: null,
    notebook: {},
    is_calibration: false,
    ceiling_micro_usd: 187_500_000,
    spent_micro_usd: 0,
    turns: 0,
    compactions: 0,
    served_models: null,
    published_at: null,
    started_at: new Date(),
    heartbeat_at: null,
    finished_at: null,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  state.config = { solverEnabled: true, solverModel: "claude-fable-5-1" };
  state.budgetError = null;
  state.calibrationBudgetError = null;
  state.action = {
    id: "ac1",
    kind: "attempt_proof",
    exclusion_group: `attempt:${FORM_ID}:1`,
    variant: "max",
    claim_id: CLAIM_ID,
    target_ref: null,
    cost_est_micro_usd: 150_000_000,
    coverage_micro_usd: 150_000_000,
    updated_at: new Date(),
  };
  state.claim = { id: CLAIM_ID, text: "n + 0 = n", state: "active" };
  state.formalizations = { [FORM_ID]: formalization() };
  state.formalizationReads = 0;
  state.freshFormalization = null;
  state.funder = { jobId: "job-1", grantId: "g1" };
  state.planItem = null;
  state.openResult = { ok: true, attempt: attempt(), costEstMicroUsd: 150_000_000 };
  state.solverResult = {
    status: "completed",
    outcome: "negative",
    report: { outcome: "negative" },
    leanProof: null,
    leanCheckId: null,
    turns: 12,
    stopReason: "final_tool",
    servedModels: ["claude-fable-5-1"],
    error: null,
  };
  state.solverThrows = null;
  state.solverCost = 42_000_000;
  state.closed = [];
  state.closeReturn = null;
  state.released = [];
  state.completed = [];
  state.claimed = [];
  state.published = [];
  state.stewardCalls = [];
  state.stewardThrows = null;
  state.solverContexts = [];
  state.sweeps = 0;
  state.orphans = [];
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("processNextSolverAction", () => {
  it("does nothing when SOLVER_ENABLED is false", async () => {
    state.config.solverEnabled = false;
    expect(await processNextSolverAction({ logger })).toEqual({ status: "disabled" });
    expect(state.claimed).toEqual([]);
  });

  it("rests on the daily cap before claiming anything", async () => {
    state.budgetError = new LlmBudgetExceededError("solver_daily_cap_micro_usd", 5, 4);
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("budget");
    expect(state.claimed).toEqual([]);
  });

  it("reports an empty ledger, after sweeping a dead worker's attempts to orphaned", async () => {
    state.action = null;
    state.orphans = ["dead-1"];
    expect(await processNextSolverAction({ logger })).toEqual({ status: "empty" });
    expect(state.sweeps).toBe(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/attempt dead-1 had no heartbeat; marked orphaned/);
  });

  it("releases the action with a note when the formalization is not published", async () => {
    state.formalizations[FORM_ID] = formalization({ status: "retired" });
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("skipped");
    expect(state.released).toEqual(["ac1"]);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/is retired, not published/);
    expect(state.solverContexts).toEqual([]);
  });

  it("releases the action when the attempt cannot open (lifetime cap)", async () => {
    state.openResult = { ok: false, code: "LIFETIME_CAP", message: "over" };
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("skipped");
    expect(state.released).toEqual(["ac1"]);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/LIFETIME_CAP: over/);
  });

  it("applies the calibration cap to a calibration plan item", async () => {
    state.planItem = { action: "attempt_proof", claim_id: CLAIM_ID, rationale: "r", is_calibration: true };
    state.calibrationBudgetError = new LlmBudgetExceededError("solver_calibration_daily_cap_micro_usd", 2, 1);
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("budget");
    expect(state.released).toEqual(["ac1"]);
  });

  it("runs the attempt under the funding job, closes it, completes the action with the metered amount, tells the Steward, and publishes", async () => {
    const r = await processNextSolverAction({ logger });
    expect(r).toMatchObject({
      status: "processed",
      actionId: "ac1",
      attemptId: ATTEMPT_ID,
      claimId: CLAIM_ID,
      attemptStatus: "completed",
      outcome: "negative",
      billedMicroUsd: 42_000_000,
      ok: true,
    });
    expect(state.claimed).toEqual(["ac1"]);
    expect(state.solverContexts).toEqual([{ jobId: "job-1", userId: undefined, claimId: CLAIM_ID }]);
    expect(state.closed).toEqual([
      {
        id: ATTEMPT_ID,
        input: {
          status: "completed",
          outcome: "negative",
          report: { outcome: "negative" },
          leanProof: null,
          leanCheckId: null,
          error: null,
          spentMicroUsd: 42_000_000,
          turns: 12,
          servedModels: ["claude-fable-5-1"],
        },
      },
    ]);
    expect(state.completed).toEqual([{ id: "ac1", metered: 42_000_000, opts: { meteredJobId: "job-1" } }]);
    expect(state.stewardCalls).toHaveLength(1);
    expect(state.stewardCalls[0]).toMatchObject({ trigger: "attempt_completed", claimId: CLAIM_ID, jobId: "job-1" });
    expect(String(state.stewardCalls[0]!.context)).toMatch(new RegExp(`proof attempt ${ATTEMPT_ID} closed as completed`));
    expect(state.published).toEqual([ATTEMPT_ID]);
    expect(state.released).toEqual([]);
  });

  it("passes an accepted check through to the close so the bounty can move", async () => {
    state.solverResult = { ...state.solverResult!, outcome: "proof", leanCheckId: "chk-1", leanProof: "p" };
    state.closeReturn = { attempt: attempt({ status: "completed", outcome: "proof", lean_check_id: "chk-1" }), bountyMoved: "b1" };
    const r = await processNextSolverAction({ logger });
    expect(r.ok).toBe(true);
    expect(state.closed[0]!.input).toMatchObject({ status: "completed", leanCheckId: "chk-1", leanProof: "p" });
    expect(logger.info.mock.calls.some((c) => /bounty b1 is house_result_pending/.test(String(c[0])))).toBe(true);
  });

  it("marks the attempt stale_formalization when the statement changed under it, and never moves a bounty", async () => {
    state.solverResult = { ...state.solverResult!, outcome: "proof", leanCheckId: "chk-1" };
    state.freshFormalization = formalization({ source_hash: "src-2" });
    const r = await processNextSolverAction({ logger });
    expect(r.attemptStatus).toBe("stale_formalization");
    expect(state.closed[0]!.input).toMatchObject({
      status: "stale_formalization",
      outcome: "proof",
      leanCheckId: null,
    });
    expect(String(state.closed[0]!.input.error)).toMatch(/changed during the attempt/);
    expect(state.completed[0]!.metered).toBe(42_000_000);
    expect(state.stewardCalls).toHaveLength(1);
  });

  it("releases the action and records a failed attempt on a transient error before any spend", async () => {
    state.solverCost = 0;
    state.solverThrows = Object.assign(new Error("overloaded"), { status: 529 });
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("transient");
    expect(r.ok).toBe(false);
    expect(state.released).toEqual(["ac1"]);
    expect(state.completed).toEqual([]);
    expect(state.closed[0]!.input).toMatchObject({ status: "failed", error: "overloaded", spentMicroUsd: 0 });
    expect(state.stewardCalls).toEqual([]);
    expect(state.published).toEqual([]);
  });

  it("completes the action with the metered amount and records failed on a transient error after spend", async () => {
    state.solverThrows = Object.assign(new Error("rate limit"), { status: 429 });
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("transient");
    expect(state.released).toEqual([]);
    expect(state.completed).toEqual([{ id: "ac1", metered: 42_000_000, opts: { meteredJobId: "job-1" } }]);
    expect(state.closed[0]!.input).toMatchObject({ status: "failed", error: "rate limit", spentMicroUsd: 42_000_000 });
    expect(state.stewardCalls).toHaveLength(1);
  });

  it("records budget when the solver breaker trips mid-run", async () => {
    state.solverThrows = new LlmBudgetExceededError("solver_daily_cap_micro_usd", 5, 4);
    const r = await processNextSolverAction({ logger });
    expect(r.status).toBe("budget");
    expect(state.closed[0]!.input).toMatchObject({ status: "budget", spentMicroUsd: 42_000_000 });
    expect(state.completed[0]!.metered).toBe(42_000_000);
  });

  it("records a refusal as refused and still tells the Steward", async () => {
    state.solverResult = { ...state.solverResult!, status: "refused", outcome: null, report: null, error: "refused" };
    const r = await processNextSolverAction({ logger });
    expect(r.attemptStatus).toBe("refused");
    expect(state.closed[0]!.input).toMatchObject({ status: "refused", outcome: null });
    expect(state.stewardCalls).toHaveLength(1);
    expect(String(state.stewardCalls[0]!.context)).toMatch(/the model refused the attempt/);
  });

  it("keeps the attempt unpublished when the Steward's run fails", async () => {
    state.stewardThrows = new Error("steward down");
    const r = await processNextSolverAction({ logger });
    expect(r.error).toBe("steward: steward down");
    expect(state.published).toEqual([]);
    expect(state.completed).toHaveLength(1);
  });
});

describe("runSolverWorker", () => {
  it("exits the loop when SOLVER_ENABLED is false", async () => {
    state.config.solverEnabled = false;
    const sleep = vi.fn(async () => {});
    const { ticks } = await runSolverWorker({ logger, sleep, maxTicks: 10 });
    expect(ticks).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rests after the breaker's run of consecutive transient failures", async () => {
    state.solverCost = 0;
    state.solverThrows = Object.assign(new Error("overloaded"), { status: 529 });
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    await runSolverWorker({ logger, sleep, idleMs: 1, restMs: 99, maxTicks: 5 });
    expect(sleeps).toEqual([1, 1, 1, 1, 99]);
    expect(logger.error.mock.calls.some((c) => /5 consecutive transient failures/.test(String(c[0])))).toBe(true);
  });

  it("rests on a budget stop and idles on an empty ledger", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    state.budgetError = new LlmBudgetExceededError("solver_daily_cap_micro_usd", 5, 4);
    await runSolverWorker({ logger, sleep, idleMs: 1, restMs: 99, maxTicks: 1 });
    state.budgetError = null;
    state.action = null;
    await runSolverWorker({ logger, sleep, idleMs: 1, restMs: 99, maxTicks: 1 });
    expect(sleeps).toEqual([99, 1]);
  });
});

describe("stewardContextLine", () => {
  it("names the attempt, its outcome, and one line about what happened", () => {
    const line = stewardContextLine(
      attempt({ status: "completed", outcome: "proof", lean_check_id: "chk-1", spent_micro_usd: 12_500_000, turns: 40 }) as never
    );
    expect(line).toBe(
      `proof attempt ${ATTEMPT_ID} closed as completed (variant max, outcome proof, 12.50 USD, 40 turns): ` +
        "the solver reports a checked proof (lean_check chk-1). Fetch it with get_proof_attempt."
    );
    const downgraded = stewardContextLine(
      attempt({
        status: "completed",
        outcome: "partial",
        report: { validation: { downgraded_from: "proof", reason: "no lean_check_id was given" } },
      }) as never
    );
    expect(downgraded).toMatch(/claimed a proof the harness downgraded to partial: no lean_check_id was given/);
    expect(stewardContextLine(attempt({ status: "budget" }) as never)).toMatch(/reached its cost ceiling/);
  });
});
