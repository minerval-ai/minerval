import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Curate and audit on the engine executor (#363). Both are funded ledger
 * actions now, so the run is metered to whoever covered it — not to whoever
 * happened to be nearby when the concern was raised (the Curator used to
 * bill the escalating Steward's job) and not to nobody (audits ran
 * unattributed). A curate run reads every live request on its anchor and
 * consumes them when it ends; an audit run closes its audit_runs row; a
 * prize audit runs under the bounty's reserve; and the unfunded fallback
 * lane runs an uncovered row only when opted in and no mandate could fund
 * the kind.
 */

const ANCHOR = "c1111111-1111-4111-8111-111111111111";
const RUN_ID = "a2222222-2222-4222-8222-222222222222";

const { state } = vi.hoisted(() => ({
  state: {
    covered: null as null | Record<string, unknown>,
    fallback: [] as Array<Record<string, unknown>>,
    claimState: "active",
    requests: [] as Array<Record<string, unknown>>,
    moreAfter: 0,
    auditRun: null as null | Record<string, unknown>,
    funder: { jobId: "job-1", grantId: "g-1" } as Record<string, unknown>,
    fallbackLane: false,
    generalMandate: null as null | Record<string, unknown>,
    governance: [] as string[],
    contexts: [] as Array<Record<string, unknown>>,
    budgets: [] as Array<{ microUsd: number; source: string }>,
    curatorCalls: [] as Array<Record<string, unknown>>,
    auditCalls: [] as Array<Record<string, unknown>>,
    completed: [] as Array<{ id: string; metered: number; meteredJobId: unknown }>,
    consumed: [] as Array<{ ids: string[]; actionId: string }>,
    reopened: [] as string[],
    auditClosed: [] as unknown[][],
    cancelled: [] as unknown[][],
    request: null as null | Record<string, unknown>,
  },
}));

vi.mock("../../../src/services/request-service.js", () => ({
  getRequest: vi.fn(async () => state.request),
  notifyRequestKeeper: vi.fn(async () => true),
  recordWork: vi.fn(async () => ({ id: "w" })),
  requestBrief: () => "brief",
  setRequestBudget: vi.fn(async () => {}),
  workLabel: (w: { by: string; outcome: string | null; funding?: string | null }) => {
    const marks = [w.outcome, w.funding].filter(Boolean).join("; ");
    return `${w.by}${marks ? ` (${marks})` : ""}`;
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("SELECT state FROM claims WHERE id = $1")) {
      return [{ state: state.claimState }];
    }
    if (q.includes("SELECT funder_user_id FROM grants")) {
      return [{ funder_user_id: "u-funder" }];
    }
    if (q.includes("FROM curation_requests") && q.includes("COUNT(*)")) {
      return [{ n: state.moreAfter }];
    }
    if (q.includes("FROM audit_runs WHERE id = $1")) {
      return state.auditRun ? [state.auditRun] : [];
    }
    if (q.includes("UPDATE audit_runs")) {
      state.auditClosed.push(params);
      return [];
    }
    if (q.includes("0::bigint AS coverage_micro_usd")) {
      return state.fallback;
    }
    if (q.includes("'cancelled'")) {
      state.cancelled.push(params);
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/action-service.js", () => ({
  actionBudgetMicroUsd: (a: { cost_est_micro_usd: number | string; coverage_micro_usd: number | string }) =>
    Math.max(Number(a.cost_est_micro_usd) || 0, Number(a.coverage_micro_usd) || 0),
  nextRunnableAction: vi.fn(async () => state.covered),
  claimAction: vi.fn(async () => true),
  releaseAction: vi.fn(async () => {}),
  completeAction: vi.fn(async (id: string, metered: number, opts: { meteredJobId?: unknown } = {}) => {
    state.completed.push({ id, metered, meteredJobId: opts.meteredJobId });
    return metered;
  }),
  largestActionFunder: vi.fn(async () => state.funder),
  ensureCurateAction: vi.fn(async (claimId: string) => {
    state.reopened.push(claimId);
    return "act-c";
  }),
}));

vi.mock("../../../src/services/curation-service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  liveCurationRequests: vi.fn(async () => state.requests),
  consumeCurationRequests: vi.fn(async (ids: string[], actionId: string) => {
    state.consumed.push({ ids, actionId });
  }),
  describeCurationRequests: (rs: Array<{ concern: string }>) =>
    rs.map((r) => r.concern).join("\n"),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getGeneralMandate: vi.fn(async () => state.generalMandate),
  getGovernanceMandateIds: vi.fn(async () => state.governance),
}));

vi.mock("../../../src/services/bounty-service.js", () => ({
  getReserveJob: vi.fn(async () => ({ id: "reserve-job", user_id: "u-platform" })),
  getPlatformAccountId: vi.fn(async () => "u-platform"),
}));

vi.mock("../../../src/llm/agents/curator.js", () => ({
  runCurator: vi.fn(async (input: Record<string, unknown>) => {
    state.curatorCalls.push(input);
  }),
}));
vi.mock("../../../src/llm/agents/audit-agent.js", () => ({
  runAudit: vi.fn(async (input: Record<string, unknown>) => {
    state.auditCalls.push(input);
  }),
}));

vi.mock("../../../src/services/allocation-service.js", () => ({
  fundGrantSelfActions: vi.fn(async () => 0),
}));
vi.mock("../../../src/llm/agents/grantor.js", () => ({ runGrantor: vi.fn() }));
vi.mock("../../../src/llm/agents/mandate-review.js", () => ({ runMandateReview: vi.fn() }));
vi.mock("../../../src/services/source-service.js", () => ({ submitSource: vi.fn() }));
vi.mock("../../../src/workers/steward-direct.js", () => ({ invokeStewardDirect: vi.fn() }));
vi.mock("../../../src/llm/usage-context.js", () => ({
  // The executor opens each row's handler at the row's label; here it only passes through.
  runAtLabel: (_label: unknown, _work: string, fn: () => unknown) => fn(),
  runBudget: () => null,
  budgetRefusal: () => null,
  runWithUsageContext: (ctx: Record<string, unknown>, fn: () => Promise<unknown>) => {
    state.contexts.push(ctx);
    return fn();
  },
  withCostMeter: async (fn: () => Promise<unknown>) => {
    await fn();
    return { billedMicroUsd: 120_000 };
  },
  withPassBudget: async (budget: { microUsd: number; source: string }, fn: () => Promise<unknown>) => {
    state.budgets.push(budget);
    await fn();
    return { billedMicroUsd: 120_000 };
  },
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    owlCostMicroUsd: 1_000_000,
    curateRunBudgetOwls: 5,
    auditRunBudgetOwls: 5,
    backgroundFallbackLaneEnabled: state.fallbackLane,
    curatorMaxRuns: 0,
  }),
}));

import {
  processNextEngineAction,
  resetFallbackCuratorRuns,
} from "../../../src/workers/engine-executor.js";

const curateAction = () => ({
  id: "act-c",
  kind: "curate",
  exclusion_group: `curate:${ANCHOR}`,
  variant: "standard",
  claim_id: ANCHOR,
  target_ref: null,
  cost_est_micro_usd: 250_000,
  coverage_micro_usd: 250_000,
  sensitivity_label: "public",
  updated_at: new Date(),
});

const auditAction = () => ({
  id: "act-a",
  kind: "audit",
  exclusion_group: `audit:${RUN_ID}`,
  variant: "standard",
  claim_id: null,
  target_ref: RUN_ID,
  cost_est_micro_usd: 500_000,
  coverage_micro_usd: 500_000,
  sensitivity_label: "public",
  updated_at: new Date(),
});

beforeEach(() => {
  state.covered = null;
  state.fallback = [];
  state.claimState = "active";
  state.requests = [
    { id: "r1", concern: "likely duplicate of X", source: "steward_escalation" },
    { id: "r2", concern: "conflates A and B", source: "operator" },
  ];
  state.moreAfter = 0;
  state.auditRun = {
    id: RUN_ID,
    audit_type: "decision_audit",
    context: "an overturn",
    completed_at: null,
    bounty_id: null,
  };
  state.funder = { jobId: "job-1", grantId: "g-1" };
  state.fallbackLane = false;
  state.generalMandate = null;
  state.governance = [];
  state.contexts = [];
  state.curatorCalls = [];
  state.auditCalls = [];
  state.completed = [];
  state.consumed = [];
  state.reopened = [];
  state.auditClosed = [];
  state.cancelled = [];
  state.request = null;
  state.budgets = [];
  resetFallbackCuratorRuns();
});

describe("the curate action", () => {
  it("runs the Curator on every live request, metered to the funder, and consumes them", async () => {
    state.covered = curateAction();
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "curate", grantId: "g-1" });
    expect(state.contexts[0]).toEqual({ userId: "u-funder", jobId: "job-1", claimId: ANCHOR });
    expect(state.curatorCalls).toHaveLength(1);
    expect(state.curatorCalls[0]).toMatchObject({ trigger: "curation_request", claimId: ANCHOR });
    expect(String(state.curatorCalls[0]!.context)).toContain("likely duplicate of X");
    expect(String(state.curatorCalls[0]!.context)).toContain("conflates A and B");
    expect(state.completed).toEqual([{ id: "act-c", metered: 120_000, meteredJobId: "job-1" }]);
    expect(state.consumed).toEqual([{ ids: ["r1", "r2"], actionId: "act-c" }]);
    expect(state.reopened).toEqual([]);
  });

  it("works to the 5-owl run budget when its allocations cover less, and says whose it is", async () => {
    state.covered = curateAction();
    await processNextEngineAction();
    expect(state.budgets[0]).toEqual({
      microUsd: 5_000_000,
      source: "this curation's run budget, which its funding mandate covers",
      funding: { actionId: expect.any(String) },
    });
  });

  it("reopens the row when a concern arrived while the run held it", async () => {
    state.covered = curateAction();
    state.moreAfter = 1;
    await processNextEngineAction();
    expect(state.reopened).toEqual([ANCHOR]);
  });

  it("cancels a row with nothing left to read, spending nothing", async () => {
    state.covered = curateAction();
    state.requests = [];
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.curatorCalls).toHaveLength(0);
    expect(state.cancelled).toEqual([[`curate:${ANCHOR}`]]);
  });

  it("cancels a row whose anchor was merged away", async () => {
    state.covered = curateAction();
    state.claimState = "merged";
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.curatorCalls).toHaveLength(0);
  });
});

describe("the curate action on a request the Curator keeps (#722)", () => {
  const REQUEST = "d3333333-3333-4333-8333-333333333333";
  const requestAction = () => ({
    ...curateAction(),
    id: "act-cr",
    exclusion_group: `curate:request:${REQUEST}`,
    claim_id: null,
    target_ref: REQUEST,
  });
  const request = (over: Record<string, unknown> = {}) => ({
    id: REQUEST,
    ask: "Find every estimate of the regional figure",
    why: "Three claims rest on it",
    satisfied_by: "A table of the estimates with their sources",
    bears_on: [{ id: ANCHOR, text: "The figure is 40 percent", kind: "claim" }],
    bears_on_sources: [],
    bears_on_text: "the regional estimates",
    keeper: { kind: "curator", label: "the Curator" },
    state: "in_progress",
    work: [
      { by: "Researcher", outcome: "partly_met", summary: "Found four of six regions.", research_run_id: "run-9", funded_by: "x" },
    ],
    ...over,
  });

  it("runs the Curator on a request-anchored brief that names the run holding the full report", async () => {
    state.covered = requestAction();
    state.request = request();
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "curate", grantId: "g-1" });
    expect(state.curatorCalls).toHaveLength(1);
    expect(state.curatorCalls[0]).toMatchObject({ trigger: "request_returned", claimId: null, requestId: REQUEST });
    const brief = String(state.curatorCalls[0]!.context);
    expect(brief).toContain("Find every estimate of the regional figure");
    expect(brief).toContain("Found four of six regions.");
    expect(brief).toContain("get_research_run run-9");
    expect(brief).toContain("decide whether the request has been met");
    // The agents that judge a request never see who paid for its work.
    expect(brief).not.toContain("funded_by");
    expect(state.completed).toEqual([{ id: "act-cr", metered: 120_000, meteredJobId: "job-1" }]);
    expect(state.consumed).toEqual([]);
  });

  it("cancels the row when the request closed or passed to a Steward while it waited", async () => {
    for (const over of [{ state: "met" }, { keeper: { kind: "steward", label: "the claim's Steward" } }]) {
      state.covered = requestAction();
      state.request = request(over);
      state.cancelled = [];
      const r = await processNextEngineAction();
      expect(r.status).toBe("empty");
      expect(state.cancelled).toEqual([[`curate:request:${REQUEST}`]]);
    }
    expect(state.curatorCalls).toHaveLength(0);
  });
});

describe("the audit action", () => {
  it("runs the Audit Agent for the run row under its funder and closes the row", async () => {
    state.covered = auditAction();
    state.funder = { jobId: "gov-job", grantId: "g-gov" };
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", ok: true, kind: "audit", grantId: "g-gov" });
    expect(state.auditCalls).toEqual([
      { auditType: "decision_audit", context: "an overturn", runId: RUN_ID },
    ]);
    expect(state.contexts[0]).toEqual({ userId: "u-funder", jobId: "gov-job" });
    expect(state.completed).toEqual([{ id: "act-a", metered: 120_000, meteredJobId: "gov-job" }]);
    expect(state.auditClosed).toEqual([[RUN_ID]]);
    expect(state.budgets[0]!.microUsd).toBe(5_000_000);
  });

  it("runs a prize audit under the bounty's reserve job and the platform account", async () => {
    state.covered = auditAction();
    state.funder = { userId: "u-platform" };
    state.auditRun = { ...state.auditRun!, bounty_id: "bounty-1" };
    await processNextEngineAction();
    expect(state.contexts[0]).toEqual({ userId: "u-platform", jobId: "reserve-job" });
    expect(state.completed[0]!.meteredJobId).toBe("reserve-job");
  });

  it("does not rerun an audit whose run row is already complete", async () => {
    state.covered = auditAction();
    state.auditRun = { ...state.auditRun!, completed_at: new Date() };
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.auditCalls).toHaveLength(0);
  });
});

describe("the unfunded fallback lane", () => {
  it("is closed by default: an uncovered row waits for funding", async () => {
    state.fallback = [{ ...curateAction(), coverage_micro_usd: 0 }];
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
    expect(state.curatorCalls).toHaveLength(0);
  });

  it("runs an uncovered curate row, attributed to nobody, when opted in with no General mandate", async () => {
    state.fallbackLane = true;
    state.fallback = [{ ...curateAction(), coverage_micro_usd: 0 }];
    state.funder = {};
    const r = await processNextEngineAction();
    expect(r).toMatchObject({ status: "processed", kind: "curate" });
    expect(state.contexts[0]).toEqual({ userId: null, jobId: null, claimId: ANCHOR });
  });

  it("never runs unfunded work a seeded mandate could fund", async () => {
    state.fallbackLane = true;
    state.generalMandate = { grantId: "g-general" };
    state.governance = ["g-gov"];
    state.fallback = [{ ...curateAction(), coverage_micro_usd: 0 }];
    const r = await processNextEngineAction();
    expect(r.status).toBe("empty");
  });
});
