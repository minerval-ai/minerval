import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The attempt service (docs/mathematics.md §7.3, §7.7, §7.9, §8.1): the
 * pure helpers, opening an attempt behind the lifetime cap and the
 * one-running-attempt rule, the close that moves an open bounty to
 * house_result_pending in the same transaction as the attempt's close,
 * publication that waits on that bounty, the read model's opacity on a
 * bounty-bearing claim, and the Steward's mechanical close.
 */
const state = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; params: unknown[]; tx: number }>,
  txCount: 0,
  attempt: null as null | Record<string, unknown>,
  running: false,
  spent: 0,
  check: null as null | Record<string, unknown>,
  bounty: null as null | { id: string; status: string },
  livePrizeClaims: [] as Array<{ id: string; status: string; submitted_at: Date }>,
  publishedRows: [] as Array<{ id: string; published_at: Date | null }>,
  policy: { attempt_claim_lifetime_cap_owls: 500, est_attempt_max_cost_owls: 150, est_attempt_standard_cost_owls: 60 },
}));

const ATTEMPT_ID = "a1a1a1a1-0000-4000-8000-000000000001";
const CLAIM_ID = "c1c1c1c1-0000-4000-8000-000000000001";
const FORM_ID = "f1f1f1f1-0000-4000-8000-000000000001";

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    claim_id: CLAIM_ID,
    formalization_id: FORM_ID,
    action_id: "ac1",
    run_id: "run-1",
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
    ceiling_micro_usd: "187500000",
    spent_micro_usd: "0",
    turns: 0,
    compactions: 0,
    served_models: null,
    published_at: null,
    started_at: new Date("2026-09-01T00:00:00Z"),
    heartbeat_at: null,
    finished_at: null,
    error: null,
    ...over,
  };
}

async function handle(q: string, params: unknown[] = [], tx = 0): Promise<unknown[]> {
  state.queries.push({ q, params, tx });
  const s = q.replace(/\s+/g, " ");
  if (/FROM proof_attempts WHERE formalization_id = \$1 AND status IN \('running', 'cancelling'\)/.test(s)) {
    return state.running ? [{ id: "other" }] : [];
  }
  if (/FROM llm_usage WHERE claim_id = \$1 AND agent = 'math_solver'/.test(s)) {
    return [{ spent: state.spent }];
  }
  if (/INSERT INTO proof_attempts/.test(s)) {
    return [
      attemptRow({
        claim_id: params[0],
        formalization_id: params[1],
        action_id: params[2],
        grant_id: params[3],
        job_id: params[4],
        model: params[5],
        variant: params[6],
        effort: params[7],
        is_calibration: params[8],
        ceiling_micro_usd: params[9],
      }),
    ];
  }
  if (/FROM proof_attempts WHERE id = \$1 FOR UPDATE/.test(s)) {
    return state.attempt ? [state.attempt] : [];
  }
  if (/FROM proof_attempts WHERE id = \$1/.test(s) && /SELECT\s+id, claim_id/.test(s)) {
    return state.attempt ? [state.attempt] : [];
  }
  if (/SELECT id, verdict FROM lean_checks/.test(s)) {
    return state.check && state.check.id === params[0] ? [state.check] : [];
  }
  if (/FROM lean_checks WHERE id = \$1 AND attempt_id = \$2/.test(s)) {
    return state.check && state.check.id === params[0] ? [state.check] : [];
  }
  if (/UPDATE proof_attempts SET status = \$2, outcome = \$3/.test(s)) {
    return [
      attemptRow({
        ...(state.attempt ?? {}),
        status: params[1],
        outcome: params[2],
        report: params[3] ? JSON.parse(params[3] as string) : null,
        lean_proof: params[4],
        lean_check_id: params[5],
        error: params[6],
        spent_micro_usd: params[7] ?? "0",
        finished_at: new Date(),
      }),
    ];
  }
  if (/UPDATE bounties SET status = 'house_result_pending'/.test(s)) {
    return state.bounty && state.bounty.status === "open" ? [{ id: state.bounty.id }] : [];
  }
  if (/UPDATE proof_attempts p SET published_at/.test(s)) {
    return state.publishedRows;
  }
  if (/SELECT id, status FROM bounties WHERE formalization_id = \$1 AND status IN \('house_result_pending', 'open'\)/.test(s)) {
    return state.bounty ? [state.bounty] : [];
  }
  if (/FROM prize_claims WHERE bounty_id = \$1 AND status <> ALL/.test(s)) {
    return state.livePrizeClaims;
  }
  if (/SELECT published_at FROM proof_attempts/.test(s)) {
    return [{ published_at: new Date("2026-09-02T00:00:00Z") }];
  }
  if (/UPDATE proof_attempts SET status = 'cancelling'/.test(s)) {
    return state.attempt && state.attempt.status === "running"
      ? [attemptRow({ status: "cancelling" })]
      : [];
  }
  return [];
}

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn((q: string, params?: unknown[]) => handle(q, params, 0)),
  withTransaction: vi.fn(async (fn: (tx: { query: (q: string, p?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
    const id = ++state.txCount;
    return fn({ query: (q, p) => handle(q, p, id) });
  }),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    owlCostMicroUsd: 1_000_000,
    attemptOverageFraction: 0.25,
    solverModel: "claude-fable-5-1",
  }),
}));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getMandateAllocationPolicy: vi.fn(async () => state.policy),
  getEffectiveAllocationPolicy: vi.fn(async () => state.policy),
}));
vi.mock("../../../src/services/cost-estimate-service.js", () => ({
  estimateSolverAttemptCostMicroUsd: vi.fn(async ({ variant }: { variant: string }) =>
    variant === "max" ? 150_000_000 : 60_000_000
  ),
}));

import {
  attemptCeilingMicroUsd,
  cancelAttempt,
  closeAttempt,
  effortForVariant,
  lifetimeCapMicroUsd,
  markProblemSolvedByPlatform,
  openAttempt,
  parseAttemptGroup,
  publishAttempt,
  publicReport,
  serializeAttemptSummary,
  type AttemptRow,
  type FormalizationRow,
} from "../../../src/services/attempt-service.js";

const formalization: FormalizationRow = {
  id: FORM_ID,
  claim_id: CLAIM_ID,
  version: 1,
  status: "published",
  pin_id: "mathlib-v4.33.0",
  lean_toolchain: "leanprover/lean4:v4.33.0",
  mathlib_rev: "0".repeat(40),
  mathlib_tag: null,
  image_digest: "sha256:x",
  namespace: "Minerval.S0a1b2c3d_v1",
  statement_source: "def Statement : Prop := True",
  source_hash: "src",
  expr_hash: "expr",
  pp_type: "True",
  correspondence: null,
  published_at: new Date(),
  review_period_ends_at: null,
};

beforeEach(() => {
  state.queries = [];
  state.txCount = 0;
  state.attempt = null;
  state.running = false;
  state.spent = 0;
  state.check = null;
  state.bounty = null;
  state.livePrizeClaims = [];
  state.publishedRows = [];
});

describe("pure helpers", () => {
  it("maps the variant to its effort", () => {
    expect(effortForVariant("standard")).toBe("high");
    expect(effortForVariant("max")).toBe("max");
  });

  it("computes the ceiling as cost_est × (1 + overage)", () => {
    expect(attemptCeilingMicroUsd(150_000_000, 0.25)).toBe(187_500_000);
    expect(attemptCeilingMicroUsd(150_000_000)).toBe(187_500_000);
    expect(attemptCeilingMicroUsd(0)).toBe(1);
  });

  it("parses the attempt group", () => {
    expect(parseAttemptGroup(`attempt:${FORM_ID}:3`)).toEqual({ formalizationId: FORM_ID, epoch: 3 });
    expect(parseAttemptGroup(`assess:${CLAIM_ID}`)).toBeNull();
  });

  it("bounds the plan item's lifetime cap at twice the policy key", () => {
    expect(lifetimeCapMicroUsd(500)).toBe(500_000_000);
    expect(lifetimeCapMicroUsd(500, 800)).toBe(800_000_000);
    expect(lifetimeCapMicroUsd(500, 5_000)).toBe(1_000_000_000);
    expect(lifetimeCapMicroUsd(500, null)).toBe(500_000_000);
  });

  it("serializes an unpublished attempt on a bounty-bearing claim without its outcome, report, or notebook", () => {
    const row = {
      ...attemptRow({
        status: "completed",
        outcome: "proof",
        report: { informal_argument: "x", approaches_tried: ["a"], obstruction: "o", what_would_help: "w", confidence: 0.9, validation: {} },
        notebook: { plan: "p" },
        finished_at: new Date("2026-09-01T01:00:00Z"),
      }),
      ceiling_micro_usd: 1,
      spent_micro_usd: 5,
    } as unknown as AttemptRow;
    const opaque = serializeAttemptSummary(row, { bountyBearing: true });
    expect(opaque).toMatchObject({
      id: ATTEMPT_ID,
      variant: "max",
      status: "completed",
      outcome: null,
      report: null,
      notebook: null,
      spent_micro_usd: 5,
      finished_at: "2026-09-01T01:00:00.000Z",
      published_at: null,
    });
    const open = serializeAttemptSummary(row, { bountyBearing: false });
    expect(open.outcome).toBe("proof");
    expect(open.report).toBeNull();
    const published = serializeAttemptSummary(
      { ...row, published_at: new Date("2026-09-03T00:00:00Z") },
      { bountyBearing: true }
    );
    expect(published.outcome).toBe("proof");
    expect(published.report).toEqual({
      informal_argument: "x",
      approaches_tried: ["a"],
      obstruction: "o",
      what_would_help: "w",
      confidence: 0.9,
    });
    expect(published.notebook).toEqual({ plan: "p" });
  });

  it("publicReport keeps only the public fields", () => {
    expect(publicReport(null)).toBeNull();
    expect(publicReport({ informal_argument: "a", lean_proof: "secret", confidence: "0.5" })).toEqual({
      informal_argument: "a",
      approaches_tried: [],
      obstruction: "",
      what_would_help: "",
      confidence: 0.5,
    });
  });
});

describe("openAttempt", () => {
  const action = { id: "ac1", variant: "max", cost_est_micro_usd: 150_000_000 };

  it("refuses a statement that is not published", async () => {
    const r = await openAttempt({
      action,
      claimId: CLAIM_ID,
      formalization: { ...formalization, status: "retired" },
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
  });

  it("refuses while another attempt runs on the statement", async () => {
    state.running = true;
    const r = await openAttempt({ action, claimId: CLAIM_ID, formalization });
    expect(r).toMatchObject({ ok: false, code: "ALREADY_RUNNING" });
  });

  it("refuses past the claim's lifetime cap, honoring the plan item's raised cap", async () => {
    state.spent = 500_000_000;
    const r = await openAttempt({ action, claimId: CLAIM_ID, formalization, grantId: "g1" });
    expect(r).toMatchObject({ ok: false, code: "LIFETIME_CAP" });
    const raised = await openAttempt({
      action,
      claimId: CLAIM_ID,
      formalization,
      grantId: "g1",
      planItem: { action: "attempt_proof", claim_id: CLAIM_ID, rationale: "r", lifetime_cap_owls: 900 },
    });
    expect(raised.ok).toBe(true);
  });

  it("opens the row with the variant's effort, the action's ceiling, and the calibration flag", async () => {
    const r = await openAttempt({
      action,
      claimId: CLAIM_ID,
      formalization,
      grantId: "g1",
      jobId: "job-1",
      planItem: { action: "attempt_proof", claim_id: CLAIM_ID, rationale: "r", is_calibration: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costEstMicroUsd).toBe(150_000_000);
    expect(r.attempt).toMatchObject({
      claim_id: CLAIM_ID,
      formalization_id: FORM_ID,
      action_id: "ac1",
      grant_id: "g1",
      job_id: "job-1",
      model: "claude-fable-5-1",
      variant: "max",
      effort: "max",
      is_calibration: true,
      ceiling_micro_usd: 187_500_000,
    });
    const insert = state.queries.find((x) => /INSERT INTO proof_attempts/.test(x.q))!;
    expect(insert.params[9]).toBe(187_500_000);
  });

  it("falls back to the estimator when the action carries no estimate", async () => {
    const r = await openAttempt({
      action: { id: "ac1", variant: "standard", cost_est_micro_usd: 0 },
      claimId: CLAIM_ID,
      formalization,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costEstMicroUsd).toBe(60_000_000);
    expect(r.attempt.effort).toBe("high");
    expect(r.attempt.ceiling_micro_usd).toBe(75_000_000);
  });
});

describe("closeAttempt", () => {
  it("moves an open bounty to house_result_pending in the same transaction when the close carries an accepted check", async () => {
    state.attempt = attemptRow();
    state.check = { id: "chk-1", verdict: "accepted" };
    state.bounty = { id: "b1", status: "open" };
    const r = await closeAttempt(ATTEMPT_ID, {
      status: "completed",
      outcome: "proof",
      report: { outcome: "proof" },
      leanProof: "p",
      leanCheckId: "chk-1",
      spentMicroUsd: 12_000_000,
    });
    expect(r).not.toBeNull();
    expect(r!.bountyMoved).toBe("b1");
    expect(r!.attempt.status).toBe("completed");
    expect(r!.attempt.lean_check_id).toBe("chk-1");
    const tx = state.queries.filter((x) => x.tx === 1);
    expect(tx.length).toBeGreaterThan(0);
    expect(tx.some((x) => /UPDATE proof_attempts SET status = \$2/.test(x.q.replace(/\s+/g, " ")))).toBe(true);
    const bountyUpdate = tx.find((x) => /UPDATE bounties/.test(x.q))!;
    expect(bountyUpdate.q).toMatch(/house_result_pending/);
    expect(bountyUpdate.q).toMatch(/status = 'open'/);
    expect(bountyUpdate.params).toEqual([FORM_ID]);
    // Every statement ran under the one transaction.
    expect(state.queries.every((x) => x.tx === 1)).toBe(true);
  });

  it("moves no bounty for a rejected check, a check from another attempt, or a non-completed close", async () => {
    state.attempt = attemptRow();
    state.bounty = { id: "b1", status: "open" };
    state.check = { id: "chk-1", verdict: "rejected" };
    let r = await closeAttempt(ATTEMPT_ID, { status: "completed", outcome: "partial", leanCheckId: "chk-1" });
    expect(r!.bountyMoved).toBeNull();
    expect(r!.attempt.lean_check_id).toBeNull();
    expect(state.queries.some((x) => /UPDATE bounties/.test(x.q))).toBe(false);

    state.queries = [];
    state.check = { id: "chk-1", verdict: "accepted" };
    r = await closeAttempt(ATTEMPT_ID, { status: "stale_formalization", outcome: "proof", leanCheckId: "chk-1" });
    expect(r!.bountyMoved).toBeNull();
    expect(state.queries.some((x) => /UPDATE bounties/.test(x.q))).toBe(false);

    state.queries = [];
    r = await closeAttempt(ATTEMPT_ID, { status: "completed", outcome: "proof", leanCheckId: "chk-other" });
    expect(r!.bountyMoved).toBeNull();
    expect(r!.attempt.lean_check_id).toBeNull();
  });

  it("is a no-op on an attempt already closed", async () => {
    state.attempt = attemptRow({ status: "completed", outcome: "negative" });
    const r = await closeAttempt(ATTEMPT_ID, { status: "cancelled" });
    expect(r!.attempt.status).toBe("completed");
    expect(state.queries.some((x) => /UPDATE proof_attempts/.test(x.q))).toBe(false);
  });

  it("returns null for an unknown attempt", async () => {
    expect(await closeAttempt(ATTEMPT_ID, { status: "failed" })).toBeNull();
  });
});

describe("publishAttempt", () => {
  it("guards on a closed attempt and no undecided house_result_pending bounty", async () => {
    state.publishedRows = [{ id: ATTEMPT_ID, published_at: new Date() }];
    expect(await publishAttempt(ATTEMPT_ID)).toBe(true);
    const q = state.queries[0]!.q.replace(/\s+/g, " ");
    expect(q).toMatch(/status NOT IN \('running', 'cancelling'\)/);
    expect(q).toMatch(/NOT EXISTS \(SELECT 1 FROM bounties b WHERE b.formalization_id = p.formalization_id AND b.status = 'house_result_pending'\)/);
    expect(q).toMatch(/COALESCE\(p.published_at, now\(\)\)/);
    state.publishedRows = [];
    expect(await publishAttempt(ATTEMPT_ID)).toBe(false);
  });
});

describe("cancelAttempt", () => {
  it("moves a running attempt to cancelling and nothing else", async () => {
    state.attempt = attemptRow();
    expect((await cancelAttempt(ATTEMPT_ID))!.status).toBe("cancelling");
    state.attempt = attemptRow({ status: "completed" });
    expect(await cancelAttempt(ATTEMPT_ID)).toBeNull();
  });
});

describe("markProblemSolvedByPlatform", () => {
  const input = { formalizationId: FORM_ID, attemptId: ATTEMPT_ID, leanCheckId: "chk-1", reason: "faithful" };
  const acceptedCheck = () => ({
    id: "chk-1",
    formalization_id: FORM_ID,
    attempt_id: ATTEMPT_ID,
    kind: "proof",
    mode: "attempt",
    verdict: "accepted",
    submission_sha256: "s",
    submission_source: "p",
    checks: {},
    diagnostics: [],
    truncated: false,
    resource: {},
    pin_id: "p",
    image_digest: "d",
    checker_version: "v",
    cost_micro_usd: 0,
    created_at: new Date(),
    finished_at: null,
  });

  it("refuses a partial result, a mismatched statement, a foreign or unaccepted check, and a kind mismatch", async () => {
    state.attempt = attemptRow({ status: "completed", outcome: "partial" });
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "NOT_A_RESULT" });

    state.attempt = attemptRow({ status: "completed", outcome: "proof", formalization_id: "other" });
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "FORMALIZATION_MISMATCH" });

    state.attempt = attemptRow({ status: "budget", outcome: null });
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "ATTEMPT_NOT_COMPLETED" });

    state.attempt = attemptRow({ status: "completed", outcome: "proof" });
    state.check = null;
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "CHECK_NOT_FOUND" });

    state.check = { ...acceptedCheck(), verdict: "rejected" };
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "CHECK_NOT_ACCEPTED" });

    state.check = { ...acceptedCheck(), kind: "disproof" };
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "CHECK_KIND_MISMATCH" });

    state.attempt = null;
    expect(await markProblemSolvedByPlatform(input)).toMatchObject({ ok: false, code: "ATTEMPT_NOT_FOUND" });
    expect(state.queries.some((x) => /UPDATE bounties/.test(x.q))).toBe(false);
  });

  it("closes the bounty as resolved_internally with the note and publishes the attempt, in one transaction", async () => {
    state.attempt = attemptRow({ status: "completed", outcome: "proof", lean_check_id: "chk-1" });
    state.check = acceptedCheck();
    state.bounty = { id: "b1", status: "house_result_pending" };
    state.publishedRows = [{ id: ATTEMPT_ID, published_at: new Date() }];
    const r = await markProblemSolvedByPlatform(input);
    expect(r).toMatchObject({
      ok: true,
      attempt_id: ATTEMPT_ID,
      formalization_id: FORM_ID,
      lean_check_id: "chk-1",
      outcome: "proof",
      bounty: { id: "b1", status: "resolved_internally", previous_status: "house_result_pending" },
      published_at: "2026-09-02T00:00:00.000Z",
    });
    const tx = state.queries.filter((x) => x.tx === 1);
    const bountyUpdate = tx.find((x) => /UPDATE bounties/.test(x.q))!;
    expect(bountyUpdate.q).toMatch(/resolved_internally/);
    expect(bountyUpdate.q).toMatch(/resolved_at = now\(\)/);
    expect(bountyUpdate.params).toEqual(["b1", "faithful"]);
    expect(tx.some((x) => /UPDATE proof_attempts p SET published_at/.test(x.q.replace(/\s+/g, " ")))).toBe(true);
  });

  it("refuses while a human prize claim filed earlier is live on the bounty, naming it (§8.1)", async () => {
    state.attempt = attemptRow({ status: "completed", outcome: "proof", lean_check_id: "chk-1" });
    state.check = acceptedCheck();
    state.bounty = { id: "b1", status: "house_result_pending" };
    state.livePrizeClaims = [{ id: "pc-early", status: "in_review", submitted_at: new Date("2026-08-30T12:00:00Z") }];
    const r = await markProblemSolvedByPlatform(input);
    expect(r).toMatchObject({
      ok: false,
      code: "HUMAN_CLAIM_PENDING",
      message: /pc-early in_review, filed 2026-08-30T12:00:00.000Z/,
      pending_prize_claims: [{ id: "pc-early", status: "in_review", submitted_at: "2026-08-30T12:00:00.000Z" }],
    });
    expect(String((r as { message: string }).message)).toMatch(/judged first/);
    expect(state.queries.some((x) => /UPDATE bounties/.test(x.q))).toBe(false);
    expect(state.queries.some((x) => /UPDATE proof_attempts p SET published_at/.test(x.q.replace(/\s+/g, " ")))).toBe(false);
    // The terminal statuses do not hold it: the query excludes exactly the six.
    const select = state.queries.find((x) => /FROM prize_claims WHERE bounty_id/.test(x.q.replace(/\s+/g, " ")))!;
    expect(select.params).toEqual(["b1", ["paid", "rejected", "voided", "withdrawn", "superseded", "forfeited"]]);
  });

  it("publishes even when no live bounty is bound", async () => {
    state.attempt = attemptRow({ status: "completed", outcome: "disproof" });
    state.check = { ...acceptedCheck(), kind: "disproof" };
    state.bounty = null;
    state.publishedRows = [{ id: ATTEMPT_ID, published_at: new Date() }];
    const r = await markProblemSolvedByPlatform(input);
    expect(r).toMatchObject({ ok: true, bounty: null, outcome: "disproof" });
  });
});
