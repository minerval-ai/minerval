/**
 * The attempt lifecycle against real Postgres (docs/mathematics.md §7.3,
 * §7.7, §7.9, §8.1): opening behind the lifetime cap and the one-running
 * rule, the per-turn heartbeat, the notebook, the check rows the harness
 * records, the close that moves an open bounty to house_result_pending in
 * the same transaction, publication that waits on that bounty, the
 * Steward's mechanical close, the operator's cancel and pause switches,
 * the read model's opacity on a bounty-bearing claim, the transcript, and
 * the solver's cost series keyed by run_id.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery, withTransaction } from "../../src/db/client.js";
import {
  cancelAttempt,
  claimLifetimeAttemptSpendMicroUsd,
  closeAttempt,
  getAttempt,
  getAttemptForSteward,
  getAttemptPublic,
  getAttemptTranscript,
  listPriorAttempts,
  markProblemSolvedByPlatform,
  openAttempt,
  publishAttempt,
  readAttemptStatus,
  readNotebook,
  readSolverPaused,
  recordAttemptLeanCheck,
  setSolverPaused,
  sweepOrphanedAttempts,
  updateAttemptProgress,
  writeNotebookSection,
  type FormalizationRow,
} from "../../src/services/attempt-service.js";
import { loadAttemptExtras } from "../../src/services/attempt-extras.js";
import {
  estimateSolverAttemptCostMicroUsd,
  resetCostEstimateCache,
} from "../../src/services/cost-estimate-service.js";
import {
  checkSolverBudget,
  solverDailyCapMicroUsd,
  solverSpentTodayMicroUsd,
} from "../../src/llm/solver-budget.js";
import { seedClaim, seedAction, seedUser, seedGrantWithJob, OWL } from "./helpers.js";

async function seedFormalization(claimId: string, status = "published"): Promise<FormalizationRow> {
  const rows = await rawQuery<FormalizationRow>(
    `INSERT INTO claim_formalizations
       (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
        namespace, statement_source, source_hash, expr_hash, pp_type,
        constants, definitions_axioms, witness_present, status, authored_by,
        correspondence, published_at)
     VALUES ($1, 1, 'mathlib-v4.33.1', 'leanprover/lean4:v4.33.1', $2,
             'sha256:img', $3, 'def Statement : Prop := True', $4, $5,
             'True', '[]', '[]', false, $6, 'claim_steward', 'exact', now())
     RETURNING id, claim_id, version, status, pin_id, lean_toolchain, mathlib_rev,
               mathlib_tag, image_digest, namespace, statement_source, source_hash,
               expr_hash, pp_type, correspondence, published_at, review_period_ends_at`,
    [
      claimId,
      randomUUID().replace(/-/g, ""),
      `Minerval.S${randomUUID().slice(0, 8)}_v1`,
      `src-${randomUUID()}`,
      `expr-${randomUUID()}`,
      status,
    ]
  );
  return rows[0]!;
}

/** The mandate a bounty holds against (§8.1). */
async function seedPostingMandate(): Promise<string> {
  const funder = await seedUser("attempts-bounty-mandate");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 2_500_000_000 });
  return grantId;
}

async function seedBounty(claimId: string, formalizationId: string, status = "open"): Promise<string> {
  const grantId = await seedPostingMandate();
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO bounties
       (claim_id, formalization_id, posted_by_grant_id, amount_micro_usd, status,
        rules_version, rationale, opened_at)
     VALUES ($1, $2, $3, 500000000, $4, 'rules-v1', 'DB-test bounty', now())
     RETURNING id`,
    [claimId, formalizationId, grantId, status]
  );
  return rows[0]!.id;
}

async function bountyStatus(id: string): Promise<{ status: string; resolved_at: Date | null; resolution_note: string | null }> {
  const [row] = await rawQuery<{ status: string; resolved_at: Date | null; resolution_note: string | null }>(
    `SELECT status, resolved_at, resolution_note FROM bounties WHERE id = $1`,
    [id]
  );
  return row!;
}

/** A claim with a published statement and a covered attempt_proof action. */
async function fixture(label: string) {
  const claimId = await seedClaim(label);
  const formalization = await seedFormalization(claimId);
  const actionId = await seedAction({
    group: `attempt:${formalization.id}:1`,
    variant: "max",
    kind: "attempt_proof",
    costMicroUsd: 150 * OWL,
    status: "running",
    claimId,
  });
  return { claimId, formalization, actionId };
}

async function open(f: Awaited<ReturnType<typeof fixture>>, over: Record<string, unknown> = {}) {
  const r = await openAttempt({
    action: { id: f.actionId, variant: "max", cost_est_micro_usd: 150 * OWL },
    claimId: f.claimId,
    formalization: f.formalization,
    ...over,
  });
  if (!r.ok) throw new Error(`open failed: ${r.code} ${r.message}`);
  return r.attempt;
}

const acceptedCheck = (attemptId: string, formalizationId: string, over: Record<string, unknown> = {}) => ({
  attemptId,
  formalizationId,
  kind: "proof" as const,
  submissionSha256: `sha-${randomUUID()}`,
  submissionSource: "theorem proof : Statement := trivial",
  verdict: "accepted" as const,
  checks: { compile: { status: "pass" } },
  diagnostics: [],
  truncated: false,
  resource: { wall_ms: 30_000 },
  pinId: "mathlib-v4.33.1",
  imageDigest: "sha256:img",
  checkerVersion: "1.0.0",
  costMicroUsd: 21_667,
  ...over,
});

describe("opening an attempt", () => {
  it("opens with the variant's effort, the ceiling from the action's estimate, and the funding ids", async () => {
    const f = await fixture("open");
    const attempt = await open(f, { grantId: null, jobId: null });
    expect(attempt).toMatchObject({
      claim_id: f.claimId,
      formalization_id: f.formalization.id,
      action_id: f.actionId,
      variant: "max",
      effort: "max",
      status: "running",
      is_calibration: false,
      ceiling_micro_usd: Math.round(150 * OWL * 1.25),
      spent_micro_usd: 0,
      turns: 0,
    });
    expect(attempt.model).toMatch(/^claude-/);
  });

  it("refuses a second running attempt on the statement, and a statement that is not published", async () => {
    const f = await fixture("open-running");
    await open(f);
    const again = await openAttempt({
      action: { id: f.actionId, variant: "standard", cost_est_micro_usd: 60 * OWL },
      claimId: f.claimId,
      formalization: f.formalization,
    });
    expect(again).toMatchObject({ ok: false, code: "ALREADY_RUNNING" });

    const draft = await seedFormalization(await seedClaim("open-draft"), "draft");
    const notPublished = await openAttempt({
      action: { id: f.actionId, variant: "standard", cost_est_micro_usd: 60 * OWL },
      claimId: draft.claim_id,
      formalization: draft,
    });
    expect(notPublished).toMatchObject({ ok: false, code: "NOT_PUBLISHED" });
  });

  it("refuses past the claim's lifetime solver spend, which is SUM(llm_usage) for math_solver on the claim", async () => {
    const f = await fixture("open-cap");
    await rawQuery(
      `INSERT INTO llm_usage (model, agent, cost_micro_usd, claim_id)
       VALUES ('claude-fable-5-1', 'math_solver', $1, $2),
              ('claude-fable-5-1', 'steward', $1, $2)`,
      [500 * OWL, f.claimId]
    );
    expect(await claimLifetimeAttemptSpendMicroUsd(f.claimId)).toBe(500 * OWL);
    const r = await openAttempt({
      action: { id: f.actionId, variant: "max", cost_est_micro_usd: 150 * OWL },
      claimId: f.claimId,
      formalization: f.formalization,
    });
    expect(r).toMatchObject({ ok: false, code: "LIFETIME_CAP" });
    // The plan item may raise the cap, bounded at twice the policy key.
    const raised = await openAttempt({
      action: { id: f.actionId, variant: "max", cost_est_micro_usd: 150 * OWL },
      claimId: f.claimId,
      formalization: f.formalization,
      planItem: { action: "attempt_proof", claim_id: f.claimId, rationale: "r", lifetime_cap_owls: 800, is_calibration: true },
    });
    expect(raised.ok).toBe(true);
    if (raised.ok) expect(raised.attempt.is_calibration).toBe(true);
  });
});

describe("the live attempt", () => {
  it("heartbeats the attempt and its action, keeps a notebook, and polls the operator's switches", async () => {
    const f = await fixture("live");
    const attempt = await open(f);
    const [before] = await rawQuery<{ updated_at: Date }>(`SELECT updated_at FROM actions WHERE id = $1`, [f.actionId]);
    await new Promise((r) => setTimeout(r, 5));
    await updateAttemptProgress({
      attemptId: attempt.id,
      actionId: f.actionId,
      turns: 3,
      spentMicroUsd: 1_234_567,
      servedModels: ["claude-fable-5-1"],
    });
    const row = (await getAttempt(attempt.id))!;
    expect(row.turns).toBe(3);
    expect(row.spent_micro_usd).toBe(1_234_567);
    expect(row.served_models).toEqual(["claude-fable-5-1"]);
    expect(row.heartbeat_at).not.toBeNull();
    const [after] = await rawQuery<{ updated_at: Date }>(`SELECT updated_at FROM actions WHERE id = $1`, [f.actionId]);
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());

    await writeNotebookSection(attempt.id, "plan", "induct on n");
    await writeNotebookSection(attempt.id, "dead end", "simp did nothing");
    await writeNotebookSection(attempt.id, "plan", "induct on n, then cases");
    expect(await readNotebook(attempt.id)).toEqual({
      plan: "induct on n, then cases",
      "dead end": "simp did nothing",
    });

    expect(await readAttemptStatus(attempt.id)).toBe("running");
    expect(await cancelAttempt(attempt.id)).toMatchObject({ status: "cancelling" });
    expect(await readAttemptStatus(attempt.id)).toBe("cancelling");
    expect(await cancelAttempt(attempt.id)).toBeNull();

    await setSolverPaused(true);
    try {
      expect(await readSolverPaused()).toBe(true);
    } finally {
      await setSolverPaused(false);
    }
    expect(await readSolverPaused()).toBe(false);
  });

  it("records the harness's check rows on the attempt, deduplicated by the table's constraint", async () => {
    const f = await fixture("checks");
    const attempt = await open(f);
    const input = acceptedCheck(attempt.id, f.formalization.id);
    const first = await recordAttemptLeanCheck(input);
    const second = await recordAttemptLeanCheck({ ...input, costMicroUsd: 1_000 });
    expect(second.id).toBe(first.id);
    expect(second.cost_micro_usd).toBe(22_667);
    const record = (await getAttemptForSteward(attempt.id))!;
    expect(record.lean_checks).toHaveLength(1);
    expect(record.lean_checks[0]).toMatchObject({ id: first.id, kind: "proof", verdict: "accepted" });
    expect(record.formalization).toMatchObject({ id: f.formalization.id, status: "published" });
    expect(record.transcript_tail).toBeUndefined();
  });
});

describe("closing an attempt and the bounty transition", () => {
  it("moves an open bounty to house_result_pending in the same transaction as the close", async () => {
    const f = await fixture("close-bounty");
    const bountyId = await seedBounty(f.claimId, f.formalization.id);
    const attempt = await open(f);
    const check = await recordAttemptLeanCheck(acceptedCheck(attempt.id, f.formalization.id));

    const closed = await closeAttempt(attempt.id, {
      status: "completed",
      outcome: "proof",
      report: { outcome: "proof", informal_argument: "trivial" },
      leanProof: "theorem proof : Statement := trivial",
      leanCheckId: check.id,
      spentMicroUsd: 7 * OWL,
      turns: 9,
    });
    expect(closed!.bountyMoved).toBe(bountyId);
    expect(closed!.attempt).toMatchObject({
      status: "completed",
      outcome: "proof",
      lean_check_id: check.id,
      spent_micro_usd: 7 * OWL,
      turns: 9,
    });
    expect(closed!.attempt.finished_at).not.toBeNull();
    expect((await bountyStatus(bountyId)).status).toBe("house_result_pending");

    // Publication waits on the undecided bounty.
    expect(await publishAttempt(attempt.id)).toBe(false);
    expect((await getAttempt(attempt.id))!.published_at).toBeNull();

    // The read model hides everything but the bare facts meanwhile.
    const [summary] = await loadAttemptExtras(f.claimId);
    expect(summary).toMatchObject({ id: attempt.id, status: "completed", outcome: null, report: null, notebook: null });
    const publicView = (await getAttemptPublic(attempt.id))!;
    expect(publicView.lean_proof).toBeNull();
    expect(publicView.lean_checks).toBeNull();

    // A second close is a no-op.
    const again = await closeAttempt(attempt.id, { status: "cancelled" });
    expect(again!.attempt.status).toBe("completed");
    expect(again!.bountyMoved).toBeNull();

    // The Steward's mechanical close: the bounty resolves internally with
    // the note, and the attempt publishes.
    const marked = await markProblemSolvedByPlatform({
      formalizationId: f.formalization.id,
      attemptId: attempt.id,
      leanCheckId: check.id,
      reason: "the checked proof is faithful to the claim",
    });
    expect(marked).toMatchObject({
      ok: true,
      bounty: { id: bountyId, status: "resolved_internally", previous_status: "house_result_pending" },
    });
    const b = await bountyStatus(bountyId);
    expect(b.status).toBe("resolved_internally");
    expect(b.resolved_at).not.toBeNull();
    expect(b.resolution_note).toBe("the checked proof is faithful to the claim");
    const published = (await getAttempt(attempt.id))!;
    expect(published.published_at).not.toBeNull();
    const [after] = await loadAttemptExtras(f.claimId);
    expect(after).toMatchObject({ outcome: "proof", report: { informal_argument: "trivial" } });
    expect((await getAttemptPublic(attempt.id))!.lean_proof).toBe("theorem proof : Statement := trivial");
  });

  it("leaves the bounty open when the check was rejected, and publishes after the Steward acts", async () => {
    const f = await fixture("close-rejected");
    const bountyId = await seedBounty(f.claimId, f.formalization.id);
    const attempt = await open(f);
    const check = await recordAttemptLeanCheck(
      acceptedCheck(attempt.id, f.formalization.id, { verdict: "rejected" })
    );
    const closed = await closeAttempt(attempt.id, {
      status: "completed",
      outcome: "partial",
      report: { outcome: "partial" },
      leanCheckId: check.id,
    });
    expect(closed!.bountyMoved).toBeNull();
    expect(closed!.attempt.lean_check_id).toBeNull();
    expect((await bountyStatus(bountyId)).status).toBe("open");
    expect(await publishAttempt(attempt.id)).toBe(true);
    expect((await getAttempt(attempt.id))!.published_at).not.toBeNull();
    // Idempotent: the timestamp does not move.
    const first = (await getAttempt(attempt.id))!.published_at!.getTime();
    expect(await publishAttempt(attempt.id)).toBe(true);
    expect((await getAttempt(attempt.id))!.published_at!.getTime()).toBe(first);
    // The mechanical close refuses a partial result.
    expect(
      await markProblemSolvedByPlatform({
        formalizationId: f.formalization.id,
        attemptId: attempt.id,
        leanCheckId: check.id,
        reason: "x",
      })
    ).toMatchObject({ ok: false, code: "NOT_A_RESULT" });
  });

  it("sweeps a live attempt with no heartbeat for three hours to orphaned, and leaves a live one alone", async () => {
    const f = await fixture("orphan");
    const dead = await open(f);
    await rawQuery(
      `UPDATE proof_attempts SET heartbeat_at = now() - interval '4 hours' WHERE id = $1`,
      [dead.id]
    );
    const g = await fixture("orphan-live");
    const live = await open(g);
    await updateAttemptProgress({ attemptId: live.id, turns: 1, spentMicroUsd: 1, servedModels: [] });
    const swept = await sweepOrphanedAttempts();
    expect(swept).toContain(dead.id);
    expect(swept).not.toContain(live.id);
    const row = (await getAttempt(dead.id))!;
    expect(row.status).toBe("orphaned");
    expect(row.finished_at).not.toBeNull();
    expect(row.error).toMatch(/no heartbeat for 3 hours/);
    expect((await getAttempt(live.id))!.status).toBe("running");
    // An attempt that never heartbeat is judged by its start.
    const h = await fixture("orphan-started");
    const stale = await open(h);
    await rawQuery(`UPDATE proof_attempts SET started_at = now() - interval '4 hours' WHERE id = $1`, [stale.id]);
    expect(await sweepOrphanedAttempts()).toContain(stale.id);
  });

  it("never publishes a running attempt, and a cancelling attempt closes as cancelled", async () => {
    const f = await fixture("close-cancel");
    const attempt = await open(f);
    expect(await publishAttempt(attempt.id)).toBe(false);
    await cancelAttempt(attempt.id);
    const closed = await closeAttempt(attempt.id, { status: "cancelled", error: "halted by the operator", spentMicroUsd: 3 * OWL });
    expect(closed!.attempt).toMatchObject({ status: "cancelled", error: "halted by the operator", spent_micro_usd: 3 * OWL });
    expect(await listPriorAttempts(f.formalization.id)).toHaveLength(1);
    expect(await publishAttempt(attempt.id)).toBe(true);
  });

  it("the close is one transaction: a failure after the attempt's update leaves the bounty untouched", async () => {
    const f = await fixture("close-atomic");
    const bountyId = await seedBounty(f.claimId, f.formalization.id);
    const attempt = await open(f);
    const check = await recordAttemptLeanCheck(acceptedCheck(attempt.id, f.formalization.id));
    // Drive the same statements the service issues, then fail before commit.
    await expect(
      withTransaction(async (tx) => {
        await tx.query(
          `UPDATE proof_attempts SET status = 'completed', outcome = 'proof', lean_check_id = $2, finished_at = now() WHERE id = $1`,
          [attempt.id, check.id]
        );
        await tx.query(
          `UPDATE bounties SET status = 'house_result_pending', updated_at = now()
            WHERE formalization_id = $1 AND status = 'open'`,
          [f.formalization.id]
        );
        throw new Error("induced failure before commit");
      })
    ).rejects.toThrow(/induced failure/);
    expect((await getAttempt(attempt.id))!.status).toBe("running");
    expect((await bountyStatus(bountyId)).status).toBe("open");
    // And the real close then lands both together.
    const closed = await closeAttempt(attempt.id, { status: "completed", outcome: "proof", leanCheckId: check.id });
    expect(closed!.bountyMoved).toBe(bountyId);
    expect((await getAttempt(attempt.id))!.status).toBe("completed");
    expect((await bountyStatus(bountyId)).status).toBe("house_result_pending");
  });
});

describe("the transcript and the cost series", () => {
  it("reads the attempt's transcript tail from agent_runs and agent_steps", async () => {
    const f = await fixture("transcript");
    const attempt = await open(f);
    const [run] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_runs (agent, claim_id) VALUES ('math_solver', $1) RETURNING id`,
      [f.claimId]
    );
    await rawQuery(`UPDATE proof_attempts SET run_id = $2 WHERE id = $1`, [attempt.id, run!.id]);
    for (let seq = 0; seq < 5; seq++) {
      await rawQuery(
        `INSERT INTO agent_steps (run_id, seq, kind, content) VALUES ($1, $2, $3, $4::jsonb)`,
        [run!.id, seq, seq % 2 === 0 ? "assistant" : "tool_results", JSON.stringify({ seq })]
      );
    }
    const tail = await getAttemptTranscript(run!.id, 2);
    expect(tail.map((s) => s.seq)).toEqual([3, 4]);
    const all = await getAttemptTranscript(run!.id);
    expect(all.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
    const record = (await getAttemptForSteward(attempt.id, { transcriptTail: 3 }))!;
    expect(record.transcript_tail!.map((s) => s.seq)).toEqual([2, 3, 4]);
    const publicView = (await getAttemptPublic(attempt.id, { includeTranscript: true }))!;
    expect(publicView.transcript!.length).toBe(5);
  });

  it("estimates the solver's cost from runs keyed by run_id, per variant, once five exist", async () => {
    resetCostEstimateCache();
    const model = `claude-fable-5-1-dbtest-${randomUUID().slice(0, 8)}`;
    const claimId = await seedClaim("estimate");
    const formalization = await seedFormalization(claimId);
    // Six max attempts on ONE claim at 10, 20, ..., 60 owls, each its own run.
    for (let i = 1; i <= 6; i++) {
      const [run] = await rawQuery<{ id: string }>(
        `INSERT INTO agent_runs (agent, claim_id) VALUES ('math_solver', $1) RETURNING id`,
        [claimId]
      );
      await rawQuery(
        `INSERT INTO proof_attempts
           (claim_id, formalization_id, run_id, model, variant, effort, status, ceiling_micro_usd)
         VALUES ($1, $2, $3, $4, 'max', 'max', 'completed', 1)`,
        [claimId, formalization.id, run!.id, model]
      );
      // Two rows per run: an LLM turn and a Lean check, summed per run.
      await rawQuery(
        `INSERT INTO llm_usage (model, agent, cost_micro_usd, claim_id, run_id)
         VALUES ($1, 'math_solver', $2, $3, $4), ('lean-checker/pin', 'math_solver', $5, $3, $4)`,
        [model, i * 10 * OWL - OWL, claimId, run!.id, OWL]
      );
    }
    const max = await estimateSolverAttemptCostMicroUsd({ model, variant: "max" });
    // p80 of 10..60 owls = 50 owls; a per-claim grouping would have seen one 210-owl run.
    expect(max).toBe(50 * OWL);
    // No standard runs yet: the prior.
    const standard = await estimateSolverAttemptCostMicroUsd({ model, variant: "standard" });
    expect(standard).toBe(60 * OWL);
  });

  it("the daily breaker sums today's math_solver rows and raises the budget error at the cap", async () => {
    const before = await solverSpentTodayMicroUsd();
    await rawQuery(
      `INSERT INTO llm_usage (model, agent, cost_micro_usd) VALUES ('claude-fable-5-1', 'math_solver', $1)`,
      [OWL]
    );
    expect(await solverSpentTodayMicroUsd()).toBe(before + OWL);
    // Push today's solver spend past the cap (400 owls by default), and the
    // breaker raises the budget error the worker treats as a rest.
    const cap = solverDailyCapMicroUsd();
    await rawQuery(
      `INSERT INTO llm_usage (model, agent, cost_micro_usd) VALUES ('claude-fable-5-1', 'math_solver', $1)`,
      [cap]
    );
    await expect(checkSolverBudget()).rejects.toMatchObject({
      name: "LlmBudgetExceededError",
      limitType: "solver_daily_cap_micro_usd",
      limitValue: cap,
    });
    // Rows from other agents, and from other days, never count.
    const spent = await solverSpentTodayMicroUsd();
    await rawQuery(
      `INSERT INTO llm_usage (model, agent, cost_micro_usd, created_at)
       VALUES ('claude-fable-5-1', 'steward', $1, now()),
              ('claude-fable-5-1', 'math_solver', $1, now() - interval '2 days')`,
      [cap]
    );
    expect(await solverSpentTodayMicroUsd()).toBe(spent);
  });
});

describe("the platform's record", () => {
  it("counts by outcome and variant with medians, splits novel proofs from rediscoveries, and narrows to a mandate", async () => {
    const {
      getAttemptStats,
      resetAttemptStatsCache,
    } = await import("../../src/services/attempt-stats-service.js");
    const { seedUser, seedGrantWithJob } = await import("./helpers.js");
    const funder = await seedUser("record-funder");
    const { grantId: mathGrant } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 1000 * OWL });
    const { grantId: otherGrant } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 1000 * OWL });

    // A closed attempt under a grant: the action carries the variant, the
    // close carries the outcome and the spend.
    async function closed(input: {
      grantId: string;
      variant: "standard" | "max";
      status?: "completed" | "refused" | "failed";
      outcome?: "proof" | "disproof" | "partial" | "negative" | null;
      spentOwls: number;
      calibration?: boolean;
      settledBefore?: boolean;
      accepted?: boolean;
    }) {
      const claimId = await seedClaim(`record-${input.variant}`);
      const formalization = await seedFormalization(claimId);
      if (input.settledBefore) {
        await rawQuery(
          `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, assessed_at)
           VALUES ($1, 'verified', 0.9, 'DB-test: settled before the attempt', now() - interval '1 day')`,
          [claimId]
        );
      }
      const actionId = await seedAction({
        group: `attempt:${formalization.id}:1`,
        variant: input.variant,
        kind: "attempt_proof",
        costMicroUsd: 100 * OWL,
        status: "running",
        claimId,
      });
      const r = await openAttempt({
        action: { id: actionId, variant: input.variant, cost_est_micro_usd: 100 * OWL },
        claimId,
        formalization,
        grantId: input.grantId,
        planItem: input.calibration
          ? { action: "attempt_proof", claim_id: claimId, rationale: "control", is_calibration: true }
          : null,
      });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      let leanCheckId: string | null = null;
      if (input.accepted) {
        const check = await recordAttemptLeanCheck(acceptedCheck(r.attempt.id, formalization.id));
        leanCheckId = check.id;
      }
      const c = await closeAttempt(r.attempt.id, {
        status: input.status ?? "completed",
        outcome: input.outcome ?? null,
        leanCheckId,
        spentMicroUsd: input.spentOwls * OWL,
      });
      if (input.status !== "refused" && input.status !== "failed") await publishAttempt(r.attempt.id);
      return { claimId, attemptId: r.attempt.id, close: c! };
    }

    const novel = await closed({ grantId: mathGrant, variant: "max", outcome: "proof", spentOwls: 40, accepted: true });
    const redis = await closed({ grantId: mathGrant, variant: "max", outcome: "disproof", spentOwls: 20, accepted: true, settledBefore: true });
    await closed({ grantId: mathGrant, variant: "max", outcome: "negative", spentOwls: 60 });
    await closed({ grantId: mathGrant, variant: "standard", outcome: "partial", spentOwls: 10 });
    await closed({ grantId: mathGrant, variant: "standard", status: "refused", spentOwls: 1 });
    const control = await closed({ grantId: mathGrant, variant: "standard", outcome: "proof", spentOwls: 5, calibration: true, accepted: true });
    // Another mandate's attempt never enters this mandate's record.
    await closed({ grantId: otherGrant, variant: "max", outcome: "proof", spentOwls: 99, accepted: true });
    // A live attempt is not part of the record, but it is counted as live.
    const live = await fixture("record-live");
    await open(live, { grantId: mathGrant });

    resetAttemptStatsCache();
    const stats = await getAttemptStats(mathGrant);
    expect(stats.grant_id).toBe(mathGrant);
    expect(stats.totals).toEqual({ attempts: 6, live: 1, owls_spent: 136, median_cost_owls: 15 });
    expect(stats.by_outcome).toEqual([
      { outcome: "proved", count: 2, owls_spent: 45, median_cost_owls: 22.5 },
      { outcome: "disproved", count: 1, owls_spent: 20, median_cost_owls: 20 },
      { outcome: "lead", count: 1, owls_spent: 10, median_cost_owls: 10 },
      { outcome: "no_result", count: 1, owls_spent: 60, median_cost_owls: 60 },
      { outcome: "refused", count: 1, owls_spent: 1, median_cost_owls: 1 },
    ]);
    expect(stats.by_variant).toEqual([
      { variant: "max", count: 3, settled: 2, owls_spent: 120, median_cost_owls: 40 },
      { variant: "standard", count: 3, settled: 1, owls_spent: 16, median_cost_owls: 5 },
    ]);
    expect(stats.calibration_series).toMatchObject({
      attempts: 1,
      passes: 1,
      pass_rate: 1,
      owls_spent: 5,
      cost_per_pass_owls: 5,
    });
    expect(stats.calibration_series.problems.map((p) => p.claim_id)).toEqual([control.claimId]);
    expect(stats.calibration).toBeNull();
    // The claim verified a day before the attempt closed is a rediscovery;
    // the open claim's checked proof is a novel proof; the control is neither.
    expect(stats.novel_proofs.count).toBe(1);
    expect(stats.novel_proofs.items[0]).toMatchObject({
      attempt_id: novel.attemptId,
      claim_id: novel.claimId,
      outcome: "proof",
      variant: "max",
      owls_spent: 40,
    });
    expect(stats.rediscoveries.items.map((i) => i.attempt_id).sort()).toEqual(
      [redis.attemptId, control.attemptId].sort()
    );

    // The platform-wide record includes the other mandate's attempt.
    resetAttemptStatsCache();
    const all = await getAttemptStats(null);
    expect(all.grant_id).toBeNull();
    expect(all.totals.attempts).toBeGreaterThanOrEqual(7);
    expect(all.novel_proofs.count).toBeGreaterThanOrEqual(2);

    // An unpublished result on a claim with a live bounty is withheld: on the
    // record's spend, under no outcome, in no list.
    const held = await fixture("record-held");
    await seedBounty(held.claimId, held.formalization.id, "open");
    const heldAttempt = await open(held, { grantId: mathGrant });
    const heldCheck = await recordAttemptLeanCheck(acceptedCheck(heldAttempt.id, held.formalization.id));
    await closeAttempt(heldAttempt.id, {
      status: "completed",
      outcome: "proof",
      leanCheckId: heldCheck.id,
      spentMicroUsd: 33 * OWL,
    });
    resetAttemptStatsCache();
    const withHeld = await getAttemptStats(mathGrant);
    expect(withHeld.totals.attempts).toBe(7);
    expect(withHeld.by_outcome.find((o) => o.outcome === "withheld")).toEqual({
      outcome: "withheld",
      count: 1,
      owls_spent: 33,
      median_cost_owls: 33,
    });
    expect(withHeld.by_outcome.find((o) => o.outcome === "proved")!.count).toBe(2);
    expect(withHeld.novel_proofs.items.map((i) => i.attempt_id)).not.toContain(heldAttempt.id);

    // The memo serves the computed record until it expires.
    const again = await getAttemptStats(mathGrant);
    expect(again).toBe(withHeld);
  });
});
