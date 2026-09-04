/**
 * The prize term in committed money (docs/mathematics.md §8.1, §8.6) is one
 * SQL fragment, and every statement that computes committed money carries
 * it verbatim: grantCommittedMicroUsd (the allocator, the regrant path, the
 * floor check, and the posting all read it), refundUnspentBudget's
 * settlement statement (a mandate's closing refund excludes a held bounty
 * and a paid prize), and fundGrantSelfActions' inline headroom. A drift
 * between them would let a mandate promise the same owl twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  statements: [] as string[],
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes("AS nonledger")) {
      return [{ shares: 1, outstanding: 2, nonledger: 3, regrants: 4, prizes: 5 }];
    }
    if (sql.includes("FROM grants WHERE budget_job_id")) return [{ id: "g-1" }];
    if (sql.includes("AS held")) return [{ held: 7, paid: 8, reserve: 9, total: 24 }];
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));
vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  recordOwlEntry: vi.fn(async () => null),
  OWL_REASONS: { escrowRefund: "escrow_refund" },
}));
vi.mock("../../../src/services/action-service.js", () => ({
  ASSESS_GROUP: (id: string) => `assess:${id}`,
  ensureAssessActions: vi.fn(),
}));
vi.mock("../../../src/services/queue-service.js", () => ({ enqueueSteward: vi.fn() }));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({ getGeneralMandate: vi.fn() }));

import {
  prizeCommitmentSql,
  prizeCommitmentBreakdown,
  HOLDING_BOUNTY_STATUSES,
  PRIZE_RESERVE_JOB_KIND,
} from "../../../src/services/prize-commitment.js";
import { grantCommittedMicroUsd } from "../../../src/services/regrant-service.js";
import { refundUnspentBudget } from "../../../src/services/budget-job-service.js";
import { fundGrantSelfActions } from "../../../src/services/allocation-service.js";

beforeEach(() => {
  state.statements = [];
});

describe("the fragment", () => {
  it("holds a live bounty at GREATEST(amount, paid), a closed one at paid, and adds the reserve", () => {
    const sql = prizeCommitmentSql("$1");
    for (const s of HOLDING_BOUNTY_STATUSES) expect(sql).toContain(`'${s}'`);
    expect(sql).not.toContain("'requested'");
    expect(sql).toMatch(/GREATEST\(b\.amount_micro_usd, paid\.total\)/);
    expect(sql).toMatch(/ELSE paid\.total END \+ reserve\.total/);
    expect(sql).toMatch(/pp\.status <> 'reversed'/);
    expect(sql).toContain(`j.kind = '${PRIZE_RESERVE_JOB_KIND}'`);
    expect(sql).toMatch(/WHEN j\.status = 'running' THEN j\.budget_micro_usd/);
    expect(sql).toMatch(/a\.kind = 'prize_review'/);
    expect(sql).toMatch(/WHERE b\.posted_by_grant_id = \$1/);
    expect(sql.endsWith("::bigint")).toBe(true);
  });

  it("takes any SQL expression for the grant id", () => {
    expect(prizeCommitmentSql("g.id")).toMatch(/WHERE b\.posted_by_grant_id = g\.id/);
  });
});

describe("the statements that read it", () => {
  it("grantCommittedMicroUsd carries the fragment verbatim and adds the term", async () => {
    const total = await grantCommittedMicroUsd({ id: "g-1", budgetJobId: "job-1" });
    expect(total).toBe(1 + 2 + 3 + 4 + 5);
    const sql = state.statements.find((s) => s.includes("AS nonledger"))!;
    expect(sql).toContain(`${prizeCommitmentSql("$1")} AS prizes`);
  });

  it("refundUnspentBudget's settlement statement carries the same fragment and excludes the term", async () => {
    await refundUnspentBudget({ id: "job-1", userId: "u-1", budgetMicroUsd: 100 });
    const sql = state.statements.find((s) => s.includes("AS nonledger"))!;
    expect(sql).toContain(`${prizeCommitmentSql("$1")} AS prizes`);
  });

  it("fundGrantSelfActions' inline headroom subtracts the same fragment, correlated on the grant", async () => {
    await fundGrantSelfActions();
    const sql = state.statements.find((s) => s.includes("AS headroom"))!;
    expect(sql).toContain(`- ${prizeCommitmentSql("g.id")}`);
  });

  it("the breakdown reads the same FROM clause", async () => {
    const b = await prizeCommitmentBreakdown("g-1");
    expect(b).toEqual({ held_micro_usd: 7, paid_micro_usd: 8, review_reserve_micro_usd: 9, total_micro_usd: 24 });
    const sql = state.statements.find((s) => s.includes("AS held"))!;
    expect(sql).toMatch(/GREATEST\(b\.amount_micro_usd, paid\.total\)/);
    expect(sql).toMatch(/WHERE b\.posted_by_grant_id = \$1/);
  });
});
