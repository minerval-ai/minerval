/**
 * The route gate (docs/mathematics.md §8.4): every refusal code, in order,
 * and the one-transaction insert on success. The database is a scripted
 * fake keyed on the SQL each step issues.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  claim: { id: "claim-1", state: "active" } as { id: string; state: string } | null,
  bounty: null as Record<string, unknown> | null,
  house: false,
  dup: false,
  counts: { per_statement: 0, platform_today: 0, claimant_today: 0 },
  history: [] as Array<{ submitted_at: Date; updated_at: Date; status: string; rejected_stage: string | null }>,
  bountyStatusInTx: "open",
  tx: [] as Array<{ sql: string; params: unknown[] }>,
  transactions: 0,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM claims WHERE id = $1") && sql.includes("state")) return state.claim ? [state.claim] : [];
    if (sql.includes("FROM bounties") && sql.includes("status = ANY")) return state.bounty ? [state.bounty] : [];
    if (sql.includes("FROM bounties WHERE id = $1")) return state.bounty ? [state.bounty] : [];
    if (sql.includes("FROM proof_attempts pa")) return state.house ? [{ id: "attempt-1" }] : [];
    if (sql.includes("AS per_statement")) return [state.counts];
    if (sql.includes("FROM prize_claims WHERE claimant_id")) return state.dup ? [{ id: "pc-dup" }] : [];
    if (sql.includes("SELECT submitted_at, updated_at, status, rejected_stage")) return state.history;
    if (sql.includes("FROM prize_claims WHERE id = $1")) {
      return [{ id: "pc-1", contribution_id: "co-1", bounty_id: "b-1", claim_id: "claim-1", formalization_id: "f-1", claimant_id: "u-1", direction: "proof", status: "queued", rejected_stage: null, lean_check_id: null, check_attempts: 0, tie_group: null, steward_decision: null, result_category: null, defect_award_micro_usd: null, window_ends_at: null, window_paused_ms: 0, audit_outcome: null, signed_off_at: null, signed_off_by: null, payee: null, credit_name: "Ada", tools_disclosure: "none", declarations: {}, rules_version: "x", submitted_at: new Date(), updated_at: new Date(), created_at: new Date() }];
    }
    void params;
    return [];
  }),
  withTransaction: vi.fn(async (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
    state.transactions++;
    const tx = {
      query: async (sql: string, params: unknown[] = []) => {
        state.tx.push({ sql, params });
        if (sql.includes("FOR SHARE")) return [{ status: state.bountyStatusInTx }];
        if (sql.includes("INSERT INTO contributions")) return [{ id: "co-1", submitted_at: new Date("2026-03-01T00:00:00.123456Z") }];
        if (sql.includes("INSERT INTO attachments")) return [{ id: `att-${state.tx.length}` }];
        if (sql.includes("INSERT INTO prize_claims")) return [{ id: "pc-1" }];
        if (sql.includes("SET tie_group")) return [{ tie_group: null }];
        if (sql.includes("INSERT INTO actions")) return [{ id: "act-1" }];
        if (sql.includes("FROM budget_jobs")) return [{ id: "job-1", user_id: "platform", budget_micro_usd: 50_000_000, status: "running" }];
        if (sql.includes("SUM(al.amount_micro_usd)")) return [{ total: 0 }];
        return [];
      },
    };
    return fn(tx);
  }),
}));

vi.mock("../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: vi.fn(async () => ({ standardMicroUsd: 100_000, strongMicroUsd: 500_000 })),
}));
vi.mock("../../../src/services/claim-events-service.js", () => ({
  emitClaimEvent: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: vi.fn(async () => ({ id: "platform" })),
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  requestAudit: vi.fn(async () => "run-1"),
}));

import { filePrizeClaim } from "../../../src/services/prize-claim-service.js";
import { PRIZE_RULES_VERSION } from "../../../src/services/bounty-service.js";

const LEAN = "theorem Minerval.S00000000_v1.proof : True := trivial\n";

function claimant(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    externalId: "github:1",
    reputationScore: 55,
    createdAt: new Date("2025-01-01"),
    prizeIneligible: false,
    isSuspended: false,
    ...overrides,
  };
}

function bounty(overrides: Record<string, unknown> = {}) {
  return {
    id: "b-1",
    claim_id: "claim-1",
    formalization_id: "f-1",
    pool_id: "pool-1",
    condition_type: "lean_statement",
    resolution: "either",
    amount_micro_usd: 500_000_000,
    status: "open",
    rules_version: PRIZE_RULES_VERSION,
    posted_by_grant_id: null,
    rationale: "x",
    requested_at: new Date(),
    opened_at: new Date(),
    expires_at: null,
    human_confirmed_at: null,
    human_confirmed_by: null,
    withdraw_effective_at: null,
    resolved_at: null,
    resolution_note: null,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    claimId: "claim-1",
    claimant: claimant(),
    formalizationId: "f-1",
    direction: "proof",
    content: "A written account of the approach. ".repeat(10),
    links: [],
    leanSource: { filename: "proof.lean", body: Buffer.from(LEAN) },
    documents: [],
    toolsDisclosure: "Lean 4 with Mathlib; no AI assistance.",
    residency: { country: "GB", us_person: false },
    creditName: "Ada",
    declarations: { eligibility: true, understanding: true, cc0: true },
    rulesVersion: PRIZE_RULES_VERSION,
    ...overrides,
  } as Parameters<typeof filePrizeClaim>[0];
}

beforeEach(() => {
  state.claim = { id: "claim-1", state: "active" };
  state.bounty = bounty();
  state.house = false;
  state.dup = false;
  state.counts = { per_statement: 0, platform_today: 0, claimant_today: 0 };
  state.history = [];
  state.bountyStatusInTx = "open";
  state.tx = [];
  state.transactions = 0;
});

describe("the route gate, in §8.4's order", () => {
  it("404 NOT_FOUND for a missing or inactive claim", async () => {
    state.claim = null;
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    state.claim = { id: "claim-1", state: "merged" };
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
  });

  it("409 NO_OPEN_BOUNTY when there is no bounty, when it is claim_pending or house_result_pending, and after a completed attempt's finished_at", async () => {
    state.bounty = null;
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 409, code: "NO_OPEN_BOUNTY" });
    state.bounty = bounty({ status: "claim_pending" });
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 409, code: "NO_OPEN_BOUNTY" });
    state.bounty = bounty({ status: "house_result_pending" });
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 409, code: "NO_OPEN_BOUNTY" });
    state.bounty = bounty();
    state.house = true;
    const r = await filePrizeClaim(input());
    expect(r).toMatchObject({ ok: false, status: 409, code: "NO_OPEN_BOUNTY" });
    if (!r.ok) expect(r.message).toMatch(/solver/);
  });

  it("409 STATEMENT_NOT_CURRENT when the form was opened on another statement", async () => {
    expect(await filePrizeClaim(input({ formalizationId: "f-old" }))).toMatchObject({ ok: false, status: 409, code: "STATEMENT_NOT_CURRENT" });
  });

  it("403 INELIGIBLE for the platform account, a prize_ineligible account, and below probationary standing", async () => {
    expect(await filePrizeClaim(input({ claimant: claimant({ externalId: "platform:minerval" }) }))).toMatchObject({ ok: false, status: 403, code: "INELIGIBLE" });
    expect(await filePrizeClaim(input({ claimant: claimant({ prizeIneligible: true }) }))).toMatchObject({ ok: false, status: 403, code: "INELIGIBLE" });
    expect(await filePrizeClaim(input({ claimant: claimant({ reputationScore: 19 }) }))).toMatchObject({ ok: false, status: 403, code: "INELIGIBLE" });
    expect(await filePrizeClaim(input({ claimant: claimant({ isSuspended: true }) }))).toMatchObject({ ok: false, status: 403, code: "INELIGIBLE" });
  });

  it("409 DUPLICATE_LIVE_CLAIM when the claimant already has a live claim on the statement", async () => {
    state.dup = true;
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 409, code: "DUPLICATE_LIVE_CLAIM" });
  });

  it("429 PRIZE_CLAIM_RATE_LIMITED for each of the rules, the cooldown with a retry time", async () => {
    state.counts = { per_statement: 3, platform_today: 0, claimant_today: 0 };
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 429, code: "PRIZE_CLAIM_RATE_LIMITED" });
    state.counts = { per_statement: 0, platform_today: 5, claimant_today: 0 };
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 429, code: "PRIZE_CLAIM_RATE_LIMITED" });
    state.counts = { per_statement: 0, platform_today: 0, claimant_today: 1 };
    expect(await filePrizeClaim(input({ claimant: claimant({ reputationScore: 30 }) }))).toMatchObject({ ok: false, status: 429 });
    expect(await filePrizeClaim(input({ claimant: claimant({ createdAt: new Date() }) }))).toMatchObject({ ok: false, status: 429 });
    state.counts = { per_statement: 0, platform_today: 0, claimant_today: 0 };
    const failedAt = new Date(Date.now() - 2 * 3_600_000);
    state.history = [
      { submitted_at: new Date(failedAt.getTime() - 3_600_000), updated_at: failedAt, status: "rejected", rejected_stage: "check" },
      { submitted_at: new Date(failedAt.getTime() + 60_000), updated_at: new Date(failedAt.getTime() + 60_000), status: "withdrawn", rejected_stage: null },
    ];
    const r = await filePrizeClaim(input());
    expect(r).toMatchObject({ ok: false, status: 429, code: "PRIZE_CLAIM_RATE_LIMITED" });
    if (!r.ok) expect(r.retry_at).toBe(new Date(failedAt.getTime() + 24 * 3_600_000).toISOString());
  });

  it("422 INVALID_SUBMISSION naming the first violation: direction, account length, links, the Lean file, the static scan, the documents", async () => {
    expect(await filePrizeClaim(input({ direction: "sideways" }))).toMatchObject({ ok: false, status: 422, code: "INVALID_SUBMISSION", message: /direction/ });
    state.bounty = bounty({ resolution: "disproof" });
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /disproof only/ });
    state.bounty = bounty();
    expect(await filePrizeClaim(input({ content: "short" }))).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /between 200 and 20000/ });
    expect(await filePrizeClaim(input({ links: ["ftp://x"] }))).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /http/ });
    expect(await filePrizeClaim(input({ leanSource: null }))).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /Lean source is required/ });
    expect(await filePrizeClaim(input({ leanSource: { filename: "p.lean", body: Buffer.from("theorem t : True := by sorry") } }))).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /'sorry'/ });
    expect(await filePrizeClaim(input({ leanSource: { filename: "p.lean", body: Buffer.from("import Mathlib\ntheorem t : True := trivial") } }))).toMatchObject({ ok: false, message: /'import'/ });
    expect(await filePrizeClaim(input({ documents: [{ filename: "x.png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] }))).toMatchObject({ ok: false, code: "INVALID_SUBMISSION", message: /not an allowed type/ });
  });

  it("422 DECLARATIONS_REQUIRED for a missing declaration or a stale rules version", async () => {
    expect(await filePrizeClaim(input({ declarations: { eligibility: true, understanding: true } }))).toMatchObject({ ok: false, status: 422, code: "DECLARATIONS_REQUIRED", message: /cc0/ });
    expect(await filePrizeClaim(input({ rulesVersion: "2000-01-01" }))).toMatchObject({ ok: false, status: 422, code: "DECLARATIONS_REQUIRED", message: /rules version/ });
    expect(await filePrizeClaim(input({ residency: { country: "GB", us_person: null } }))).toMatchObject({ ok: false, code: "DECLARATIONS_REQUIRED" });
  });

  it("on success inserts the contribution (claim_prize, checking), the attachments, the prize claim (queued), and the funded action in ONE transaction", async () => {
    const r = await filePrizeClaim(input({ documents: [{ filename: "notes.md", body: Buffer.from("# approach") }] }));
    expect(r).toMatchObject({ ok: true, prize_claim_id: "pc-1", contribution_id: "co-1", status: "queued" });
    expect(state.transactions).toBe(1);
    const sqls = state.tx.map((q) => q.sql);
    const contribution = state.tx.find((q) => q.sql.includes("INSERT INTO contributions"))!;
    expect(contribution.sql).toMatch(/'claim_prize'/);
    expect(contribution.sql).toMatch(/'checking'/);
    expect(sqls.filter((s) => s.includes("INSERT INTO attachments"))).toHaveLength(2);
    const pc = state.tx.find((q) => q.sql.includes("INSERT INTO prize_claims"))!;
    expect(pc.sql).toMatch(/'queued'/);
    expect(pc.params[10]).toBe(new Date("2026-03-01T00:00:00.123456Z").getTime() ? pc.params[10] : null);
    const action = state.tx.find((q) => q.sql.includes("INSERT INTO actions"))!;
    expect(action.sql).toMatch(/'prize_review'/);
    expect(action.params[0]).toBe("prize_review:pc-1");
    const allocation = state.tx.find((q) => q.sql.includes("INSERT INTO action_allocations"))!;
    expect(allocation.params[3]).toBe("platform");
    expect(Number(allocation.params[4])).toBeGreaterThan(0);
    expect(Number(allocation.params[4])).toBeLessThanOrEqual(50_000_000);
    expect(sqls.some((s) => s.includes("INSERT INTO audit_log"))).toBe(true);
  });

  it("refuses with NO_OPEN_BOUNTY when the bounty closed while the filing was being received", async () => {
    state.bountyStatusInTx = "claim_pending";
    expect(await filePrizeClaim(input())).toMatchObject({ ok: false, status: 409, code: "NO_OPEN_BOUNTY" });
  });
});
