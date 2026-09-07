/**
 * The mathematics schema (docs/mathematics.md §5.1, §7.9, §8.1, §8.4,
 * §8.7), exercised against a database migrated from zero: every table and
 * column exists, the prize fund is gone (a bounty holds against the escrow
 * of the mandate that posted it, so `posted_by_grant_id` is NOT NULL and no
 * pool table exists), and the backstops the design relies on hold: one
 * published statement per claim, one live bounty per claim, one live prize
 * claim per claimant per statement, the money CHECKs, and ON DELETE
 * RESTRICT under a claim that carries money.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedUser, seedClaim, seedGrantWithJob, pgCode } from "./helpers.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

async function seedFormalization(input: {
  claimId: string;
  version?: number;
  status?: string;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_formalizations
       (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
        namespace, statement_source, source_hash, expr_hash, pp_type,
        constants, definitions_axioms, witness_present, status, authored_by)
     VALUES ($1, $2, 'mathlib-v4.33.1', 'leanprover/lean4:v4.33.1', $3,
             'sha256:img', $4, 'def Statement : Prop := True', $5, $6,
             'True', '[]', '[]', false, $7, 'claim_steward')
     RETURNING id`,
    [
      input.claimId,
      input.version ?? 1,
      randomUUID().replace(/-/g, ""),
      `Minerval.S${randomUUID().slice(0, 8)}_v${input.version ?? 1}`,
      `src-${randomUUID()}`,
      `expr-${randomUUID()}`,
      input.status ?? "published",
    ]
  );
  return rows[0]!.id;
}

/** The mandate a bounty holds against (§8.1). */
async function seedPostingMandate(): Promise<string> {
  const funder = await seedUser("bounty-mandate");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 2_500_000_000 });
  return grantId;
}

async function seedBounty(input: {
  claimId: string;
  formalizationId: string;
  grantId: string;
  status?: string;
  amountMicroUsd?: number;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO bounties
       (claim_id, formalization_id, posted_by_grant_id, amount_micro_usd, status,
        rules_version, rationale)
     VALUES ($1, $2, $3, $4, $5, 'rules-v1', 'DB-test bounty')
     RETURNING id`,
    [
      input.claimId,
      input.formalizationId,
      input.grantId,
      input.amountMicroUsd ?? 250_000_000,
      input.status ?? "open",
    ]
  );
  return rows[0]!.id;
}

async function seedContribution(input: {
  claimId: string;
  contributorId: string;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO contributions
       (claim_id, contributor_id, contribution_type, content, review_status)
     VALUES ($1, $2, 'claim_prize', 'DB-test prize claim account', 'checking')
     RETURNING id`,
    [input.claimId, input.contributorId]
  );
  return rows[0]!.id;
}

async function seedPrizeClaim(input: {
  contributionId: string;
  bountyId: string;
  claimId: string;
  formalizationId: string;
  claimantId: string;
  status?: string;
}): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO prize_claims
       (contribution_id, bounty_id, claim_id, formalization_id, claimant_id,
        direction, status, rules_version)
     VALUES ($1, $2, $3, $4, $5, 'proof', $6, 'rules-v1')
     RETURNING id`,
    [
      input.contributionId,
      input.bountyId,
      input.claimId,
      input.formalizationId,
      input.claimantId,
      input.status ?? "queued",
    ]
  );
  return rows[0]!.id;
}

/** A claim with a published statement, a posting mandate, and one open bounty. */
async function bountyFixture(label: string) {
  const claimId = await seedClaim(label);
  const formalizationId = await seedFormalization({ claimId });
  const grantId = await seedPostingMandate();
  const bountyId = await seedBounty({ claimId, formalizationId, grantId });
  return { claimId, formalizationId, grantId, bountyId };
}

describe("migrations 0044 through 0047 (mathematics)", () => {
  it("created every new table, and the prize fund's two tables are gone", async () => {
    const rows = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('claim_formalizations', 'lean_checks', 'proof_attempts',
           'platform_flags', 'prize_pools', 'prize_pool_entries', 'bounties',
           'prize_claims', 'prize_payouts', 'attachments')
        ORDER BY table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "attachments",
      "bounties",
      "claim_formalizations",
      "lean_checks",
      "platform_flags",
      "prize_claims",
      "prize_payouts",
      "proof_attempts",
    ]);
  });

  it("a bounty names the mandate whose escrow it holds against, and carries no pool", async () => {
    const rows = await rawQuery<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bounties'
          AND column_name IN ('pool_id', 'posted_by_grant_id', 'amount_micro_usd')
        ORDER BY column_name`
    );
    expect(rows.map((r) => [r.column_name, r.is_nullable, r.data_type])).toEqual([
      ["amount_micro_usd", "NO", "bigint"],
      ["posted_by_grant_id", "NO", "uuid"],
    ]);
    const claimId = await seedClaim("bounty-no-mandate");
    const formalizationId = await seedFormalization({ claimId });
    await expect(
      rawQuery(
        `INSERT INTO bounties (claim_id, formalization_id, amount_micro_usd, status, rules_version, rationale)
         VALUES ($1, $2, 1, 'open', 'v', 'x')`,
        [claimId, formalizationId]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "23502");
  });

  it("a formal statement records whether it introduces the Steward's own definitions (§5.4)", async () => {
    const [col] = await rawQuery<{ data_type: string; is_nullable: string; column_default: string }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'claim_formalizations'
          AND column_name = 'own_definitions'`
    );
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
  });

  it("added the new columns on contributors, contributions, and llm_usage", async () => {
    const rows = await rawQuery<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND (
          (table_name = 'contributors' AND column_name IN
             ('owls_prized_micro_usd', 'prize_ineligible'))
          OR (table_name = 'contributions' AND column_name IN
             ('challenged_formalization_id', 'challenged_prize_claim_id'))
          OR (table_name = 'llm_usage' AND column_name IN
             ('external_units', 'external_unit_kind')))
        ORDER BY table_name, column_name`
    );
    const byName = Object.fromEntries(
      rows.map((r) => [`${r.table_name}.${r.column_name}`, r])
    );
    expect(Object.keys(byName).sort()).toEqual([
      "contributions.challenged_formalization_id",
      "contributions.challenged_prize_claim_id",
      "contributors.owls_prized_micro_usd",
      "contributors.prize_ineligible",
      "llm_usage.external_unit_kind",
      "llm_usage.external_units",
    ]);
    expect(byName["contributors.owls_prized_micro_usd"]!.data_type).toBe("bigint");
    expect(byName["contributors.owls_prized_micro_usd"]!.is_nullable).toBe("NO");
    expect(byName["contributors.owls_prized_micro_usd"]!.column_default).toBe("0");
    expect(byName["contributors.prize_ineligible"]!.data_type).toBe("boolean");
    expect(byName["contributors.prize_ineligible"]!.column_default).toBe("false");
    expect(byName["contributions.challenged_formalization_id"]!.data_type).toBe("uuid");
    expect(byName["contributions.challenged_prize_claim_id"]!.data_type).toBe("uuid");
    expect(byName["llm_usage.external_units"]!.data_type).toBe("numeric");
    expect(byName["llm_usage.external_units"]!.is_nullable).toBe("YES");
    expect(byName["llm_usage.external_unit_kind"]!.data_type).toBe("text");
  });

  it("installed the partial unique indexes, unique constraints, and CHECKs", async () => {
    const indexes = await rawQuery<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN
         ('uq_formalization_published', 'uq_bounty_live_per_claim',
          'uq_prize_claim_live_per_claimant',
          'idx_lean_checks_formalization', 'idx_lean_checks_submission_sha256',
          'idx_proof_attempts_claim', 'idx_proof_attempts_status',
          'idx_bounties_claim', 'idx_bounties_status',
          'idx_prize_claims_bounty_status', 'idx_prize_claims_claimant',
          'idx_attachments_contribution', 'idx_prize_pool_entries_pool')
        ORDER BY indexname`
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      "idx_attachments_contribution",
      "idx_bounties_claim",
      "idx_bounties_status",
      "idx_lean_checks_formalization",
      "idx_lean_checks_submission_sha256",
      "idx_prize_claims_bounty_status",
      "idx_prize_claims_claimant",
      "idx_proof_attempts_claim",
      "idx_proof_attempts_status",
      "uq_bounty_live_per_claim",
      "uq_formalization_published",
      "uq_prize_claim_live_per_claimant",
    ]);
    const def = (name: string) =>
      indexes.find((i) => i.indexname === name)!.indexdef;
    expect(def("uq_formalization_published")).toMatch(
      /UNIQUE INDEX .* WHERE \(status = 'published'::text\)/
    );
    expect(def("uq_bounty_live_per_claim")).toMatch(/UNIQUE INDEX/);
    for (const s of [
      "requested",
      "confirm_pending",
      "open",
      "claim_pending",
      "house_result_pending",
      "rebinding",
    ]) {
      expect(def("uq_bounty_live_per_claim")).toContain(`'${s}'`);
    }

    const constraints = await rawQuery<{ conname: string; contype: string }>(
      `SELECT conname, contype FROM pg_constraint WHERE conname IN
         ('uq_claim_formalizations_claim_version', 'uq_lean_checks_submission',
          'ck_bounties_amount', 'ck_prize_pool_entries_reason',
          'ck_prize_payouts_amount', 'ck_prize_payouts_withholding',
          'ck_proof_attempts_ceiling', 'ck_proof_attempts_spent',
          'ck_attachments_body_location', 'ck_attachments_size',
          'ck_prize_claims_defect_award', 'ck_prize_claims_window_paused')
        ORDER BY conname`
    );
    expect(constraints.map((c) => `${c.conname}:${c.contype}`)).toEqual([
      "ck_attachments_body_location:c",
      "ck_attachments_size:c",
      "ck_bounties_amount:c",
      "ck_prize_claims_defect_award:c",
      "ck_prize_claims_window_paused:c",
      "ck_prize_payouts_amount:c",
      "ck_prize_payouts_withholding:c",
      "ck_proof_attempts_ceiling:c",
      "ck_proof_attempts_spent:c",
      "uq_claim_formalizations_claim_version:u",
      "uq_lean_checks_submission:u",
    ]);
  });

  it("uses ON DELETE RESTRICT where the design says so", async () => {
    const rows = await rawQuery<{
      conrelid: string;
      confrelid: string;
      confdeltype: string;
    }>(
      `SELECT conrelid::regclass::text AS conrelid,
              confrelid::regclass::text AS confrelid, confdeltype
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text IN
              ('claim_formalizations', 'bounties', 'prize_claims')
          AND confrelid::regclass::text IN ('claims', 'claim_formalizations')
        ORDER BY conrelid, confrelid`
    );
    const restrict = rows.filter((r) => r.confdeltype === "r");
    expect(restrict.map((r) => `${r.conrelid}->${r.confrelid}`)).toEqual([
      "bounties->claim_formalizations",
      "bounties->claims",
      "claim_formalizations->claims",
      "prize_claims->claims",
    ]);
  });
});

describe("uq_formalization_published (one published statement per claim)", () => {
  it("rejects a second published statement, accepts a draft beside it", async () => {
    const claimId = await seedClaim("formalization-published");
    await seedFormalization({ claimId, version: 1, status: "published" });
    await expect(
      seedFormalization({ claimId, version: 2, status: "published" })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
    await expect(
      seedFormalization({ claimId, version: 2, status: "draft" })
    ).resolves.toBeTruthy();
  });

  it("frees the slot once the published statement retires", async () => {
    const claimId = await seedClaim("formalization-retired");
    const v1 = await seedFormalization({ claimId, version: 1 });
    await rawQuery(
      `UPDATE claim_formalizations SET status = 'retired', retired_at = now()
        WHERE id = $1`,
      [v1]
    );
    await expect(
      seedFormalization({ claimId, version: 2, status: "published" })
    ).resolves.toBeTruthy();
  });

  it("keeps (claim_id, version) unique whatever the status", async () => {
    const claimId = await seedClaim("formalization-version");
    await seedFormalization({ claimId, version: 1, status: "retired" });
    await expect(
      seedFormalization({ claimId, version: 1, status: "draft" })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
  });
});

describe("lean_checks", () => {
  it("dedups a submission per (formalization, sha256, checker version, mode)", async () => {
    const claimId = await seedClaim("lean-check");
    const formalizationId = await seedFormalization({ claimId });
    const insert = (mode: string, version = "1.0.0") =>
      rawQuery(
        `INSERT INTO lean_checks
           (formalization_id, mode, kind, submission_sha256, submission_source,
            submitted_by, verdict, checks, diagnostics, resource, pin_id,
            image_digest, checker_version)
         VALUES ($1, $2, 'proof', 'sha-fixed', 'theorem proof : Statement := trivial',
                 'claim_steward', 'accepted', '{}', '[]', '{}',
                 'mathlib-v4.33.1', 'sha256:img', $3)`,
        [formalizationId, mode, version]
      );
    await insert("steward");
    await expect(insert("steward")).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === UNIQUE_VIOLATION
    );
    // A different mode or checker version is a different check.
    await expect(insert("prize")).resolves.toBeTruthy();
    await expect(insert("steward", "1.0.1")).resolves.toBeTruthy();
  });
});

describe("bounties", () => {
  it("rejects a non-positive amount", async () => {
    const claimId = await seedClaim("bounty-amount");
    const formalizationId = await seedFormalization({ claimId });
    const grantId = await seedPostingMandate();
    for (const amount of [0, -1]) {
      await expect(
        seedBounty({ claimId, formalizationId, grantId, amountMicroUsd: amount })
      ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
    }
  });

  it("uq_bounty_live_per_claim: one live bounty per claim across every live status", async () => {
    const { claimId, formalizationId, grantId } = await bountyFixture("bounty-live");
    for (const status of [
      "requested",
      "confirm_pending",
      "open",
      "claim_pending",
      "house_result_pending",
      "rebinding",
    ]) {
      await expect(
        seedBounty({ claimId, formalizationId, grantId, status })
      ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
    }
  });

  it("a terminal bounty does not block a new one", async () => {
    const { claimId, formalizationId, grantId, bountyId } =
      await bountyFixture("bounty-terminal");
    await rawQuery(
      `UPDATE bounties SET status = 'resolved_unpaid', resolved_at = now()
        WHERE id = $1`,
      [bountyId]
    );
    await expect(
      seedBounty({ claimId, formalizationId, grantId, status: "open" })
    ).resolves.toBeTruthy();
  });

  it("ON DELETE RESTRICT: a claim with a bounty cannot be deleted", async () => {
    const { claimId } = await bountyFixture("bounty-restrict");
    await expect(
      rawQuery(`DELETE FROM claims WHERE id = $1`, [claimId])
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === FK_VIOLATION);
  });

  it("ON DELETE RESTRICT: a claim with only a formal statement cannot be deleted either", async () => {
    const claimId = await seedClaim("formalization-restrict");
    await seedFormalization({ claimId });
    await expect(
      rawQuery(`DELETE FROM claims WHERE id = $1`, [claimId])
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === FK_VIOLATION);
  });
});

describe("prize_claims", () => {
  it("one prize claim per contribution", async () => {
    const f = await bountyFixture("prize-claim-contribution");
    const claimant = await seedUser("prize-claimant");
    const contributionId = await seedContribution({
      claimId: f.claimId,
      contributorId: claimant,
    });
    const base = { ...f, claimantId: claimant, contributionId };
    await seedPrizeClaim(base);
    await expect(
      seedPrizeClaim({ ...base, status: "rejected" })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
  });

  it("uq_prize_claim_live_per_claimant: one live claim per claimant per statement", async () => {
    const f = await bountyFixture("prize-claim-live");
    const claimant = await seedUser("prize-claimant-live");
    const other = await seedUser("prize-claimant-other");
    const c1 = await seedContribution({ claimId: f.claimId, contributorId: claimant });
    const c2 = await seedContribution({ claimId: f.claimId, contributorId: claimant });
    const c3 = await seedContribution({ claimId: f.claimId, contributorId: other });
    const first = await seedPrizeClaim({
      ...f,
      claimantId: claimant,
      contributionId: c1,
      status: "in_challenge_window",
    });
    // The same claimant, a second live filing on the same statement: refused.
    await expect(
      seedPrizeClaim({ ...f, claimantId: claimant, contributionId: c2 })
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
    // Another claimant on the same statement: fine.
    await expect(
      seedPrizeClaim({ ...f, claimantId: other, contributionId: c3 })
    ).resolves.toBeTruthy();
    // Once the first is terminal, the same claimant may file again.
    await rawQuery(
      `UPDATE prize_claims SET status = 'voided' WHERE id = $1`,
      [first]
    );
    await expect(
      seedPrizeClaim({ ...f, claimantId: claimant, contributionId: c2 })
    ).resolves.toBeTruthy();
  });

  it("a contribution with a prize claim cannot be deleted, and the challenge columns point back", async () => {
    const f = await bountyFixture("prize-claim-challenge");
    const claimant = await seedUser("prize-claimant-ch");
    const contributionId = await seedContribution({
      claimId: f.claimId,
      contributorId: claimant,
    });
    const prizeClaimId = await seedPrizeClaim({
      ...f,
      claimantId: claimant,
      contributionId,
    });
    await expect(
      rawQuery(`DELETE FROM contributions WHERE id = $1`, [contributionId])
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === FK_VIOLATION);

    const challenger = await seedUser("prize-challenger");
    const [challenge] = await rawQuery<{ id: string }>(
      `INSERT INTO contributions
         (claim_id, contributor_id, contribution_type, content,
          challenged_formalization_id, challenged_prize_claim_id)
       VALUES ($1, $2, 'challenge', 'the statement is vacuous', $3, $4)
       RETURNING id`,
      [f.claimId, challenger, f.formalizationId, prizeClaimId]
    );
    const [row] = await rawQuery<{
      challenged_formalization_id: string;
      challenged_prize_claim_id: string;
    }>(
      `SELECT challenged_formalization_id, challenged_prize_claim_id
         FROM contributions WHERE id = $1`,
      [challenge!.id]
    );
    expect(row!.challenged_formalization_id).toBe(f.formalizationId);
    expect(row!.challenged_prize_claim_id).toBe(prizeClaimId);
    // A dangling pointer is refused.
    await expect(
      rawQuery(
        `UPDATE contributions SET challenged_prize_claim_id = $2 WHERE id = $1`,
        [challenge!.id, randomUUID()]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === FK_VIOLATION);
  });
});

describe("prize_payouts", () => {
  async function payoutFixture(label: string) {
    const f = await bountyFixture(label);
    const claimant = await seedUser(label);
    const contributionId = await seedContribution({
      claimId: f.claimId,
      contributorId: claimant,
    });
    const prizeClaimId = await seedPrizeClaim({
      ...f,
      claimantId: claimant,
      contributionId,
      status: "payable",
    });
    return { prizeClaimId };
  }

  it("withholding never exceeds the amount, and the amount is positive", async () => {
    const { prizeClaimId } = await payoutFixture("payout-check");
    const insert = (amount: number, withholding: number) =>
      rawQuery(
        `INSERT INTO prize_payouts
           (prize_claim_id, kind, amount_micro_usd, withholding_micro_usd,
            idempotency_key)
         VALUES ($1, 'owls', $2, $3, $4)`,
        [prizeClaimId, amount, withholding, `prize:${randomUUID()}:owls`]
      );
    await expect(insert(0, 0)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    await expect(insert(1_000_000, 1_000_001)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    await expect(insert(1_000_000, -1)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    await expect(insert(1_000_000, 300_000)).resolves.toBeTruthy();
  });

  it("the idempotency key yields one payout row", async () => {
    const { prizeClaimId } = await payoutFixture("payout-idem");
    const insert = () =>
      rawQuery(
        `INSERT INTO prize_payouts
           (prize_claim_id, kind, amount_micro_usd, idempotency_key)
         VALUES ($1, 'owls', 1000000, $2)`,
        [prizeClaimId, `prize:${prizeClaimId}:owls`]
      );
    await insert();
    await expect(insert()).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === UNIQUE_VIOLATION
    );
  });
});

describe("attachments", () => {
  it("the body lives where `storage` says it does", async () => {
    const claimId = await seedClaim("attachment");
    const owner = await seedUser("attachment-owner");
    const contributionId = await seedContribution({ claimId, contributorId: owner });
    const insert = (storage: string, body: Buffer | null, key: string | null) =>
      rawQuery(
        `INSERT INTO attachments
           (contribution_id, owner_id, kind, filename, content_type,
            size_bytes, sha256, storage, body, storage_key)
         VALUES ($1, $2, 'lean_source', 'proof.lean', 'text/plain', $3, $4,
                 $5, $6, $7)`,
        [
          contributionId,
          owner,
          body?.length ?? 0,
          `sha-${randomUUID()}`,
          storage,
          body,
          key,
        ]
      );
    await expect(insert("db", null, null)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    await expect(insert("s3", null, null)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    await expect(
      insert("db", Buffer.from("theorem proof : Statement := trivial"), null)
    ).resolves.toBeTruthy();
    await expect(insert("s3", null, "attachments/abc")).resolves.toBeTruthy();
    const [row] = await rawQuery<{ body: Buffer; visibility: string }>(
      `SELECT body, visibility FROM attachments
        WHERE contribution_id = $1 AND storage = 'db'`,
      [contributionId]
    );
    expect(row!.body.toString("utf8")).toContain("theorem proof");
    expect(row!.visibility).toBe("restricted");
  });
});

describe("proof_attempts and platform_flags", () => {
  it("an attempt needs a positive ceiling and defaults to running", async () => {
    const claimId = await seedClaim("attempt");
    const formalizationId = await seedFormalization({ claimId });
    const insert = (ceiling: number) =>
      rawQuery<{ id: string; status: string; is_calibration: boolean }>(
        `INSERT INTO proof_attempts
           (claim_id, formalization_id, model, variant, effort, ceiling_micro_usd)
         VALUES ($1, $2, 'claude-fable-5-1', 'max', 'max', $3)
         RETURNING id, status, is_calibration`,
        [claimId, formalizationId, ceiling]
      );
    await expect(insert(0)).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === CHECK_VIOLATION
    );
    const [row] = await insert(187_500_000);
    expect(row!.status).toBe("running");
    expect(row!.is_calibration).toBe(false);
  });

  it("platform_flags is a key/value switch", async () => {
    const key = `dbtest_solver_paused_${randomUUID().slice(0, 8)}`;
    await rawQuery(
      `INSERT INTO platform_flags (key, value) VALUES ($1, 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key]
    );
    const [row] = await rawQuery<{ value: boolean }>(
      `SELECT value FROM platform_flags WHERE key = $1`,
      [key]
    );
    expect(row!.value).toBe(true);
  });
});
