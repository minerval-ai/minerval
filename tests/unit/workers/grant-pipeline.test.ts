import { describe, it, expect, beforeEach, vi } from "vitest";

// Grant worker control flow: the steward-run half of mandates only —
// approved agent-plan claim items and the deepen selector, with funding
// attribution, pause at the committed floor, and deepen completion +
// refund. Planning, mandate reviews, and ingests belong to the engine
// executor over the action ledger, NOT to this worker. DB/agents mocked.

const { state, stewardRuns, grantorRuns } = vi.hoisted(() => ({
  stewardRuns: [] as Array<{ claimId: string; trigger: string }>,
  grantorRuns: [] as Array<{ grantName: string }>,
  state: {
    grant: null as null | Record<string, unknown>,
    spent: 0,
    targets: [] as Array<{
      id: string;
      prior_state: string;
      decomposition_status: string;
      steward_trigger: string | null;
      steward_context: string | null;
    }>,
    specificTargets: {} as Record<string, boolean>,
    grantUpdates: [] as Array<{ sql: string; params: unknown[] }>,
    jobUpdates: [] as Array<{ sql: string; params: unknown[] }>,
    stakes: [] as unknown[],
    refunds: [] as unknown[],
    plan: { strategy: "s", items: [] } as unknown,
    usageContexts: [] as unknown[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    // The atomic pick-and-claim (UPDATE ... FROM (SELECT ... SKIP LOCKED)).
    if (q.includes("SKIP LOCKED") && q.includes("JOIN budget_jobs j2")) {
      return state.grant ? [state.grant] : [];
    }
    if (q.includes("WITH RECURSIVE") && q.includes("UPDATE claims")) {
      const t = state.targets.shift();
      return t ? [t] : [];
    }
    if (q.includes("prior.prior_state") && q.includes("'15 minutes'")) {
      // claimSpecificTarget
      const claimId = params[0] as string;
      if (state.specificTargets[claimId]) {
        delete state.specificTargets[claimId];
        return [
          {
            id: claimId,
            prior_state: "done",
            decomposition_status: "complete",
            steward_trigger: null,
            steward_context: null,
          },
        ];
      }
      return [];
    }
    if (q.includes("INSERT INTO claim_stakes")) {
      state.stakes.push(params);
      return [];
    }
    if (q.includes("UPDATE grants")) {
      state.grantUpdates.push({ sql: q, params });
      return [];
    }
    if (q.includes("UPDATE budget_jobs")) {
      state.jobUpdates.push({ sql: q, params });
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({
  runClaimSteward: vi.fn(
    async (input: { claimId: string; trigger: string }) => {
      stewardRuns.push({ claimId: input.claimId, trigger: input.trigger });
    }
  ),
}));

vi.mock("../../../src/llm/agents/grantor.js", () => ({
  runGrantor: vi.fn(async (input: { grantName: string }) => {
    grantorRuns.push({ grantName: input.grantName });
    return state.plan;
  }),
}));

vi.mock("../../../src/services/budget-job-service.js", () => ({
  refundUnspentBudget: vi.fn(async (job: unknown) => {
    state.refunds.push(job);
    return 1;
  }),
}));

vi.mock("../../../src/services/regrant-service.js", () => ({
  grantCommittedMicroUsd: vi.fn(async () => state.spent),
}));

vi.mock("../../../src/services/priority-service.js", () => ({
  refreshQueuePriority: vi.fn(async () => 1),
}));

vi.mock("../../../src/llm/usage-context.js", () => ({
  runWithUsageContext: (ctx: unknown, fn: () => unknown) => {
    state.usageContexts.push(ctx);
    return fn();
  },
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    stewardModel: "claude-sonnet-5",
    stewardStrongModel: "",
    governanceModel: "claude-sonnet-5",
    owlPriceMicroUsd: 4_000_000,
    grantMaintainCadenceDays: 30,
  }),
}));

import { processNextGrantTask } from "../../../src/workers/grant-pipeline.js";

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    funder_user_id: "funder-1",
    budget_job_id: "gjob-1",
    name: "Nutrition science cruxes",
    scope_claim_id: "root-1",
    scope_query: null,
    policy: "deepen",
    status: "active",
    plan: null,
    plan_cursor: 0,
    budget_micro_usd: 40_000_000,
    job_status: "running",
    ...overrides,
  };
}

beforeEach(() => {
  stewardRuns.length = 0;
  grantorRuns.length = 0;
  state.grant = null;
  state.spent = 0;
  state.targets = [];
  state.specificTargets = {};
  state.grantUpdates = [];
  state.jobUpdates = [];
  state.stakes = [];
  state.refunds = [];
  state.usageContexts = [];
  state.plan = {
    strategy: "focus the cruxes",
    items: [{ claim_id: "p-1", action: "assess", rationale: "live crux" }],
  };
});

describe("processNextGrantTask", () => {
  it("returns empty with no runnable grants", async () => {
    expect((await processNextGrantTask()).status).toBe("empty");
  });

  it("never plans here: planning runs belong to the engine executor", async () => {
    state.grant = grant({ policy: "agent", status: "planning" });
    const r = await processNextGrantTask();
    expect(r.status).toBe("empty");
    expect(grantorRuns).toHaveLength(0);
    expect(stewardRuns).toHaveLength(0);
  });

  it("executes a deepen target with grant attribution", async () => {
    state.grant = grant();
    state.targets = [
      {
        id: "c-1",
        prior_state: "pending",
        decomposition_status: "pending",
        steward_trigger: null,
        steward_context: null,
      },
    ];
    const r = await processNextGrantTask();
    expect(r).toMatchObject({ status: "processed", ok: true, claimId: "c-1" });
    expect(stewardRuns).toEqual([
      { claimId: "c-1", trigger: "structure_and_assess" },
    ]);
    expect(state.usageContexts[0]).toMatchObject({
      userId: "funder-1",
      jobId: "gjob-1",
    });
  });

  it("executes an approved agent plan item and advances the cursor", async () => {
    state.grant = grant({
      policy: "agent",
      status: "active",
      plan: state.plan,
    });
    state.specificTargets["p-1"] = true;
    const r = await processNextGrantTask();
    expect(r).toMatchObject({ status: "processed", ok: true, claimId: "p-1" });
    const cursorWrite = state.grantUpdates.find((u) =>
      u.sql.includes("plan_cursor")
    );
    expect(cursorWrite).toBeDefined();
  });

  it("pauses the budget job at the floor", async () => {
    state.grant = grant({ budget_micro_usd: 8_000_000 });
    state.spent = 8_000_001;
    const r = await processNextGrantTask();
    expect(r.status).toBe("paused");
    expect(
      state.jobUpdates.some((u) => u.sql.includes("'paused_budget'"))
    ).toBe(true);
    expect(stewardRuns).toHaveLength(0);
  });

  it("completes and refunds a deepen grant when the scope is exhausted", async () => {
    state.grant = grant();
    state.targets = [];
    const r = await processNextGrantTask();
    expect(r.status).toBe("completed");
    expect(state.refunds).toHaveLength(1);
    expect(
      state.grantUpdates.some((u) => u.sql.includes("'completed'"))
    ).toBe(true);
  });

  it("keeps an exhausted agent mandate alive: closing it is its review agent's call", async () => {
    state.grant = grant({ policy: "agent", status: "active", plan: state.plan });
    // The plan's one claim item is already handled; nothing to steward.
    const r = await processNextGrantTask();
    expect(r.status).toBe("empty");
    expect(state.refunds).toHaveLength(0);
    expect(
      state.grantUpdates.some((u) => u.sql.includes("'completed'"))
    ).toBe(false);
  });

  it("waits on ledger ingests without advancing the cursor or completing", async () => {
    state.grant = grant({
      policy: "agent",
      status: "active",
      plan: {
        strategy: "s",
        items: [
          { action: "ingest", url: "https://example.org/x", rationale: "r" },
        ],
      },
    });
    const r = await processNextGrantTask();
    expect(r.status).toBe("empty");
    expect(stewardRuns).toHaveLength(0);
    expect(
      state.grantUpdates.some((u) => u.sql.includes("plan_cursor"))
    ).toBe(false);
    expect(state.refunds).toHaveLength(0);
  });
});
