/**
 * The prize-check worker (docs/mathematics.md §8.4), two-step: a tick
 * submits one claim and returns while the check runs, or polls each check
 * in flight once and lands the first finished one. Also the concurrency cap
 * and the daily budget, the attempt-hash rejection before any submission,
 * the accepted path (checked, the bounty to claim_pending, the Reviewer
 * under the reserve job with the review claimed, the Steward on admission),
 * the rejected path, the retries that force a fresh run, the check_error
 * hold with its audit request, the restart recovery of the check id, the
 * poll timeout, and the three sweeps (a lost Reviewer run, an audit
 * send-back, a claim stuck in review). Services are scripted; the checker
 * is the in-memory fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeLeanCheckerClient } from "../../../src/services/lean-checker-fake.js";

const state = vi.hoisted(() => ({
  checking: 0,
  today: 0,
  attemptMatch: false,
  claim: null as null | Record<string, unknown>,
  transitions: [] as Array<{ from: unknown; to: string; set?: Record<string, unknown> }>,
  fieldUpdates: [] as Array<{ id: string; set: Record<string, unknown>; action?: string }>,
  claimSql: [] as string[],
  sql: [] as string[],
  reviewerCtx: null as null | Record<string, unknown>,
  reviewerRuns: 0,
  reviewerAdmits: false,
  steward: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  metered: [] as Array<Record<string, unknown>>,
  recorded: [] as Array<Record<string, unknown>>,
  completed: [] as Array<{ id: string; metered: number; job: string | null }>,
  bountyStatus: [] as Array<{ from: unknown; to: string }>,
  reopened: 0,
  contributionUpdates: [] as string[],
  sentBack: [] as Array<{ id: string; claim_id: string }>,
  sendBackNote: null as null | string,
  staleInReview: [] as Array<{ id: string }>,
  pendingReview: [] as Array<{ id: string; contribution_id: string }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    state.sql.push(sql);
    if (sql.includes("AS checking")) return [{ checking: state.checking, today: state.today }];
    if (sql.includes("SELECT statement_source, pin_id")) return [{ statement_source: "namespace Minerval.S00000000_v1\ndef Statement : Prop := True\nend Minerval.S00000000_v1", pin_id: "mathlib-v4.33.0" }];
    if (sql.includes("mode = 'attempt' AND submission_sha256")) return state.attemptMatch ? [{ id: "lc-attempt" }] : [];
    if (sql.includes("FROM actions WHERE kind = 'prize_review'")) return [{ id: "act-1" }];
    if (sql.includes("WHERE status = 'checking' ORDER BY updated_at")) {
      return state.claim && state.claim.status === "checking" ? [{ id: state.claim.id }] : [];
    }
    if (sql.includes("audit_outcome = 'send_back'")) return state.sentBack;
    if (sql.includes("steward_decision IS NULL")) return state.staleInReview;
    if (sql.includes("c.review_status = 'pending'")) return state.pendingReview;
    if (sql.includes("action = 'prize_claim:audit_send_back'")) return state.sendBackNote ? [{ reasoning: state.sendBackNote }] : [];
    if (sql.startsWith("UPDATE contributions")) {
      state.contributionUpdates.push(sql);
      return [{ id: "co-1" }];
    }
    return [];
  }),
  withTransaction: vi.fn(async (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        state.sql.push(sql);
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          state.claimSql.push(sql);
          return state.claim && state.claim.status === "queued" ? [{ id: state.claim.id }] : [];
        }
        if (sql.startsWith("UPDATE contributions")) state.contributionUpdates.push(sql);
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
  updatePrizeClaimFields: vi.fn(async (_r: unknown, id: string, set: Record<string, unknown>, note?: { action: string }) => {
    state.fieldUpdates.push({ id, set, action: note?.action });
    if (!state.claim || state.claim.id !== id) return null;
    if (set.auditOutcome !== undefined) state.claim = { ...state.claim, audit_outcome: set.auditOutcome };
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
    state.reviewerRuns++;
    if (state.reviewerAdmits && state.claim) state.claim = { ...state.claim, status: "in_review" };
  }),
}));
vi.mock("../../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    state.steward.push(input);
    return { model: "strong", billedMicroUsd: 1_000 };
  }),
}));

import {
  PRIZE_CHECK_POLL_TIMEOUT_MS,
  inFlightCheckFor,
  processNextPrizeCheck,
  prizeCheckCapacity,
  resetInFlightChecksForTests,
} from "../../../src/workers/prize-check-pipeline.js";
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
    steward_decision: null,
    audit_outcome: null,
    ...overrides,
  };
}

/** A fake whose getCheck calls are counted. */
function countingFake(): FakeLeanCheckerClient & { polls: number } {
  const fake = new FakeLeanCheckerClient() as FakeLeanCheckerClient & { polls: number };
  fake.polls = 0;
  const original = fake.getCheck.bind(fake);
  fake.getCheck = async (id: string) => {
    fake.polls++;
    return original(id);
  };
  return fake;
}

beforeEach(() => {
  state.checking = 0;
  state.today = 0;
  state.attemptMatch = false;
  state.claim = queuedClaim();
  state.transitions = [];
  state.fieldUpdates = [];
  state.claimSql = [];
  state.sql = [];
  state.reviewerCtx = null;
  state.reviewerRuns = 0;
  state.reviewerAdmits = false;
  state.steward = [];
  state.audits = [];
  state.metered = [];
  state.recorded = [];
  state.completed = [];
  state.bountyStatus = [];
  state.reopened = 0;
  state.contributionUpdates = [];
  state.sentBack = [];
  state.sendBackNote = null;
  state.staleInReview = [];
  state.pendingReview = [];
  resetInFlightChecksForTests();
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
    expect(state.completed[0]).toMatchObject({ id: "act-1", metered: 0 });
  });
});

describe("two steps: submit, then poll", () => {
  it("a tick with a running check submits, polls once, and returns promptly", async () => {
    const fake = countingFake();
    fake.scriptDefault({ verdict: "accepted", polls: 2 });
    const started = Date.now();
    const first = await processNextPrizeCheck({ client: fake });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first).toMatchObject({ status: "submitted", prizeClaimId: "pc-1", checkId: "chk_1", inFlight: 1 });
    expect(fake.submissions).toHaveLength(1);
    expect(fake.polls).toBe(1);
    expect(inFlightCheckFor("pc-1")).toMatchObject({ checkId: "chk_1" });
    expect(state.claim!.status).toBe("checking");
    expect(state.transitions.map((t) => t.to)).toEqual(["checking"]);
    expect(state.reviewerRuns).toBe(0);

    // The next tick polls once more, lands nothing, submits nothing new.
    const second = await processNextPrizeCheck({ client: fake });
    expect(second).toEqual({ status: "polling", inFlight: 1 });
    expect(fake.polls).toBe(2);
    expect(fake.submissions).toHaveLength(1);
    expect(state.sql.some((q) => q.includes("SET updated_at = now() WHERE id = $1 AND status = 'checking'"))).toBe(true);

    // The tick after that lands the verdict.
    state.reviewerAdmits = true;
    const third = await processNextPrizeCheck({ client: fake });
    expect(third).toMatchObject({ status: "processed", verdict: "accepted", outcome: "in_review", checkId: "chk_1" });
    expect(fake.polls).toBe(3);
    expect(inFlightCheckFor("pc-1")).toBeUndefined();
    expect(state.steward).toHaveLength(1);
  });

  it("recovers the check id after a restart by re-submitting with force: false, which the checker dedupes", async () => {
    const fake = countingFake();
    fake.scriptDefault({ verdict: "accepted", polls: 1 });
    expect((await processNextPrizeCheck({ client: fake })).status).toBe("submitted");
    resetInFlightChecksForTests();
    expect(inFlightCheckFor("pc-1")).toBeUndefined();

    const r = await processNextPrizeCheck({ client: fake });
    expect(fake.submissions).toHaveLength(2);
    expect(fake.submissions[1]).toMatchObject({ mode: "prize", force: false });
    // The checker answered with the record it already held: no second run.
    expect(r).toMatchObject({ status: "processed", verdict: "accepted", checkId: "chk_1" });
    expect(fake.records.size).toBe(1);
  });

  it("forces a fresh run on a retry, because the checker would otherwise dedupe the error it is retrying", async () => {
    const fake = new FakeLeanCheckerClient();
    state.claim = queuedClaim({ check_attempts: 1 });
    await processNextPrizeCheck({ client: fake });
    expect(fake.submissions[0]).toMatchObject({ force: true });
    state.claim = queuedClaim({ check_attempts: 0 });
    resetInFlightChecksForTests();
    await processNextPrizeCheck({ client: fake });
    expect(fake.submissions[1]).toMatchObject({ force: false });
  });

  it("treats a check that never finishes within the poll timeout as a checker error", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "accepted", polls: 50 });
    expect((await processNextPrizeCheck({ client: fake })).status).toBe("submitted");
    inFlightCheckFor("pc-1")!.submittedAt = Date.now() - PRIZE_CHECK_POLL_TIMEOUT_MS - 1;
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ status: "processed", verdict: "error", error: /did not finish within/ });
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "queued" });
    expect(inFlightCheckFor("pc-1")).toBeUndefined();
  });
});

describe("the accepted path", () => {
  it("records the check, meters it, moves to checked, closes the gate, claims the review for the Reviewer under the reserve job, and invokes the Steward when admitted", async () => {
    const fake = new FakeLeanCheckerClient();
    state.reviewerAdmits = true;
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ status: "processed", verdict: "accepted", outcome: "in_review" });
    expect(fake.submissions[0]).toMatchObject({ mode: "prize", kind: "proof" });
    expect(state.metered[0]).toMatchObject({ provider: "lean", unitKind: "wall_ms" });
    expect(state.recorded[0]).toMatchObject({ prizeClaimId: "pc-1", submittedBy: "contributor:u-1" });
    expect(state.transitions.map((t) => t.to)).toEqual(["checking", "checked"]);
    expect(state.transitions[1]!.set).toMatchObject({ leanCheckId: "lc-1" });
    expect(state.bountyStatus[0]).toEqual({ from: "open", to: "claim_pending" });
    // `pending` and claimed in the same statement, so the ordinary pipeline never races this Reviewer.
    const pending = state.contributionUpdates.find((q) => q.includes("review_status = 'pending'"))!;
    expect(pending).toContain("review_claimed_at = now()");
    expect(pending).toContain("review_attempts = review_attempts + 1");
    expect(state.reviewerCtx).toMatchObject({ jobId: "job-reserve", userId: "platform", claimId: "claim-1" });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_claim", claimId: "claim-1", jobId: "job-reserve", userId: "platform" });
    expect(state.completed[0]).toMatchObject({ id: "act-1", job: "job-reserve" });
  });

  it("does not invoke the Steward when the Reviewer did not admit", async () => {
    const fake = new FakeLeanCheckerClient();
    await processNextPrizeCheck({ client: fake });
    expect(state.steward).toHaveLength(0);
  });
});

describe("the rejected path", () => {
  it("records the gate summary and moves to rejected at stage check, reopening the bounty", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "rejected", failed_gate: "axioms" });
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ verdict: "rejected" });
    expect(state.transitions.at(-1)).toMatchObject({ to: "rejected", set: { rejectedStage: "check", leanCheckId: "lc-1" } });
    expect(state.reopened).toBe(1);
    expect(state.steward).toHaveLength(0);
    expect(state.completed[0]).toMatchObject({ id: "act-1", job: "job-reserve" });
  });
});

describe("errors, retries, and the hold", () => {
  it("requeues on a checker error below the attempt cap and keeps the action running for the next landing", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "error", error_reason: "timeout" });
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ verdict: "error", outcome: "requeued" });
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "queued" });
    expect(state.audits).toHaveLength(0);
    expect(state.recorded).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
  });

  it("moves to check_error at the cap, holding the queue, and requests a prize_check_error audit", async () => {
    const config = loadConfig();
    state.claim = queuedClaim({ check_attempts: config.prizeCheckMaxAttempts - 1 });
    const fake = new FakeLeanCheckerClient();
    fake.scriptDefault({ verdict: "error", error_reason: "oom" });
    await processNextPrizeCheck({ client: fake });
    expect(state.transitions.at(-1)).toMatchObject({ from: "checking", to: "check_error" });
    expect(state.audits[0]).toMatchObject({ auditType: "anomaly_investigation", triggeredBy: "prize_check_error", dedupeKey: "prize_check_error:pc-1" });
    expect(state.completed[0]).toMatchObject({ id: "act-1" });
  });

  it("treats an unreachable checker as an error too", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.submitCheck = async () => {
      throw new Error("checker unreachable");
    };
    const r = await processNextPrizeCheck({ client: fake });
    expect(r).toMatchObject({ verdict: "error", error: /unreachable/ });
    expect(state.transitions.at(-1)).toMatchObject({ to: "queued" });
  });
});

describe("the sweeps", () => {
  it("re-invokes the Steward on a claim the audit sent back, with the note, clearing the mark first", async () => {
    state.claim = queuedClaim({ status: "in_review", audit_outcome: "send_back" });
    state.sentBack = [{ id: "pc-1", claim_id: "claim-1" }];
    state.sendBackNote = "prize claim pc-1: audit outcome send_back: served by a fallback model";
    const r = await processNextPrizeCheck({ client: new FakeLeanCheckerClient() });
    expect(r).toMatchObject({ status: "processed", prizeClaimId: "pc-1", verdict: "send_back", outcome: "in_review" });
    expect(state.fieldUpdates[0]).toEqual({ id: "pc-1", set: { auditOutcome: null }, action: "steward_reinvoked" });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_claim", claimId: "claim-1", jobId: "job-reserve" });
    expect(String(state.steward[0]!.context)).toMatch(/sent the previous acceptance back \(audit outcome send_back: served by a fallback model\)/);
    expect(String(state.steward[0]!.context)).toMatch(/decide again with decide_prize_claim/);
  });

  it("re-invokes the Steward on a claim in review for over 24 hours without a decision, bumping updated_at so it happens once a day", async () => {
    state.claim = queuedClaim({ status: "in_review" });
    state.staleInReview = [{ id: "pc-1" }];
    const r = await processNextPrizeCheck({ client: new FakeLeanCheckerClient() });
    expect(r).toMatchObject({ status: "processed", prizeClaimId: "pc-1", verdict: "in_review_stale", outcome: "in_review" });
    const select = state.sql.find((q) => q.includes("steward_decision IS NULL"))!;
    expect(select).toContain("status = 'in_review'");
    expect(select).toContain("audit_outcome IS DISTINCT FROM 'send_back'");
    expect(select).toContain("updated_at < now() - interval '24 hours'");
    expect(select).toContain("LIMIT 1");
    expect(state.fieldUpdates[0]).toEqual({ id: "pc-1", set: {}, action: "steward_reinvoked" });
    expect(String(state.steward[0]!.context)).toMatch(/still undecided/);
  });

  it("reviews a checked claim whose Reviewer run was lost, under the reserve, claiming it first", async () => {
    state.claim = queuedClaim({ status: "checked" });
    state.pendingReview = [{ id: "pc-1", contribution_id: "co-1" }];
    state.reviewerAdmits = true;
    const r = await processNextPrizeCheck({ client: new FakeLeanCheckerClient() });
    expect(r).toMatchObject({ status: "processed", prizeClaimId: "pc-1", verdict: "review_recovered", outcome: "in_review" });
    const select = state.sql.find((q) => q.includes("c.review_status = 'pending'"))!;
    expect(select).toContain("c.contribution_type = 'claim_prize'");
    expect(select).toContain("c.review_attempts < 3");
    expect(state.contributionUpdates[0]).toContain("review_claimed_at = now(), review_attempts = review_attempts + 1");
    expect(state.reviewerCtx).toMatchObject({ jobId: "job-reserve", userId: "platform" });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_claim" });
    expect(state.completed[0]).toMatchObject({ id: "act-1", job: "job-reserve" });
  });
});
