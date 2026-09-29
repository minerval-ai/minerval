/**
 * requestAudit (#180, #363): the audit_runs row is created first and doubles
 * as the dedupe gate — a lost INSERT conflict means no duplicate run — and
 * then opens the run's `audit` ledger action, which is funded like any other
 * work: from the bounty's reserve for a prize audit, else by the Governance
 * mandate's valuation, offered at once rather than at the next sweep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  ensureAuditAction: vi.fn(async (_input: unknown) => "action-1"),
  fundAuditNow: vi.fn(async (_actionId: string) => {}),
  fundPrizeAuditFromReserve: vi.fn(async (_bountyId: string, _actionId: string) => 0),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
}));
vi.mock("../../../src/services/action-service.js", () => ({
  ensureAssessActions: vi.fn(async () => {}),
  ensureAuditAction: mocks.ensureAuditAction,
}));
vi.mock("../../../src/services/maintenance-funding.js", () => ({
  fundAuditNow: mocks.fundAuditNow,
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  fundPrizeAuditFromReserve: mocks.fundPrizeAuditFromReserve,
}));

import { requestAudit } from "../../../src/services/queue-service.js";

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.ensureAuditAction.mockClear();
  mocks.fundAuditNow.mockClear();
  mocks.fundPrizeAuditFromReserve.mockClear();
});

describe("requestAudit", () => {
  it("creates the run row, then opens its audit action and offers it to the funders", async () => {
    mocks.rawQuery.mockResolvedValue([{ id: "run-1" }]);

    const runId = await requestAudit({
      auditType: "decision_audit",
      context: "A bad-faith flag was applied to contribution X.",
      triggeredBy: "bad_faith_flag",
      dedupeKey: "bad-faith:X",
    });

    expect(runId).toBe("run-1");
    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO audit_runs");
    expect(sql).toContain("ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING");
    expect(params).toEqual([
      "decision_audit",
      "A bad-faith flag was applied to contribution X.",
      "bad_faith_flag",
      "bad-faith:X",
      null,
      null,
    ]);

    expect(mocks.ensureAuditAction).toHaveBeenCalledWith({
      auditRunId: "run-1",
      auditType: "decision_audit",
      triggeredBy: "bad_faith_flag",
      claimId: null,
    });
    expect(mocks.fundAuditNow).toHaveBeenCalledWith("action-1");
    expect(mocks.fundPrizeAuditFromReserve).not.toHaveBeenCalled();
  });

  it("records the audit's subject mandate, which may not fund it", async () => {
    mocks.rawQuery.mockResolvedValue([{ id: "run-2" }]);
    await requestAudit({
      auditType: "decision_audit",
      context: "Audit the posting.",
      triggeredBy: "bounty_posted",
      dedupeKey: "bounty_posted:B",
      subjectGrantId: "grant-9",
      bountyId: "bounty-1",
    });
    const [, params] = mocks.rawQuery.mock.calls[0]!;
    expect(params?.slice(4)).toEqual(["grant-9", "bounty-1"]);
  });

  it("funds a prize audit from the bounty's reserve, not a mandate's valuation", async () => {
    mocks.rawQuery.mockResolvedValue([{ id: "run-3" }]);
    await requestAudit({
      auditType: "decision_audit",
      context: "The Steward accepted prize claim P.",
      triggeredBy: "prize_acceptance",
      dedupeKey: "prize_claim:P:D",
      bountyId: "bounty-1",
      claimId: "claim-1",
    });
    expect(mocks.fundPrizeAuditFromReserve).toHaveBeenCalledWith("bounty-1", "action-1");
    expect(mocks.fundAuditNow).not.toHaveBeenCalled();
  });

  it("a lost dedupe race opens nothing", async () => {
    mocks.rawQuery.mockResolvedValue([]);

    const runId = await requestAudit({
      auditType: "pattern_analysis",
      context: "Scheduled sweep.",
      triggeredBy: "scheduled_sweep",
      dedupeKey: "sweep:20661",
    });

    expect(runId).toBeNull();
    expect(mocks.ensureAuditAction).not.toHaveBeenCalled();
    expect(mocks.fundAuditNow).not.toHaveBeenCalled();
  });
});
