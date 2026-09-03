/**
 * The prize-check worker (docs/mathematics.md §8.4): the concurrency cap
 * and the daily budget, the attempt-hash rejection before any submission,
 * the accepted path (checked, the bounty to claim_pending, the Reviewer
 * under the reserve job, the Steward on admission), the rejected path, the
 * retries, and the check_error hold with its audit request. Services are
 * scripted; the checker is the in-memory fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeLeanCheckerClient } from "../../../src/services/lean-checker-fake.js";

const state = vi.hoisted(() => ({
  checking: 0,
  today: 0,
  attemptMatch: false,
  claim: null as null | Record<string, unknown>,
  transitions: [] as Array<{ from: unknown; to: string; set?: Record<string, unknown> }>,
  claimSql: [] as string[],
  reviewerCtx: null as null | Record<string, unknown>,
  reviewerAdmits: false,
  steward: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  metered: [] as Array<Record<string, unknown>>,
  recorded: [] as Array<Record<string, unknown>>,
  completed: [] as Array<{ id: string; metered: number; job: string | null }>,
  bountyStatus: [] as Array<{ from: unknown; to: string }>,
  reopened: 0,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("AS checking")) return [{ checking: state.checking, today: state.today }];
    if (sql.includes("SELECT statement_source, pin_id")) return [{ statement_source: "namespace Minerval.S00000000_v1\ndef Statement : Prop := True\nend Minerval.S00000000_v1", pin_id: "mathlib-v4.33.0" }];
    if (sql.includes("mode = 'attempt' AND submission_sha256")) return state.attemptMatch ? [{ id: "lc-attempt" }] : [];
    if (sql.includes("FROM actions WHERE kind = 'prize_review'")) return [{ id: "act-1" }];
    return [];
  }),
  withTransaction: vi.fn(async (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          state.claimSql.push(sql);
          return state.claim && state.claim.status === "queued" ? [{ id: state.claim.id }] : [];
        }
        return [];
      },
    })
  ),
}));

vi.mock("../../../src/services/prize-claim-service.js", () => ({
  QUEUE_HOLDING_STATUSES: ["checking", "check_error", "checked", "in_review", "in_challenge_window"],
  getPrizeClaimById: vi.fn(async (id: string) => (state.claim && state.claim.id === id ? { ...state.claim } : null)),
  transitionPrizeClaim: vi.fn(async (_r: unknown, _id: string, from: unknown, to: string, opts: { set?: Record<string, unknown> }) => {
    state.transitions.push({ from, to, set: opts.set });
    if (!state.claim) return null;
    state.claim = { ...state.claim, status: to, check_attempts: Number(state.claim.check_attempts ?? 0) + Number(opts.set?.checkAttemptsDelta ?? 0) };
    return { ...state.claim };
  }),
  admitPrizeClaim: vi.fn(async () => ({ ok: false, message: "nothing to admit" })),
  reopenBountyAfterClaimClosed: vi.fn(async () => {
    state.reopened++;
  }),
}));
vi.mock("../../../src/services/attachment-service.js", () => ({
  getLeanSourceForContribution: vi.fn(async () => ({ id: "att-1", sha256: FakeLeanCheckerClient.sha256("theorem proof : True := trivial"), source: "theorem proof : True := trivial", filename: "proof.lean" })),
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  getReserveJob: vi.fn(async () => ({ id: "job-reserve", user_id: "platform", budget_micro_usd: 50_000_000, status: "running" })),
  getPlatformAccountId: vi.fn(async () => "platform"),
  getBountyById: vi.fn(async () => ({ id: "b-1", status: "open" })),
  setBountyStatus: vi.fn(async (_r: unknown, _id: string, from: unknown, to: string) => {
    state.bountyStatus.push({ from, to });
    return true;
  }),
}));
vi.mock("../../../src/services/formalization-service.js", () => ({
  recordLeanCheck: vi.fn(async (input: Record<string, unknown>) => {
    state.recorded.push(input);
    return { id: "lc-1" };
  }),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  claimAction: vi.fn(async () => true),
  completeAction: vi.fn(async (id: string, metered: number, opts: { meteredJobId?: string | null }) => {
    state.completed.push({ id, metered, job: opts.meteredJobId ?? null });
    return metered;
  }),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  requestAudit: vi.fn(async (input: Record<string, unknown>) => {
    state.audits.push(input);
    return "run-1";
  }),
}));
vi.mock("../../../src/services/usage-service.js", () => ({
  meterExternalUsage: vi.fn(async (u: Record<string, unknown>) => {
    state.metered.push(u);
  }),
}));
vi.mock("../../../src/llm/agents/contribution-reviewer.js", () => ({
  runContributionReview: vi.fn(async () => {
    const { getUsageContext } = await import("../../../src/llm/usage-context.js");
    state.reviewerCtx = getUsageContext() as Record<string, unknown>;
    if (state.reviewerAdmits && state.claim) state.claim = { ...state.claim, status: "in_review" };
  }),
}));
vi.mock("../../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    state.steward.push(input);
    return { model: "strong", billedMicroUsd: 1_000 };
  }),
}));

import { processNextPrizeCheck, prizeCheckCapacity } from "../../../src/workers/prize-check-pipeline.js";
import { loadConfig } from "../../../src/config.js";

function queuedClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: "pc-1",
    contribution_id: "co-1",
    bounty_id: "b-1",
    claim_id: "claim-1",
    formalization_id: "f-1",
    claimant_id: "u-1",
    direction: "proof",
    status: "queued",
    check_attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  state.checking = 0;
  state.today = 0;
  state.attemptMatch = false;
  state.claim = queuedClaim();
  state.transitions = [];
  state.claimSql = [];
  state.reviewerCtx = null;
  state.reviewerAdmits = false;
  state.steward = [];
  state.audits = [];
  state.metered = [];
  state.recorded = [];
  state.completed = [];
  state.bountyStatus = [];
  state.reopened = 0;
});

describe("caps", () => {
  it("stops at the concurrency cap and at the daily check budget", async () => {
    const config = loadConfig();
    state.checking = config.prizeCheckMaxConcurrent;
    expect(await prizeCheckCapacity()).toMatchObject({ ok: false, reason: /concurrency/ });
    expect((await processNextPrizeCheck({ client: new FakeLeanCheckerClient() })).status).toBe("capped");
    state.checking = 0;
    state.today = config.prizeChecksPerDay;
    expect(await prizeCheckCapacity()).toMatchObject({ ok: false, reason: /daily/ });
    expect(state.transitions).toHaveLength(0);
  });

  it("reports no_checker when none is configured, and empty when nothing is queued", async () => {
    expect((await processNextPrizeCheck({ client: null })).status).toBe("no_checker");
    state.claim = null;
    expect((await processNextPrizeCheck({ client: new FakeLeanCheckerClient() })).status).toBe("empty");
  });
});

describe("serialization", () => {
  it("claims the oldest queued claim per statement with FOR UPDATE SKIP LOCKED, excluding statements holding a live claim", async () => {
    const fake = new FakeLeanCheckerClient();
    await processNextPrizeCheck({ client: fake });
    expect(state.claimSql[0]).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(state.claimSql[0]).toMatch(/h\.status = ANY\(\$1\)/);
    expect(state.claimSql[0]).toMatch(/ORDER BY pc\.submitted_at ASC, pc\.id ASC/);
    expect(state.transitions[0]).toMatchObject({ from: "queued", to: "checking", set: { checkAttemptsDelta: 1 } });
  });
});

describe("the attempt-hash rejection", () => {
  it("rejects a source matching an attempt-mode check at stage check, before any submission", async () => {
    state.attemptMatch = true;
    const fake = new FakeLeanCheckerClient();
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ status: "processed", verdict: "rejected", outcome: "copy_of_attempt" });
    expect(fake.submissions).toHaveLength(0);
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "rejected", set: { rejectedStage: "check", leanCheckId: null } });
    expect(state.reopened).toBe(1);
  });
});

describe("the accepted path", () => {
  it("records the check, meters it, moves to checked, closes the gate, runs the Reviewer under the reserve job, and invokes the Steward when admitted", async () => {
    const fake = new FakeLeanCheckerClient();
    state.reviewerAdmits = true;
    const r = await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(r).toMatchObject({ status: "processed", verdict: "accepted", outcome: "in_review" });
    expect(fake.submissions[0]).toMatchObject({ mode: "prize", kind: "proof" });
    expect(state.metered[0]).toMatchObject({ provider: "lean", unitKind: "wall_ms" });
    expect(state.recorded[0]).toMatchObject({ prizeClaimId: "pc-1", submittedBy: "contributor:u-1" });
    expect(state.transitions.map((t) => t.to)).toEqual(["checking", "checked"]);
    expect(state.transitions[1]!.set).toMatchObject({ leanCheckId: "lc-1" });
    expect(state.bountyStatus[0]).toEqual({ from: "open", to: "claim_pending" });
    expect(state.reviewerCtx).toMatchObject({ jobId: "job-reserve", userId: "platform", claimId: "claim-1" });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_claim", claimId: "claim-1", jobId: "job-reserve", userId: "platform" });
    expect(state.completed[0]).toMatchObject({ id: "act-1", job: "job-reserve" });
  });

  it("does not invoke the Steward when the Reviewer did not admit", async () => {
    const fake = new FakeLeanCheckerClient();
    await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(state.steward).toHaveLength(0);
  });
});

describe("the rejected path", () => {
  it("records the gate summary and moves to rejected at stage check, reopening the bounty", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "rejected", failed_gate: "axioms" });
    const r = await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(r).toMatchObject({ verdict: "rejected" });
    expect(state.transitions.at(-1)).toMatchObject({ to: "rejected", set: { rejectedStage: "check", leanCheckId: "lc-1" } });
    expect(state.reopened).toBe(1);
    expect(state.steward).toHaveLength(0);
  });
});

describe("errors, retries, and the hold", () => {
  it("requeues on a checker error below the attempt cap", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "error", error_reason: "timeout" });
    const r = await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(r).toMatchObject({ verdict: "error" });
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "queued" });
    expect(state.audits).toHaveLength(0);
    expect(state.recorded).toHaveLength(0);
  });

  it("moves to check_error at the cap, holding the queue, and requests a prize_check_error audit", async () => {
    const config = loadConfig();
    state.claim = queuedClaim({ check_attempts: config.prizeCheckMaxAttempts - 1 });
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "error", error_reason: "oom" });
    await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "check_error" });
    expect(state.audits[0]).toMatchObject({ auditType: "anomaly_investigation", triggeredBy: "prize_check_error", dedupeKey: "prize_check_error:pc-1" });
  });

  it("treats an unreachable checker as an error too", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.submitCheck = async () => {
      throw new Error("checker unreachable");
    };
    const r = await processNextPrizeCheck({ client: fake, pollMs: 0 });
    expect(r).toMatchObject({ verdict: "error", error: /unreachable/ });
    expect(state.transitions.at(-1)).toMatchObject({ to: "queued" });
  });
});
