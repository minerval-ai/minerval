/**
 * Formal statements and checker records against a real database
 * (docs/mathematics.md §5): the publish path keeps one published statement
 * per claim and retires the previous one with `superseded_by`; a
 * canonical-form demotion returns the statement to reviewed and moves an
 * open bounty to rebinding in one transaction; the machine-checked badge
 * derives from a published statement, an accepted check, and an argument
 * citing it; and a repeated check is one row.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, pgCode } from "./helpers.js";
import {
  FakeLeanCheckerClient,
  FAKE_PIN,
} from "../../src/services/lean-checker-fake.js";
import type { CheckRecord } from "../../src/services/lean-checker-client.js";
import {
  demotePublishedFormalization,
  findLeanCheck,
  getFormalizationSummary,
  getVerificationSummary,
  leanCheckEvidenceUrl,
  leanChecksByArgument,
  listFormalizations,
  nextFormalizationVersion,
  normalizeStatementSource,
  publishFormalization,
  recordLeanCheck,
  retireFormalization,
  returnFormalizationToDraft,
  storeElaboratedFormalization,
  getBountyTerms,
  getLeanCheckPublicRecord,
  listLeanChecksForClaim,
} from "../../src/services/formalization-service.js";
import { getClaimTree, getClaimDependents } from "../../src/services/tree-service.js";
import { listClaims } from "../../src/services/claim-service.js";

const DECLARATIONS = `def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n
/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩`;

const fake = new FakeLeanCheckerClient();

/** Elaborate the convention's file for the claim's next version and store it as reviewed. */
async function storeReviewed(claimId: string, declarations = DECLARATIONS) {
  const version = await nextFormalizationVersion(claimId);
  const normalized = normalizeStatementSource(declarations, { claimId, version });
  if (!normalized.ok) throw new Error(normalized.error);
  const elaboration = await fake.elaborate({ statement_source: normalized.source });
  return storeElaboratedFormalization({
    claimId,
    version,
    statementSource: normalized.source,
    elaboration,
    correspondence: "The statement is the claim as stated.",
    reviewNotes: "Checked the vacuity list.",
    authoredBy: "claim_steward",
    status: "reviewed",
  });
}

async function checkRecord(statementSource: string, proof: string, verdict: "accepted" | "rejected" | "error", mode: "steward" | "prize" | "attempt" = "steward"): Promise<CheckRecord> {
  fake.script(proof, { verdict, failed_gate: "axioms" });
  const queued = await fake.submitCheck({
    mode,
    kind: "proof",
    statement_source: statementSource,
    submission_source: proof,
    force: true,
  });
  return fake.getCheck(queued.check_id);
}

async function seedPool(): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO prize_pools (domain) VALUES ('mathematics')
     ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id`
  );
  return rows[0]!.id;
}

async function seedBounty(claimId: string, formalizationId: string, status = "open"): Promise<string> {
  const poolId = await seedPool();
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO bounties
       (claim_id, formalization_id, pool_id, amount_micro_usd, status,
        rules_version, rationale, opened_at, updated_at)
     VALUES ($1, $2, $3, 2500000000, $4, '2026-09', 'DB test', now(), now() - interval '1 hour')
     RETURNING id`,
    [claimId, formalizationId, poolId, status]
  );
  return rows[0]!.id;
}

async function formalizationRow(id: string) {
  const rows = await rawQuery<{
    id: string;
    status: string;
    version: number;
    published_at: Date | null;
    review_period_ends_at: Date | null;
    retired_at: Date | null;
    retire_reason: string | null;
    superseded_by: string | null;
    review_notes: string | null;
  }>(
    `SELECT id, status, version, published_at, review_period_ends_at, retired_at,
            retire_reason, superseded_by, review_notes
       FROM claim_formalizations WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}

describe("the publish path", () => {
  it("publishes a reviewed statement, opens its review period, and refuses anything else", async () => {
    const claimId = await seedClaim("publish");
    const v1 = await storeReviewed(claimId);
    expect(v1.status).toBe("reviewed");
    expect(v1.namespace).toBe(`Minerval.S${claimId.replace(/-/g, "").slice(0, 8)}_v1`);
    expect(v1.reviewed_at).not.toBeNull();
    // The hashes are the checker's, not the caller's.
    expect(v1.source_hash).toBe(FakeLeanCheckerClient.sha256(`${FAKE_PIN.pin_id}\n${v1.statement_source}`));
    expect(v1.expr_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.witness_present).toBe(true);

    const { published, retired } = await publishFormalization(v1.id);
    expect(retired).toEqual([]);
    expect(published.status).toBe("published");
    expect(published.published_at).not.toBeNull();
    const days =
      (published.review_period_ends_at!.getTime() - published.published_at!.getTime()) /
      86_400_000;
    expect(days).toBeCloseTo(14, 5);

    // Published is not reviewed: a second publish of the same row is refused.
    await expect(publishFormalization(v1.id)).rejects.toThrow(/only a reviewed statement publishes/);
    expect((await getFormalizationSummary(claimId))?.id).toBe(v1.id);
  });

  it("keeps one published statement per claim: a second publish retires the first with superseded_by", async () => {
    const claimId = await seedClaim("supersede");
    const v1 = await storeReviewed(claimId);
    await publishFormalization(v1.id);
    const bountyId = await seedBounty(claimId, v1.id);

    const v2 = await storeReviewed(claimId);
    expect(v2.version).toBe(2);
    const { published, retired } = await publishFormalization(v2.id, {
      reviewNotes: "Second reviewer: faithful.",
    });
    expect(published.id).toBe(v2.id);
    expect(retired.map((r) => r.id)).toEqual([v1.id]);

    const old = await formalizationRow(v1.id);
    expect(old.status).toBe("retired");
    expect(old.retired_at).not.toBeNull();
    expect(old.superseded_by).toBe(v2.id);
    expect(old.retire_reason).toBe("superseded by version 2");
    expect((await formalizationRow(v2.id)).review_notes).toContain("Second reviewer: faithful.");

    // The bounty bound to the superseded statement is held (§8.5).
    const [bounty] = await rawQuery<{ status: string }>(
      `SELECT status FROM bounties WHERE id = $1`,
      [bountyId]
    );
    expect(bounty!.status).toBe("rebinding");

    const versions = await listFormalizations(claimId);
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, "published"],
      [1, "retired"],
    ]);
    expect((await getFormalizationSummary(claimId))?.id).toBe(v2.id);

    // The database itself refuses a second published row for the claim.
    const attempt = rawQuery(
      `UPDATE claim_formalizations SET status = 'published' WHERE id = $1`,
      [v1.id]
    );
    await expect(attempt).rejects.toSatisfy((err: unknown) => pgCode(err) === "23505");
  });

  it("returns a reviewed statement to draft with the reviewer's notes, and retires with a reason", async () => {
    const claimId = await seedClaim("draft");
    const v1 = await storeReviewed(claimId);
    const draft = await returnFormalizationToDraft(v1.id, {
      reviewNotes: "The crux was moved into a hypothesis.",
    });
    expect(draft.status).toBe("draft");
    expect(draft.review_notes).toBe("Checked the vacuity list.\n\nThe crux was moved into a hypothesis.");
    await expect(returnFormalizationToDraft(v1.id, { reviewNotes: "again" })).rejects.toThrow(/not in reviewed/);

    const { retired } = await retireFormalization(v1.id, { reason: "split: the claim was divided" });
    expect(retired.status).toBe("retired");
    expect(retired.retire_reason).toBe("split: the claim was divided");
    await expect(retireFormalization(v1.id, { reason: "x" })).rejects.toThrow(/already retired/);
  });
});

describe("demotion under a canonical-form change", () => {
  it("returns the published statement to reviewed and moves the open bounty to rebinding together", async () => {
    const claimId = await seedClaim("demote");
    const v1 = await storeReviewed(claimId);
    await publishFormalization(v1.id);
    const bountyId = await seedBounty(claimId, v1.id);
    const [before] = await rawQuery<{ updated_at: Date }>(
      `SELECT updated_at FROM bounties WHERE id = $1`,
      [bountyId]
    );

    const result = await demotePublishedFormalization(claimId, {
      reason: "canonical form changed",
    });
    expect(result.formalization?.id).toBe(v1.id);
    expect(result.formalization?.status).toBe("reviewed");
    expect(result.bounties).toEqual([bountyId]);

    const row = await formalizationRow(v1.id);
    expect(row.status).toBe("reviewed");
    expect(row.review_notes).toContain("Returned to reviewed: canonical form changed");
    const [bounty] = await rawQuery<{ status: string; updated_at: Date }>(
      `SELECT status, updated_at FROM bounties WHERE id = $1`,
      [bountyId]
    );
    expect(bounty!.status).toBe("rebinding");
    expect(bounty!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
    expect(await getFormalizationSummary(claimId)).toBeNull();

    // Idempotent: nothing is published now, so nothing is demoted.
    expect(await demotePublishedFormalization(claimId, { reason: "again" })).toEqual({
      formalization: null,
      bounties: [],
    });
  });

  it("leaves a bounty that is not open alone, and a claim without a statement untouched", async () => {
    const claimId = await seedClaim("demote-pending");
    const v1 = await storeReviewed(claimId);
    await publishFormalization(v1.id);
    const bountyId = await seedBounty(claimId, v1.id, "claim_pending");
    const result = await demotePublishedFormalization(claimId, { reason: "reworded" });
    expect(result.formalization?.id).toBe(v1.id);
    expect(result.bounties).toEqual([]);
    const [bounty] = await rawQuery<{ status: string }>(`SELECT status FROM bounties WHERE id = $1`, [bountyId]);
    expect(bounty!.status).toBe("claim_pending");

    const bare = await seedClaim("no-statement");
    expect(await demotePublishedFormalization(bare, { reason: "reworded" })).toEqual({
      formalization: null,
      bounties: [],
    });
  });
});

describe("checker records", () => {
  it("records a check once per (formalization, hash, checker version, mode) and updates it on a repeat", async () => {
    const claimId = await seedClaim("dedup");
    const v1 = await storeReviewed(claimId);
    const proof = `theorem ${v1.namespace}.proof : ${v1.namespace}.Statement := by exact proof_${randomUUID()}`;
    const first = await recordLeanCheck({
      formalizationId: v1.id,
      record: await checkRecord(v1.statement_source, proof, "rejected"),
      submissionSource: proof,
      submittedBy: "claim_steward",
    });
    expect(first.verdict).toBe("rejected");
    expect(first.cost_micro_usd).toBeGreaterThan(0);

    const again = await recordLeanCheck({
      formalizationId: v1.id,
      record: await checkRecord(v1.statement_source, proof, "accepted"),
      submissionSource: proof,
      submittedBy: "claim_steward",
      attemptId: null,
    });
    expect(again.id).toBe(first.id);
    expect(again.verdict).toBe("accepted");
    const [count] = await rawQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM lean_checks WHERE formalization_id = $1`,
      [v1.id]
    );
    expect(count!.n).toBe("1");

    const found = await findLeanCheck({
      formalizationId: v1.id,
      submissionSha256: FakeLeanCheckerClient.sha256(proof),
      checkerVersion: FAKE_PIN.checker_version,
      mode: "steward",
    });
    expect(found?.id).toBe(first.id);
    // A different mode is a different row.
    const prize = await recordLeanCheck({
      formalizationId: v1.id,
      record: await checkRecord(v1.statement_source, proof, "accepted", "prize"),
      submissionSource: proof,
      submittedBy: `contributor:${randomUUID()}`,
    });
    expect(prize.id).not.toBe(first.id);

    // The public record: a Steward check bound to no attempt and no prize
    // claim carries its source; every gate travels with it.
    const record = await getLeanCheckPublicRecord(first.id);
    expect(record).toMatchObject({
      id: first.id,
      claim_id: claimId,
      namespace: v1.namespace,
      mode: "steward",
      verdict: "accepted",
      source_public: true,
      submission_source: proof,
      checker_version: FAKE_PIN.checker_version,
    });
    expect((record!.checks as Record<string, { status: string }>).axioms.status).toBe("pass");
    expect(await getLeanCheckPublicRecord(randomUUID())).toBeNull();

    // The claim's check list carries every mode, newest first, without source.
    const listed = await listLeanChecksForClaim(claimId);
    expect(listed.map((c) => c.mode).sort()).toEqual(["prize", "steward"]);
    expect(listed.every((c) => !("submission_source" in c))).toBe(true);
    expect(listed.find((c) => c.id === first.id)).toMatchObject({
      kind: "proof",
      verdict: "accepted",
      failed_gate: null,
      formalization_id: v1.id,
    });
  });
});

describe("the machine-checked badge", () => {
  it("derives from a published statement, an accepted check, and an argument citing it", async () => {
    const claimId = await seedClaim("badge");
    const v1 = await storeReviewed(claimId);
    const proof = `theorem ${v1.namespace}.proof : ${v1.namespace}.Statement := by exact proof_${randomUUID()}`;
    const check = await recordLeanCheck({
      formalizationId: v1.id,
      record: await checkRecord(v1.statement_source, proof, "accepted"),
      submissionSource: proof,
      submittedBy: "claim_steward",
    });

    // Not published yet: no badge, whatever the check says.
    expect(await getVerificationSummary(claimId)).toBeNull();
    await publishFormalization(v1.id);

    // Published, accepted, but no argument cites the check: still no badge.
    expect(await getVerificationSummary(claimId)).toBeNull();
    const [tree0] = [await getClaimTree(claimId)];
    expect(tree0).toMatchObject({ formal: true, checked: null, bounty_micro_usd: null });

    // A rejected check cited by an argument is not a badge either.
    const rejectedProof = `theorem ${v1.namespace}.proof : ${v1.namespace}.Statement := by exact bad_${randomUUID()}`;
    const rejected = await recordLeanCheck({
      formalizationId: v1.id,
      record: await checkRecord(v1.statement_source, rejectedProof, "rejected"),
      submissionSource: rejectedProof,
      submittedBy: "claim_steward",
    });
    await rawQuery(
      `INSERT INTO arguments (claim_id, stance, content, evidence_urls, created_by)
       VALUES ($1, 'for', 'A failed attempt', ARRAY[$2::text], 'claim_steward')`,
      [claimId, leanCheckEvidenceUrl(rejected.id)]
    );
    expect(await getVerificationSummary(claimId)).toBeNull();

    // An argument citing the accepted check, by an absolute URL: the badge.
    const [argument] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, name, stance, content, evidence_urls, created_by)
       VALUES ($1, 'Proof by strong induction (machine-checked)', 'for', 'The proof checks.',
               ARRAY[$2::text, 'https://example.org/paper'], 'claim_steward')
       RETURNING id`,
      [claimId, `https://api.minerval.ai${leanCheckEvidenceUrl(check.id)}`]
    );
    const badge = await getVerificationSummary(claimId);
    expect(badge).toEqual({
      kind: "proof",
      lean_check_id: check.id,
      checked_at: expect.any(String),
      formalization_id: v1.id,
      pin_id: FAKE_PIN.pin_id,
    });

    const byArgument = await leanChecksByArgument(claimId);
    expect(byArgument.get(argument!.id)).toMatchObject({ id: check.id, kind: "proof", verdict: "accepted" });
    expect(byArgument.size).toBe(1);

    // The same derivation feeds the tree, the dependents, and the list.
    const bountyId = await seedBounty(claimId, v1.id);
    const tree = await getClaimTree(claimId);
    expect(tree).toMatchObject({ formal: true, checked: "proof", bounty_micro_usd: 2_500_000_000 });

    const parent = await seedClaim("badge-parent");
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'rests on it')`,
      [parent, claimId]
    );
    const parentTree = await getClaimTree(parent);
    expect(parentTree!.children[0]).toMatchObject({ id: claimId, checked: "proof", formal: true });
    const dependents = await getClaimDependents(claimId);
    expect(dependents[0]).toMatchObject({ id: parent, formal: false, checked: null, bounty_micro_usd: null });

    const listed = (await listClaims({ limit: 100, withPrizes: true })).results.find((r) => r.id === claimId);
    expect(listed).toMatchObject({ prize_micro_usd: 2_500_000_000, checked: "proof" });

    // Retiring the statement removes the badge: the check is no longer on a published statement.
    await rawQuery(`UPDATE bounties SET status = 'withdrawn' WHERE id = $1`, [bountyId]);
    await retireFormalization(v1.id, { reason: "test" });
    expect(await getVerificationSummary(claimId)).toBeNull();
  });

  it("reads the live bounty's terms from the row", async () => {
    const claimId = await seedClaim("terms");
    expect(await getBountyTerms(claimId)).toBeNull();
    const v1 = await storeReviewed(claimId);
    await publishFormalization(v1.id);
    const bountyId = await seedBounty(claimId, v1.id);
    const terms = await getBountyTerms(claimId);
    expect(terms).toMatchObject({
      claim_id: claimId,
      bounty_id: bountyId,
      amount_micro_usd: 2_500_000_000,
      status: "open",
      rules_version: "2026-09",
      allowed_axioms: ["propext", "Classical.choice", "Quot.sound"],
      formalization: { id: v1.id, source_hash: v1.source_hash, expr_hash: v1.expr_hash, pin_id: FAKE_PIN.pin_id },
      window: { state: "review_period", accepting_claims: false },
    });
    expect(terms!.formalization.statement_url).toMatch(new RegExp(`/claims/${claimId}/formalization\\.lean$`));
  });
});
