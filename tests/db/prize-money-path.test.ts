/**
 * The prize money path against real Postgres (docs/mathematics.md §12.4):
 * the partial unique indexes in use, the fund's three numbers with a bounty
 * that never opens beyond `available`, the debit writers consuming the
 * reservation, the reserve minted and released, the check queue's
 * per-statement serialization, payout idempotency, two racing acceptances
 * producing one accepted claim and two racing payouts producing one, and
 * the end-to-end path: deposit, bounty request and open, claim through the
 * gate, the fake checker accepting, admit, the Steward's accept, the audit
 * outcome, the window elapsed, the payee steps, the owl grant, and the
 * ledger invariants at every step.
 *
 * The Reviewer and the Steward are LLM runs; here the Reviewer's admit is
 * the worker calling admitPrizeClaim through a mocked agent, and the
 * Steward's accept is the service call the tool makes.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// The platform-wide daily cap and the per-statement cap are real rules the
// unit suite pins; this file files more than five claims in one run, so it
// lifts them before config loads.
vi.hoisted(() => {
  process.env.PRIZE_CLAIMS_PER_DAY_PLATFORM = "1000";
  process.env.PRIZE_CLAIMS_PER_STATEMENT_PER_30_DAYS = "100";
});
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedUser, seedClaim, pgCode, owlBalance, OWL } from "./helpers.js";
import { FakeLeanCheckerClient } from "../../src/services/lean-checker-fake.js";
import { loadConfig } from "../../src/config.js";

const stewardRuns = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    stewardRuns.push(input);
    return { model: "strong", billedMicroUsd: 250_000 };
  }),
}));
vi.mock("../../src/llm/agents/contribution-reviewer.js", () => ({
  runContributionReview: vi.fn(async (input: { contributionId: string }) => {
    const { admitPrizeClaim } = await import("../../src/services/prize-claim-service.js");
    const { meterLlmUsage } = await import("../../src/services/usage-service.js");
    await meterLlmUsage({ model: "claude-fable-5-1", inputTokens: 1000, outputTokens: 200 });
    await admitPrizeClaim({ contributionId: input.contributionId, review: { reasoning: "in order", confidence: 0.9, policyCitations: ["GF"] }, actor: "contribution_reviewer" });
  }),
}));

import {
  depositToPool,
  getOrCreatePool,
  poolNumbers,
  postFundDebit,
  postOwlPrizeDebit,
  poolReservedMicroUsd,
} from "../../src/services/prize-pool-service.js";
import {
  requestBounty,
  openBounty,
  getBountyById,
  getReserveJob,
  closeBounty,
  PRIZE_RULES_VERSION,
  getPlatformAccountId,
  usdToMicro,
} from "../../src/services/bounty-service.js";
import {
  filePrizeClaim,
  getPrizeClaimById,
  acceptPrizeClaim,
  recordPrizeAuditOutcome,
  promotePayable,
  promotionCheck,
  listPrizeClaimsForBounty,
  QUEUE_HOLDING_STATUSES,
} from "../../src/services/prize-claim-service.js";
import { payPrize, recordPayeeIdentity, recordTaxForm, recordScreening, prizedMicroUsd } from "../../src/services/prize-payout-service.js";
import { owlsForImportance } from "../../src/services/contribution-award-service.js";
import { owlsToMicroUsd } from "../../src/services/owl.js";
import { processNextPrizeCheck, claimNextQueuedPrizeClaim } from "../../src/workers/prize-check-pipeline.js";

const USD = 1_000_000;
const STATEMENT = (ns: string) => `import Mathlib\nnamespace ${ns}\ndef Statement : Prop := True\nexample : True := trivial\nend ${ns}`;

async function seedBindableStatement(claimId: string): Promise<{ formalizationId: string; namespace: string }> {
  const ns = `Minerval.S${randomUUID().slice(0, 8)}_v1`;
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_formalizations
       (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
        namespace, statement_source, source_hash, expr_hash, pp_type,
        constants, definitions_axioms, witness_present, status, authored_by,
        published_at, review_period_ends_at)
     VALUES ($1, 1, 'mathlib-v4.33.0', 'leanprover/lean4:v4.33.0', $2, 'sha256:img', $3, $4,
             $5, $6, 'True', '[]', '[]', true, 'published', 'claim_steward',
             now() - interval '30 days', now() - interval '16 days')
     RETURNING id`,
    [claimId, randomUUID().replace(/-/g, ""), ns, STATEMENT(ns), `src-${randomUUID()}`, `expr-${randomUUID()}`]
  );
  const formalizationId = rows[0]!.id;
  // A closed attempt with no accepted check: the solver tried and did not settle it.
  await rawQuery(
    `INSERT INTO proof_attempts (claim_id, formalization_id, model, variant, effort, status, outcome, ceiling_micro_usd, spent_micro_usd, finished_at)
     VALUES ($1, $2, 'solver', 'max', 'max', 'completed', 'partial', 100000000, 84000000, now() - interval '10 days')`,
    [claimId, formalizationId]
  );
  return { formalizationId, namespace: ns };
}

async function seedClaimant(label: string) {
  const id = await seedUser(label);
  await rawQuery(`UPDATE contributors SET reputation_score = 60, created_at = now() - interval '30 days' WHERE id = $1`, [id]);
  const [row] = await rawQuery<{ id: string; external_id: string; reputation_score: number; created_at: Date; prize_ineligible: boolean; is_suspended: boolean }>(
    `SELECT id, external_id, reputation_score, created_at, prize_ineligible, is_suspended FROM contributors WHERE id = $1`,
    [id]
  );
  return { id: row!.id, externalId: row!.external_id, reputationScore: row!.reputation_score, createdAt: new Date(row!.created_at), prizeIneligible: row!.prize_ineligible, isSuspended: row!.is_suspended };
}

function filing(claimId: string, claimant: Awaited<ReturnType<typeof seedClaimant>>, formalizationId: string, lean: string, extra: Record<string, unknown> = {}) {
  return {
    claimId,
    claimant,
    formalizationId,
    direction: "proof",
    content: "A written account of the approach, long enough to pass the form's floor. ".repeat(5),
    links: [],
    leanSource: { filename: "proof.lean", body: Buffer.from(lean) },
    documents: [],
    toolsDisclosure: "Lean 4 and Mathlib; no AI assistance.",
    residency: { country: "GB", us_person: false },
    creditName: "Ada",
    declarations: { eligibility: true, understanding: true, cc0: true },
    rulesVersion: PRIZE_RULES_VERSION,
    ...extra,
  } as Parameters<typeof filePrizeClaim>[0];
}

async function setupBounty(amountUsd = 500, depositCents = 1_000_000) {
  const domain = `dbtest-${randomUUID()}`;
  const claimId = await seedClaim("prize");
  const { formalizationId, namespace } = await seedBindableStatement(claimId);
  const deposit = await depositToPool({ domain, amount_cents: depositCents, bank_reference: "wire-1", batch_key: `batch-${randomUUID()}` });
  expect(deposit.ok).toBe(true);
  const pool = await getOrCreatePool(domain);
  const requested = await requestBounty({ claimId, cashUsd: amountUsd, rationale: "a live crux", grantId: null, passStartedAt: new Date(Date.now() - 60_000), domain });
  expect(requested).toMatchObject({ ok: true, status: "requested" });
  if (!requested.ok) throw new Error("request failed");
  const opened = await openBounty({ bountyId: requested.bounty_id, passStartedAt: new Date() });
  expect(opened).toMatchObject({ ok: true, status: "open", opened: true });
  return { domain, claimId, formalizationId, namespace, poolId: pool.id, bountyId: requested.bounty_id };
}

beforeAll(async () => {
  await getPlatformAccountId();
});

describe("the fund", () => {
  it("deposits idempotently under the batch key and reports the three numbers", async () => {
    const domain = `dbtest-${randomUUID()}`;
    const key = `batch-${randomUUID()}`;
    const a = await depositToPool({ domain, amount_cents: 250_000, bank_reference: "wire", batch_key: key });
    const b = await depositToPool({ domain, amount_cents: 250_000, bank_reference: "wire", batch_key: key });
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(b).toMatchObject({ ok: true, duplicate: true });
    if (!a.ok || !b.ok) return;
    expect(b.entry_id).toBe(a.entry_id);
    expect(b.numbers).toEqual({ balance_micro_usd: 2500 * USD, reserved_micro_usd: 0, available_micro_usd: 2500 * USD });
  });

  it("a bounty never opens beyond available, and reserved is derived from the live statuses", async () => {
    const s = await setupBounty(500); // $10,000 fund, $500 open
    expect(await poolNumbers(s.poolId)).toEqual({ balance_micro_usd: 10_000 * USD, reserved_micro_usd: 500 * USD, available_micro_usd: 9_500 * USD });
    // Another live bounty on the pool (a large one, placed directly) leaves
    // $100 available: a $500 request is within every fraction and still
    // refused, because available does not cover it.
    const other = await seedClaim("prize-other");
    const otherStatement = await seedBindableStatement(other);
    const [big] = await rawQuery<{ id: string }>(
      `INSERT INTO bounties (claim_id, formalization_id, pool_id, amount_micro_usd, status, rules_version, rationale, opened_at)
       VALUES ($1, $2, $3, $4, 'open', 'v', 'x', now()) RETURNING id`,
      [other, otherStatement.formalizationId, s.poolId, 9_400 * USD]
    );
    expect(await poolNumbers(s.poolId)).toMatchObject({ reserved_micro_usd: 9_900 * USD, available_micro_usd: 100 * USD });
    const claim2 = await seedClaim("prize-2");
    await seedBindableStatement(claim2);
    const req = await requestBounty({ claimId: claim2, cashUsd: 500, rationale: "x", grantId: null, domain: s.domain });
    expect(req).toMatchObject({ ok: false, code: "INSUFFICIENT_AVAILABLE" });
    // Closing bounties releases the reservations without posting anything.
    expect(await closeBounty(s.bountyId, "expired", "test")).toBe(true);
    expect(await closeBounty(big!.id, "withdrawn", "test")).toBe(true);
    expect(await poolReservedMicroUsd(s.poolId)).toBe(0);
    expect((await poolNumbers(s.poolId)).balance_micro_usd).toBe(10_000 * USD);
    const now = await requestBounty({ claimId: claim2, cashUsd: 500, rationale: "x", grantId: null, domain: s.domain });
    expect(now).toMatchObject({ ok: true, status: "requested" });
  });

  it("the debit writers consume the reservation and never exceed the bounty's amount", async () => {
    const s = await setupBounty(500);
    const first = await postOwlPrizeDebit({ poolId: s.poolId, amountMicroUsd: 400 * USD, bountyId: s.bountyId, idempotencyKey: `t:${randomUUID()}` });
    expect(first).not.toBeNull();
    await expect(
      postFundDebit({ poolId: s.poolId, reason: "withholding_remitted", amountMicroUsd: 101 * USD, bountyId: s.bountyId, idempotencyKey: `t:${randomUUID()}` })
    ).rejects.toThrow(/exceed its reservation/);
    const key = `t:${randomUUID()}`;
    expect(await postFundDebit({ poolId: s.poolId, reason: "withholding_remitted", amountMicroUsd: 100 * USD, bountyId: s.bountyId, idempotencyKey: key })).not.toBeNull();
    expect(await postFundDebit({ poolId: s.poolId, reason: "withholding_remitted", amountMicroUsd: 100 * USD, bountyId: s.bountyId, idempotencyKey: key })).toBeNull();
    expect((await poolNumbers(s.poolId)).balance_micro_usd).toBe(10_000 * USD - 500 * USD);
  });

  it("the reason vocabulary is enforced by the CHECK", async () => {
    const s = await setupBounty(500);
    await expect(
      rawQuery(`INSERT INTO prize_pool_entries (pool_id, amount_micro_usd, reason) VALUES ($1, -1, 'gift')`, [s.poolId])
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "23514");
  });
});

describe("the reserve", () => {
  it("is minted at cost into a platform-owned job when the bounty opens and released when it closes", async () => {
    const config = loadConfig();
    const platform = await getPlatformAccountId();
    const before = await owlBalance(platform);
    const s = await setupBounty(500);
    const job = await getReserveJob(s.bountyId);
    expect(job).toMatchObject({ budget_micro_usd: Math.floor(500 * USD * config.prizeReviewReserveFraction), status: "running", user_id: platform });
    // The mint and the hold cancel on the spendable balance; the fund is untouched.
    expect(await owlBalance(platform)).toBe(before);
    expect((await poolNumbers(s.poolId)).balance_micro_usd).toBe(10_000 * USD);
    await closeBounty(s.bountyId, "withdrawn", "test");
    expect(await owlBalance(platform)).toBe(before + job!.budget_micro_usd);
    expect((await getReserveJob(s.bountyId))?.status).toBe("completed");
  });
});

describe("the indexes", () => {
  it("one live prize claim per claimant per statement, enforced by the partial unique index and refused by the gate", async () => {
    const s = await setupBounty(500);
    const claimant = await seedClaimant("dup");
    const filed = await filePrizeClaim(filing(s.claimId, claimant, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    expect(filed).toMatchObject({ ok: true, status: "queued" });
    const again = await filePrizeClaim(filing(s.claimId, claimant, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := by trivial\n`));
    expect(again).toMatchObject({ ok: false, code: "DUPLICATE_LIVE_CLAIM" });
    if (!filed.ok) return;
    await expect(
      rawQuery(
        `INSERT INTO prize_claims (contribution_id, bounty_id, claim_id, formalization_id, claimant_id, direction, status, rules_version)
         SELECT $1, bounty_id, claim_id, formalization_id, claimant_id, direction, 'queued', rules_version FROM prize_claims WHERE id = $2`,
        [filed.contribution_id, filed.prize_claim_id]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "23505");
    // One live bounty per claim.
    await expect(
      rawQuery(
        `INSERT INTO bounties (claim_id, formalization_id, pool_id, amount_micro_usd, status, rules_version, rationale)
         VALUES ($1, $2, $3, 1, 'open', 'v', 'x')`,
        [s.claimId, s.formalizationId, s.poolId]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "23505");
  });
});

describe("the check queue", () => {
  it("serializes per statement: the oldest queued claim is checked and no later one while it is live", async () => {
    // The worker takes the oldest queued claim across the platform; clear
    // what earlier tests in this file left queued so this statement's own
    // two claims are the candidates.
    await rawQuery(`UPDATE prize_claims SET status = 'withdrawn' WHERE status IN ('queued', 'checking')`);
    const s = await setupBounty(500);
    const a = await seedClaimant("q-a");
    const b = await seedClaimant("q-b");
    const first = await filePrizeClaim(filing(s.claimId, a, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial -- a\n`));
    const second = await filePrizeClaim(filing(s.claimId, b, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial -- b\n`));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const claimed = await claimNextQueuedPrizeClaim();
    expect(claimed?.id).toBe(first.prize_claim_id);
    expect(claimed?.status).toBe("checking");
    expect(claimed?.check_attempts).toBe(1);
    expect(await claimNextQueuedPrizeClaim()).toBeNull();
    expect(QUEUE_HOLDING_STATUSES).toContain("checking");
  });
});

describe("racing writers", () => {
  it("two racing acceptances produce one accepted claim", async () => {
    const s = await setupBounty(500);
    const c = await seedClaimant("race-accept");
    const filed = await filePrizeClaim(filing(s.claimId, c, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    if (!filed.ok) throw new Error("filing failed");
    await rawQuery(`UPDATE prize_claims SET status = 'in_review' WHERE id = $1`, [filed.prize_claim_id]);
    const run = { runId: null, requestedModel: "m", servedModel: "m", fallbackRan: false };
    const [x, y] = await Promise.all([
      acceptPrizeClaim({ prizeClaimId: filed.prize_claim_id, reason: "a", resultCategory: "new_result", actor: "s", run }),
      acceptPrizeClaim({ prizeClaimId: filed.prize_claim_id, reason: "b", resultCategory: "new_result", actor: "s", run }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const [runs] = await rawQuery<{ n: string }>(`SELECT COUNT(*)::int AS n FROM audit_runs WHERE dedupe_key LIKE $1`, [`prize_claim:${filed.prize_claim_id}:%`]);
    expect(Number(runs!.n)).toBe(1);
    expect((await getPrizeClaimById(filed.prize_claim_id))?.status).toBe("in_challenge_window");
  });

  it("two racing payouts produce one payout row and one owl grant; the same key twice yields one ledger row", async () => {
    const s = await setupBounty(500);
    const c = await seedClaimant("race-pay");
    const filed = await filePrizeClaim(filing(s.claimId, c, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    if (!filed.ok) throw new Error("filing failed");
    const payee = JSON.stringify({ legal_name: "A", country: "GB", us_person: false, has_tin: false, treaty_position: true, identity_recorded_at: "x", tax_form_kind: "w8ben", tax_form_recorded_at: "x", screening_result: "clear", payable_at: new Date().toISOString() });
    await rawQuery(
      `UPDATE prize_claims SET status = 'payable', audit_outcome = 'clear', window_ends_at = now() - interval '20 days', payee = $2::jsonb WHERE id = $1`,
      [filed.prize_claim_id, payee]
    );
    await rawQuery(`UPDATE bounties SET status = 'claim_pending' WHERE id = $1`, [s.bountyId]);
    const [p, q] = await Promise.all([payPrize(filed.prize_claim_id), payPrize(filed.prize_claim_id)]);
    expect([p.ok, q.ok].filter(Boolean)).toHaveLength(1);
    const third = await payPrize(filed.prize_claim_id);
    expect(third).toMatchObject({ ok: false, code: "ALREADY_PAID" });
    const rows = await rawQuery<{ n: string }>(`SELECT COUNT(*)::int AS n FROM owl_ledger WHERE idempotency_key = $1`, [`prize:${filed.prize_claim_id}:owls`]);
    expect(Number(rows[0]!.n)).toBe(1);
    const payouts = await rawQuery<{ n: string }>(`SELECT COUNT(*)::int AS n FROM prize_payouts WHERE prize_claim_id = $1`, [filed.prize_claim_id]);
    expect(Number(payouts[0]!.n)).toBe(1);
    expect(await prizedMicroUsd(c.id)).toBe(500 * USD);
  });
});

describe("the end-to-end money path", () => {
  it("deposit → bounty → claim → check → admit → accept → audit → window → payee steps → owl grant, with the ledger invariants at every step", async () => {
    const config = loadConfig();
    await rawQuery(`UPDATE prize_claims SET status = 'withdrawn' WHERE status IN ('queued', 'checking')`);
    const platform = await getPlatformAccountId();
    const platformBefore = await owlBalance(platform);
    const s = await setupBounty(500);
    const bounty = (await getBountyById(s.bountyId))!;
    expect(await poolNumbers(s.poolId)).toEqual({ balance_micro_usd: 10_000 * USD, reserved_micro_usd: 500 * USD, available_micro_usd: 9_500 * USD });
    const reserve = (await getReserveJob(s.bountyId))!;
    expect(reserve.budget_micro_usd).toBe(50 * USD);

    // The claim through the gate.
    const claimant = await seedClaimant("e2e");
    const lean = `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`;
    const filed = await filePrizeClaim(filing(s.claimId, claimant, s.formalizationId, lean));
    expect(filed).toMatchObject({ ok: true, status: "queued" });
    if (!filed.ok) return;
    const [contribution] = await rawQuery<{ contribution_type: string; review_status: string }>(`SELECT contribution_type, review_status FROM contributions WHERE id = $1`, [filed.contribution_id]);
    expect(contribution).toEqual({ contribution_type: "claim_prize", review_status: "checking" });
    const [action] = await rawQuery<{ id: string; status: string }>(`SELECT id, status FROM actions WHERE kind = 'prize_review' AND target_ref = $1`, [filed.prize_claim_id]);
    expect(action?.status).toBe("open");
    const [allocation] = await rawQuery<{ user_id: string; amount_micro_usd: string }>(`SELECT user_id, amount_micro_usd FROM action_allocations WHERE action_id = $1`, [action!.id]);
    expect(allocation?.user_id).toBe(platform);
    expect(Number(allocation!.amount_micro_usd)).toBeLessThanOrEqual(50 * USD);

    // The fake checker accepts; the worker runs the Reviewer (mocked to admit) and invokes the Steward.
    const fake = new FakeLeanCheckerClient();
    const check = await processNextPrizeCheck({ client: fake });
    expect(check).toMatchObject({ status: "processed", prizeClaimId: filed.prize_claim_id, verdict: "accepted", outcome: "in_review" });
    let pc = (await getPrizeClaimById(filed.prize_claim_id))!;
    expect(pc.status).toBe("in_review");
    expect(pc.lean_check_id).not.toBeNull();
    expect((await getBountyById(s.bountyId))?.status).toBe("claim_pending");
    expect(stewardRuns.at(-1)).toMatchObject({ trigger: "prize_claim", claimId: s.claimId, jobId: reserve.id });
    const [usage] = await rawQuery<{ n: string; total: string }>(`SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_micro_usd), 0)::bigint AS total FROM llm_usage WHERE job_id = $1`, [reserve.id]);
    expect(Number(usage!.n)).toBeGreaterThanOrEqual(2); // the check and the Reviewer's call
    const [done] = await rawQuery<{ status: string; metered_job_id: string | null; metered_cost_micro_usd: string }>(`SELECT status, metered_job_id, metered_cost_micro_usd FROM actions WHERE id = $1`, [action!.id]);
    expect(done).toMatchObject({ status: "done", metered_job_id: reserve.id });
    // The action consumed the check, the Reviewer, and the Steward's run.
    expect(Number(done!.metered_cost_micro_usd)).toBeGreaterThanOrEqual(Number(usage!.total) + 250_000);
    const [gate] = await rawQuery<{ n: string }>(`SELECT COUNT(*)::int AS n FROM lean_checks WHERE prize_claim_id = $1 AND mode = 'prize' AND verdict = 'accepted'`, [filed.prize_claim_id]);
    expect(Number(gate!.n)).toBe(1);
    // A second filing is refused now: the gate closed at claim_pending.
    const late = await filePrizeClaim(filing(s.claimId, await seedClaimant("late"), s.formalizationId, lean));
    expect(late).toMatchObject({ ok: false, code: "NO_OPEN_BOUNTY" });

    // The Steward's accept (the service call the tool makes).
    const accepted = await acceptPrizeClaim({ prizeClaimId: pc.id, reason: "faithful", resultCategory: "new_result", actor: "claim_steward", run: { runId: null, requestedModel: "strong", servedModel: "strong", fallbackRan: false } });
    expect(accepted).toMatchObject({ ok: true, status: "in_challenge_window" });
    if (!accepted.ok) return;
    pc = (await getPrizeClaimById(pc.id))!;
    expect(pc.window_ends_at!.getTime() - Date.now()).toBeGreaterThan((config.prizeChallengeWindowDaysSmall - 0.01) * 86_400_000);
    const [att] = await rawQuery<{ visibility: string }>(`SELECT visibility FROM attachments WHERE contribution_id = $1 AND kind = 'lean_source'`, [filed.contribution_id]);
    expect(att?.visibility).toBe("public");
    const [auditRun] = await rawQuery<{ id: string; triggered_by: string }>(`SELECT id, triggered_by FROM audit_runs WHERE dedupe_key = $1`, [`prize_claim:${pc.id}:${accepted.decision_id}`]);
    expect(auditRun?.triggered_by).toBe("prize_acceptance");
    // The deferred accepted-contribution award (0 owls per point by default).
    const expectedAward = owlsToMicroUsd(owlsForImportance(0.5));
    expect(await owlBalance(claimant.id)).toBe(expectedAward);
    const earnedBeforePrize = await owlBalance(claimant.id);

    // Not payable yet: the window is open and no audit outcome is recorded.
    expect(await payPrize(pc.id)).toMatchObject({ ok: false, code: "NOT_PAYABLE" });
    expect((await promotePayable(pc.id)).promoted).toBe(false);
    await recordPrizeAuditOutcome({ prizeClaimId: pc.id, outcome: "clear", note: "holds up", actor: "audit_agent" });
    expect((await promotePayable(pc.id)).promoted).toBe(false);
    // The window elapses.
    await rawQuery(`UPDATE prize_claims SET window_ends_at = now() - interval '1 minute' WHERE id = $1`, [pc.id]);
    const check2 = await promotionCheck((await getPrizeClaimById(pc.id))!);
    expect(check2.ready).toBe(true);
    expect(check2.signoff.required).toBe(false);
    expect((await promotePayable(pc.id)).promoted).toBe(true);
    expect((await getPrizeClaimById(pc.id))?.status).toBe("payable");

    // Refused before the payee steps, then each step in turn.
    expect(await payPrize(pc.id)).toMatchObject({ ok: false, code: "PAYEE_STEPS_INCOMPLETE" });
    expect(await recordPayeeIdentity({ prizeClaimId: pc.id, userId: claimant.id, legalName: "Ada L.", country: "GB", usPerson: false, hasTin: false, treatyPosition: false })).toMatchObject({ ok: true });
    expect(await payPrize(pc.id)).toMatchObject({ ok: false, code: "PAYEE_STEPS_INCOMPLETE" });
    expect(await recordTaxForm({ prizeClaimId: pc.id, userId: claimant.id, kind: "w8ben", file: { filename: "w8ben.pdf", body: Buffer.from("%PDF-1.4 form") } })).toMatchObject({ ok: true });
    expect(await payPrize(pc.id)).toMatchObject({ ok: false, code: "PAYEE_STEPS_INCOMPLETE" });
    expect(await recordScreening({ prizeClaimId: pc.id, result: "clear", recordedBy: "founder" })).toEqual({ ok: true });
    const [tax] = await rawQuery<{ visibility: string; kind: string }>(`SELECT visibility, kind FROM attachments WHERE contribution_id = $1 AND kind = 'tax_form'`, [filed.contribution_id]);
    expect(tax).toEqual({ visibility: "restricted", kind: "tax_form" });

    // The owl grant: 30% withholding for a non-U.S. person with no treaty position.
    const paid = await payPrize(pc.id, { actor: "operator:founder" });
    expect(paid).toMatchObject({ ok: true, gross_micro_usd: 500 * USD, withholding_micro_usd: 150 * USD, net_micro_usd: 350 * USD, first_tranche_micro_usd: 350 * USD, tranches: 1, bounty_status: "paid", superseded: [] });
    expect((await getPrizeClaimById(pc.id))?.status).toBe("paid");
    expect((await getBountyById(s.bountyId))?.status).toBe("paid");
    // Ledger invariants: reserved back to zero, the balance down by the cash amount, prized up by the net.
    const numbers = await poolNumbers(s.poolId);
    expect(numbers.reserved_micro_usd).toBe(0);
    expect(numbers.balance_micro_usd).toBe(10_000 * USD - 500 * USD);
    expect(numbers.available_micro_usd).toBe(9_500 * USD);
    const debits = await rawQuery<{ reason: string; amount_micro_usd: string }>(`SELECT reason, amount_micro_usd FROM prize_pool_entries WHERE bounty_id = $1 ORDER BY reason`, [s.bountyId]);
    expect(debits.map((d) => [d.reason, Number(d.amount_micro_usd)])).toEqual([["owl_prize", -350 * USD], ["withholding_remitted", -150 * USD]]);
    const [contrib] = await rawQuery<{ prized: string; earned: string }>(`SELECT owls_prized_micro_usd AS prized, owls_earned_micro_usd AS earned FROM contributors WHERE id = $1`, [claimant.id]);
    expect(Number(contrib!.prized)).toBe(350 * USD);
    expect(Number(contrib!.earned)).toBe(earnedBeforePrize);
    expect(await owlBalance(claimant.id)).toBe(earnedBeforePrize + 350 * USD);
    expect(await prizedMicroUsd(claimant.id)).toBe(350 * USD);
    const [ledger] = await rawQuery<{ reason: string; claim_id: string; contribution_id: string }>(`SELECT reason, claim_id, contribution_id FROM owl_ledger WHERE idempotency_key = $1`, [`prize:${pc.id}:owls`]);
    expect(ledger).toEqual({ reason: "prize_award", claim_id: s.claimId, contribution_id: filed.contribution_id });
    const [payout] = await rawQuery<{ kind: string; provider: string; status: string; tax_form_kind: string; screening_result: string }>(`SELECT kind, provider, status, tax_form_kind, screening_result FROM prize_payouts WHERE prize_claim_id = $1`, [pc.id]);
    expect(payout).toEqual({ kind: "owls", provider: "internal", status: "paid", tax_form_kind: "w8ben", screening_result: "clear" });
    // The reserve released: the platform got back the reserve less what the review cost.
    expect((await getReserveJob(s.bountyId))?.status).toBe("completed");
    const platformAfter = await owlBalance(platform);
    expect(platformAfter).toBeGreaterThan(platformBefore);
    expect(platformAfter).toBeLessThan(platformBefore + reserve.budget_micro_usd);
    expect(platformAfter).toBe(platformBefore + reserve.budget_micro_usd - Number(done!.metered_cost_micro_usd));
    // Every transition is on the claim's audit trail.
    const trail = await rawQuery<{ action: string }>(`SELECT action FROM audit_log WHERE claim_id = $1 AND action LIKE 'prize_claim:%' ORDER BY created_at`, [s.claimId]);
    const actions = trail.map((t) => t.action);
    for (const step of ["prize_claim:queued", "prize_claim:checking", "prize_claim:checked", "prize_claim:in_review", "prize_claim:in_challenge_window", "prize_claim:payable", "prize_claim:paid"]) {
      expect(actions).toContain(step);
    }
    expect(bounty.rules_version).toBe(PRIZE_RULES_VERSION);
    expect((await listPrizeClaimsForBounty(s.bountyId)).map((c) => c.status)).toEqual(["paid"]);
    void OWL;
  });
});
