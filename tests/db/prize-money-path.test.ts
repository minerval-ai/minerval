/**
 * The prize money path against real Postgres (docs/mathematics.md §8.1,
 * §8.6, §8.7, §12.4), under the escrow model: a bounty is owls held against
 * the posting mandate's escrow from the moment it opens until it resolves.
 * A posted bounty raises the mandate's committed money by its amount (plus
 * the prize-review reserve) and shrinks the allocator's escrow room; a
 * bounty beyond the headroom is refused with INSUFFICIENT_ESCROW; the
 * per-pass and per-day fractions of the escrow refuse; a confirm_pending
 * bounty holds and its confirmation does not count it against itself;
 * expiry and withdrawal release the hold; the payout consumes it (the
 * payout row is the record, the winner's prize_award rows are net of
 * withholding, and no fund exists anywhere); a mandate with a live bounty
 * cannot close; the closing refund excludes a held bounty and a paid prize;
 * the reserve counts while running and as placed spend once released. Then
 * the partial unique indexes, the check queue's per-statement
 * serialization, payout idempotency, two racing acceptances producing one
 * accepted claim and two racing payouts producing one, and the end-to-end
 * path from posting through the owl grant.
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
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  seedAction,
  seedAllocation,
  seedValuation,
  pgCode,
  owlBalance,
  OWL,
} from "./helpers.js";
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
  requestBounty,
  openBounty,
  confirmBounty,
  withdrawBounty,
  expireAndWithdrawDueBounties,
  getBountyById,
  getReserveJob,
  closeBounty,
  mandateClosureBlockers,
  mandatePrizeNumbers,
  PRIZE_RULES_VERSION,
  getPlatformAccountId,
  owlsToMicro,
} from "../../src/services/bounty-service.js";
import { prizeCommitmentBreakdown } from "../../src/services/prize-commitment.js";
import { grantCommittedMicroUsd } from "../../src/services/regrant-service.js";
import { runMandateAllocator } from "../../src/services/allocation-service.js";
import { refundUnspentBudget } from "../../src/services/budget-job-service.js";
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

/** A posting mandate: an active grant with a running escrow of this many owls. */
async function seedMandate(escrowOwls = 2500): Promise<{ grantId: string; jobId: string; funderId: string }> {
  const funderId = await seedUser("prize-mandate-funder");
  const { grantId, jobId } = await seedGrantWithJob({ funderId, budgetMicroUsd: escrowOwls * OWL, policy: "cover" });
  return { grantId, jobId, funderId };
}

/** A claim with a bindable statement and one bounty posted from the mandate, requested and opened. */
async function setupBounty(amountOwls = 500, escrowOwls = 2500, mandate?: { grantId: string; jobId: string }) {
  const m = mandate ?? (await seedMandate(escrowOwls));
  const claimId = await seedClaim("prize");
  const { formalizationId, namespace } = await seedBindableStatement(claimId);
  const requested = await requestBounty({ claimId, owls: amountOwls, rationale: "a live crux", grantId: m.grantId, passStartedAt: new Date(Date.now() - 60_000) });
  expect(requested).toMatchObject({ ok: true, status: "requested" });
  if (!requested.ok) throw new Error("request failed");
  const opened = await openBounty({ bountyId: requested.bounty_id, passStartedAt: new Date() });
  expect(opened).toMatchObject({ ok: true, status: "open", opened: true });
  return { grantId: m.grantId, jobId: m.jobId, claimId, formalizationId, namespace, bountyId: requested.bounty_id };
}

async function committedOwls(grantId: string, jobId: string): Promise<number> {
  return (await grantCommittedMicroUsd({ id: grantId, budgetJobId: jobId })) / OWL;
}

/** A prize claim moved straight to payable with the winner's steps recorded (the path is tested end to end below). */
async function makePayable(prizeClaimId: string, bountyId: string): Promise<void> {
  const payee = JSON.stringify({ legal_name: "A", country: "GB", us_person: false, has_tin: false, treaty_position: false, identity_recorded_at: "x", tax_form_kind: "w8ben", tax_form_recorded_at: "x", screening_result: "clear", payable_at: new Date().toISOString() });
  await rawQuery(
    `UPDATE prize_claims SET status = 'payable', audit_outcome = 'clear', window_ends_at = now() - interval '20 days', payee = $2::jsonb WHERE id = $1`,
    [prizeClaimId, payee]
  );
  await rawQuery(`UPDATE bounties SET status = 'claim_pending' WHERE id = $1`, [bountyId]);
}

beforeAll(async () => {
  await getPlatformAccountId();
});

describe("the escrow hold", () => {
  it("a posted bounty holds against the mandate: committed money rises by the amount plus the reserve, and the allocator's escrow room falls", async () => {
    const config = loadConfig();
    const m = await seedMandate(2500);
    expect(await committedOwls(m.grantId, m.jobId)).toBe(0);
    const s = await setupBounty(500, 2500, m);
    const reserveOwls = 500 * config.prizeReviewReserveFraction;
    // The bounty's amount and the reserve's running budget are the prize term.
    expect(await prizeCommitmentBreakdown(m.grantId)).toEqual({
      held_micro_usd: 500 * OWL,
      paid_micro_usd: 0,
      review_reserve_micro_usd: reserveOwls * OWL,
      total_micro_usd: (500 + reserveOwls) * OWL,
    });
    expect(await committedOwls(m.grantId, m.jobId)).toBe(500 + reserveOwls);
    expect(await mandatePrizeNumbers(m.grantId)).toEqual({
      escrow_micro_usd: 2500 * OWL,
      held_micro_usd: 500 * OWL,
      paid_micro_usd: 0,
      review_reserve_micro_usd: reserveOwls * OWL,
      headroom_micro_usd: (2500 - 500 - reserveOwls) * OWL,
    });

    // The allocator reads the same number: an increment of 1,960 owls is
    // larger than the 1,950 owls of room the held bounty leaves, so it is
    // not placed; once the bounty expires the room returns and it is.
    const claimId = await seedClaim("alloc-room");
    const actionId = await seedAction({ group: `assess:${claimId}`, claimId, costMicroUsd: 1960 * OWL });
    await seedValuation({ grantId: m.grantId, actionId, valueEst: 9 });
    expect((await runMandateAllocator(m.grantId)).allocated).toBe(0);
    expect(await closeBounty(s.bountyId, "expired", "test")).toBe(true);
    expect(await prizeCommitmentBreakdown(m.grantId)).toEqual({ held_micro_usd: 0, paid_micro_usd: 0, review_reserve_micro_usd: 0, total_micro_usd: 0 });
    expect(await committedOwls(m.grantId, m.jobId)).toBe(0);
    const placed = await runMandateAllocator(m.grantId);
    expect(placed).toMatchObject({ allocated: 1, allocatedMicroUsd: 1960 * OWL });
  });

  it("a bounty beyond the mandate's headroom is refused with INSUFFICIENT_ESCROW", async () => {
    const m = await seedMandate(2500);
    const claimId = await seedClaim("prize-headroom");
    await seedBindableStatement(claimId);
    // 2,100 owls of the 2,500 already ride on an open action: 400 of headroom.
    const allocation = await seedAllocation({ group: `dbtest:prize-headroom:${m.grantId}`, grantId: m.grantId, amountMicroUsd: 2100 * OWL });
    const refused = await requestBounty({ claimId, owls: 500, rationale: "x", grantId: m.grantId });
    expect(refused).toMatchObject({ ok: false, code: "INSUFFICIENT_ESCROW" });
    if (!refused.ok) expect(refused.message).toMatch(/headroom is 400 owls/);
    expect(await rawQuery(`SELECT id FROM bounties WHERE claim_id = $1`, [claimId])).toHaveLength(0);
    // The allocation releases: the headroom returns and the same request lands.
    await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE id = $1`, [allocation]);
    expect(await requestBounty({ claimId, owls: 500, rationale: "x", grantId: m.grantId })).toMatchObject({ ok: true, status: "requested" });
  });

  it("refuses a posting from a mandate that is not active with a running escrow", async () => {
    const funder = await seedUser("prize-paused");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 2500 * OWL, jobStatus: "paused_budget" });
    const claimId = await seedClaim("prize-paused");
    await seedBindableStatement(claimId);
    expect(await requestBounty({ claimId, owls: 500, rationale: "x", grantId })).toMatchObject({ ok: false, code: "MANDATE_NOT_ACTIVE" });
    expect(await requestBounty({ claimId, owls: 500, rationale: "x", grantId: randomUUID() })).toMatchObject({ ok: false, code: "MANDATE_NOT_ACTIVE" });
  });

  it("the per-pass and per-day fractions of the escrow refuse", async () => {
    // Escrow 2,500 owls: at most 1,000 per pass and 1,250 per day.
    const m = await seedMandate(2500);
    const passStartedAt = new Date(Date.now() - 60_000);
    const first = await setupBounty(600, 2500, m);
    await rawQuery(`UPDATE bounties SET opened_at = $2 WHERE id = $1`, [first.bountyId, new Date()]);
    const claim2 = await seedClaim("prize-pass");
    await seedBindableStatement(claim2);
    // The same pass already committed 600: another 500 exceeds the pass cap.
    expect(await requestBounty({ claimId: claim2, owls: 500, rationale: "x", grantId: m.grantId, passStartedAt })).toMatchObject({ ok: false, code: "PASS_FRACTION_EXCEEDED" });
    // A later pass: within the pass cap, and 1,100 of today's 1,250.
    expect(await requestBounty({ claimId: claim2, owls: 500, rationale: "x", grantId: m.grantId, passStartedAt: new Date() })).toMatchObject({ ok: true, status: "requested" });
    const claim3 = await seedClaim("prize-day");
    await seedBindableStatement(claim3);
    expect(await requestBounty({ claimId: claim3, owls: 250, rationale: "x", grantId: m.grantId, passStartedAt: new Date() })).toMatchObject({ ok: false, code: "DAY_FRACTION_EXCEEDED" });
  });

  it("a confirm_pending bounty holds, and its confirmation does not count it against itself", async () => {
    const config = loadConfig();
    // Escrow 5,000 owls (pass cap 2,000), of which 3,000 ride on an open
    // action: 2,000 of headroom for a 1,500-owl posting.
    const m = await seedMandate(5000);
    await seedAllocation({ group: `dbtest:prize-confirm:${m.grantId}`, grantId: m.grantId, amountMicroUsd: 3000 * OWL });
    const claimId = await seedClaim("prize-confirm");
    await seedBindableStatement(claimId);
    const amount = config.bountyAutonomyThresholdOwls + 500;
    const requested = await requestBounty({ claimId, owls: amount, rationale: "big", grantId: m.grantId, passStartedAt: new Date(Date.now() - 60_000) });
    if (!requested.ok) throw new Error(requested.message);
    // A requested bounty holds nothing.
    expect(await committedOwls(m.grantId, m.jobId)).toBe(3000);
    const parked = await openBounty({ bountyId: requested.bounty_id, passStartedAt: new Date() });
    expect(parked).toMatchObject({ ok: true, status: "confirm_pending", opened: false });
    expect((await prizeCommitmentBreakdown(m.grantId)).held_micro_usd).toBe(amount * OWL);
    expect(await committedOwls(m.grantId, m.jobId)).toBe(3000 + amount);
    expect(await getReserveJob(requested.bounty_id)).toBeNull();
    // Headroom is 500 with the hold counted, less than the amount; the
    // confirmation excludes the bounty's own hold and opens it.
    expect((await mandatePrizeNumbers(m.grantId))!.headroom_micro_usd).toBe(500 * OWL);
    const confirmed = await confirmBounty({ bountyId: requested.bounty_id, confirmedBy: "founder" });
    expect(confirmed).toMatchObject({ ok: true, status: "open", opened: true });
    expect((await getBountyById(requested.bounty_id))?.human_confirmed_by).toBe("founder");
    expect((await prizeCommitmentBreakdown(m.grantId)).held_micro_usd).toBe(amount * OWL);
  });

  it("expiry and withdrawal release the hold", async () => {
    const m = await seedMandate(2500);
    const a = await setupBounty(500, 2500, m);
    const b = await setupBounty(300, 2500, m);
    expect((await prizeCommitmentBreakdown(m.grantId)).held_micro_usd).toBe(800 * OWL);
    // Expiry: the date passes and the closer applies it.
    await rawQuery(`UPDATE bounties SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.bountyId]);
    // Withdrawal: notice given, then the effective time passes.
    const notice = await withdrawBounty({ bountyId: b.bountyId, rationale: "reworked", actor: "test" });
    expect(notice).toMatchObject({ ok: true, status: "open" });
    expect((await prizeCommitmentBreakdown(m.grantId)).held_micro_usd).toBe(800 * OWL);
    await rawQuery(`UPDATE bounties SET withdraw_effective_at = now() - interval '1 minute' WHERE id = $1`, [b.bountyId]);
    const swept = await expireAndWithdrawDueBounties();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(swept.withdrawn).toBeGreaterThanOrEqual(1);
    expect((await getBountyById(a.bountyId))?.status).toBe("expired");
    expect((await getBountyById(b.bountyId))?.status).toBe("withdrawn");
    expect(await prizeCommitmentBreakdown(m.grantId)).toEqual({ held_micro_usd: 0, paid_micro_usd: 0, review_reserve_micro_usd: 0, total_micro_usd: 0 });
    expect(await committedOwls(m.grantId, m.jobId)).toBe(0);
    expect((await getReserveJob(a.bountyId))?.status).toBe("completed");
    expect((await getReserveJob(b.bountyId))?.status).toBe("completed");
  });

  it("the payout consumes the hold: the bounty's term is unchanged when it closes paid, the winner's owls are net of withholding, and no fund exists", async () => {
    const config = loadConfig();
    const m = await seedMandate(2500);
    const s = await setupBounty(500, 2500, m);
    const c = await seedClaimant("consume");
    const filed = await filePrizeClaim(filing(s.claimId, c, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    if (!filed.ok) throw new Error("filing failed");
    const before = await prizeCommitmentBreakdown(m.grantId);
    expect(before.held_micro_usd).toBe(500 * OWL);
    expect(before.review_reserve_micro_usd).toBe(500 * config.prizeReviewReserveFraction * OWL);
    await makePayable(filed.prize_claim_id, s.bountyId);
    const paid = await payPrize(filed.prize_claim_id, { actor: "operator:founder" });
    expect(paid).toMatchObject({ ok: true, gross_micro_usd: 500 * OWL, withholding_micro_usd: 150 * OWL, net_micro_usd: 350 * OWL, bounty_status: "paid" });
    expect((await getBountyById(s.bountyId))?.status).toBe("paid");
    // The payout row is the record: the hold became consumption at the
    // gross amount, and the reserve, released, counts what was placed.
    const [placed] = await rawQuery<{ total: string }>(
      `SELECT COALESCE(SUM(al.amount_micro_usd), 0)::bigint AS total
         FROM action_allocations al JOIN actions a ON a.id = al.action_id
        WHERE a.kind = 'prize_review' AND a.target_ref = $1`,
      [filed.prize_claim_id]
    );
    const after = await prizeCommitmentBreakdown(m.grantId);
    expect(after).toEqual({
      held_micro_usd: 0,
      paid_micro_usd: 500 * OWL,
      review_reserve_micro_usd: Number(placed!.total),
      total_micro_usd: 500 * OWL + Number(placed!.total),
    });
    expect(Number(placed!.total)).toBeGreaterThan(0);
    expect(Number(placed!.total)).toBeLessThanOrEqual(before.review_reserve_micro_usd);
    expect(await committedOwls(m.grantId, m.jobId)).toBe(500 + Number(placed!.total) / OWL);
    expect((await getReserveJob(s.bountyId))?.status).toBe("completed");
    // The winner's owls: one prize_award row, net of the 30 percent withholding.
    const awards = await rawQuery<{ amount_micro_usd: string; idempotency_key: string }>(
      `SELECT amount_micro_usd, idempotency_key FROM owl_ledger WHERE user_id = $1 AND reason = 'prize_award'`,
      [c.id]
    );
    expect(awards.map((a) => [Number(a.amount_micro_usd), a.idempotency_key])).toEqual([[350 * OWL, `prize:${filed.prize_claim_id}:owls`]]);
    expect(await prizedMicroUsd(c.id)).toBe(350 * OWL);
    const [payout] = await rawQuery<{ amount_micro_usd: string; withholding_micro_usd: string; kind: string; status: string }>(
      `SELECT amount_micro_usd, withholding_micro_usd, kind, status FROM prize_payouts WHERE prize_claim_id = $1`,
      [filed.prize_claim_id]
    );
    expect(payout).toEqual({ amount_micro_usd: String(500 * OWL), withholding_micro_usd: String(150 * OWL), kind: "owls", status: "paid" });
    // Nothing was posted to any fund, because none exists.
    const tables = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'prize_pool%'`
    );
    expect(tables).toEqual([]);
    // The mandate's escrow job was never debited: a bounty is counted, not moved.
    const [job] = await rawQuery<{ budget_micro_usd: string }>(`SELECT budget_micro_usd FROM budget_jobs WHERE id = $1`, [m.jobId]);
    expect(Number(job!.budget_micro_usd)).toBe(2500 * OWL);
  });

  it("a mandate with a bounty in a holding status, or with a non-terminal prize claim, cannot close", async () => {
    const m = await seedMandate(2500);
    const s = await setupBounty(500, 2500, m);
    expect(await mandateClosureBlockers(m.grantId)).toEqual({ live_bounties: 1, bounty_ids: [s.bountyId] });
    const c = await seedClaimant("closure");
    const filed = await filePrizeClaim(filing(s.claimId, c, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    if (!filed.ok) throw new Error("filing failed");
    // Even a closed bounty blocks while a claim on it is non-terminal.
    await rawQuery(`UPDATE bounties SET status = 'resolved_unpaid' WHERE id = $1`, [s.bountyId]);
    expect((await mandateClosureBlockers(m.grantId)).live_bounties).toBe(1);
    await rawQuery(`UPDATE prize_claims SET status = 'withdrawn' WHERE id = $1`, [filed.prize_claim_id]);
    expect((await mandateClosureBlockers(m.grantId)).live_bounties).toBe(0);
    // A requested bounty holds nothing and does not block.
    const claim2 = await seedClaim("closure-requested");
    await seedBindableStatement(claim2);
    expect(await requestBounty({ claimId: claim2, owls: 300, rationale: "x", grantId: m.grantId })).toMatchObject({ ok: true });
    expect((await mandateClosureBlockers(m.grantId)).live_bounties).toBe(0);
  });

  it("the closing refund excludes a held bounty and a paid prize, and the reserve counts", async () => {
    const config = loadConfig();
    // A held bounty: the refund leaves its amount and the reserve's budget in the escrow.
    const held = await seedMandate(2500);
    await setupBounty(500, 2500, held);
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [held.grantId]);
    await rawQuery(`UPDATE budget_jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [held.jobId]);
    const reserveOwls = 500 * config.prizeReviewReserveFraction;
    expect(await refundUnspentBudget({ id: held.jobId, userId: held.funderId, budgetMicroUsd: 2500 * OWL })).toBe((2500 - 500 - reserveOwls) * OWL);

    // A paid prize: the refund leaves the gross amount and the placed reserve.
    const paidM = await seedMandate(2500);
    const s = await setupBounty(500, 2500, paidM);
    const c = await seedClaimant("refund-paid");
    const filed = await filePrizeClaim(filing(s.claimId, c, s.formalizationId, `theorem ${s.namespace}.proof : ${s.namespace}.Statement := trivial\n`));
    if (!filed.ok) throw new Error("filing failed");
    await makePayable(filed.prize_claim_id, s.bountyId);
    expect(await payPrize(filed.prize_claim_id)).toMatchObject({ ok: true, bounty_status: "paid" });
    const term = await prizeCommitmentBreakdown(paidM.grantId);
    expect(term.paid_micro_usd).toBe(500 * OWL);
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [paidM.grantId]);
    await rawQuery(`UPDATE budget_jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [paidM.jobId]);
    expect(await refundUnspentBudget({ id: paidM.jobId, userId: paidM.funderId, budgetMicroUsd: 2500 * OWL })).toBe(2500 * OWL - term.total_micro_usd);
  });
});

describe("the reserve", () => {
  it("is minted at cost into a platform-owned job when the bounty opens, counts against the mandate, and is released when it closes", async () => {
    const config = loadConfig();
    const platform = await getPlatformAccountId();
    const before = await owlBalance(platform);
    const m = await seedMandate(2500);
    const s = await setupBounty(500, 2500, m);
    const job = await getReserveJob(s.bountyId);
    expect(job).toMatchObject({ budget_micro_usd: Math.floor(500 * OWL * config.prizeReviewReserveFraction), status: "running", user_id: platform });
    // The mint and the hold cancel on the spendable balance; the mandate's
    // escrow is counted, never moved.
    expect(await owlBalance(platform)).toBe(before);
    expect((await prizeCommitmentBreakdown(m.grantId)).review_reserve_micro_usd).toBe(job!.budget_micro_usd);
    await closeBounty(s.bountyId, "withdrawn", "test");
    expect(await owlBalance(platform)).toBe(before + job!.budget_micro_usd);
    expect((await getReserveJob(s.bountyId))?.status).toBe("completed");
    expect((await prizeCommitmentBreakdown(m.grantId)).review_reserve_micro_usd).toBe(0);
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
        `INSERT INTO bounties (claim_id, formalization_id, posted_by_grant_id, amount_micro_usd, status, rules_version, rationale)
         VALUES ($1, $2, $3, 1, 'open', 'v', 'x')`,
        [s.claimId, s.formalizationId, s.grantId]
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
    expect(await prizedMicroUsd(c.id)).toBe(500 * OWL);
    // One payout row, so the mandate is consumed once.
    expect((await prizeCommitmentBreakdown(s.grantId)).paid_micro_usd).toBe(500 * OWL);
  });
});

describe("the end-to-end money path", () => {
  it("post → open → claim → check → admit → accept → audit → window → payee steps → owl grant, with the escrow invariants at every step", async () => {
    const config = loadConfig();
    await rawQuery(`UPDATE prize_claims SET status = 'withdrawn' WHERE status IN ('queued', 'checking')`);
    const platform = await getPlatformAccountId();
    const platformBefore = await owlBalance(platform);
    const m = await seedMandate(2500);
    const s = await setupBounty(500, 2500, m);
    const bounty = (await getBountyById(s.bountyId))!;
    expect(bounty.posted_by_grant_id).toBe(m.grantId);
    expect(await prizeCommitmentBreakdown(m.grantId)).toMatchObject({ held_micro_usd: 500 * OWL, paid_micro_usd: 0, review_reserve_micro_usd: 50 * OWL });
    expect(await committedOwls(m.grantId, m.jobId)).toBe(550);
    const reserve = (await getReserveJob(s.bountyId))!;
    expect(reserve.budget_micro_usd).toBe(50 * OWL);

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
    expect(Number(allocation!.amount_micro_usd)).toBeLessThanOrEqual(50 * OWL);

    // The fake checker accepts; the worker runs the Reviewer (mocked to admit) and invokes the Steward.
    const fake = new FakeLeanCheckerClient();
    const check = await processNextPrizeCheck({ client: fake });
    expect(check).toMatchObject({ status: "processed", prizeClaimId: filed.prize_claim_id, verdict: "accepted", outcome: "in_review" });
    let pc = (await getPrizeClaimById(filed.prize_claim_id))!;
    expect(pc.status).toBe("in_review");
    expect(pc.lean_check_id).not.toBeNull();
    expect((await getBountyById(s.bountyId))?.status).toBe("claim_pending");
    // A claim_pending bounty still holds.
    expect((await prizeCommitmentBreakdown(m.grantId)).held_micro_usd).toBe(500 * OWL);
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
    expect(paid).toMatchObject({ ok: true, gross_micro_usd: 500 * OWL, withholding_micro_usd: 150 * OWL, net_micro_usd: 350 * OWL, first_tranche_micro_usd: 350 * OWL, tranches: 1, bounty_status: "paid", superseded: [] });
    expect((await getPrizeClaimById(pc.id))?.status).toBe("paid");
    expect((await getBountyById(s.bountyId))?.status).toBe("paid");
    // Escrow invariants: the hold became consumption at the gross amount,
    // the reserve counts what was placed, and the winner's prized total is
    // the net.
    const term = await prizeCommitmentBreakdown(m.grantId);
    expect(term.held_micro_usd).toBe(0);
    expect(term.paid_micro_usd).toBe(500 * OWL);
    expect(term.review_reserve_micro_usd).toBe(Number(allocation!.amount_micro_usd));
    expect(term.total_micro_usd).toBe(500 * OWL + Number(allocation!.amount_micro_usd));
    expect(await committedOwls(m.grantId, m.jobId)).toBe(term.total_micro_usd / OWL);
    expect((await mandatePrizeNumbers(m.grantId))!.headroom_micro_usd).toBe(2500 * OWL - term.total_micro_usd);
    const [contrib] = await rawQuery<{ prized: string; earned: string }>(`SELECT owls_prized_micro_usd AS prized, owls_earned_micro_usd AS earned FROM contributors WHERE id = $1`, [claimant.id]);
    expect(Number(contrib!.prized)).toBe(350 * OWL);
    expect(Number(contrib!.earned)).toBe(earnedBeforePrize);
    expect(await owlBalance(claimant.id)).toBe(earnedBeforePrize + 350 * OWL);
    expect(await prizedMicroUsd(claimant.id)).toBe(350 * OWL);
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
    void owlsToMicro;
  });
});
