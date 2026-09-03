/**
 * Audit scheduler tick (#180): sweeps only periods that saw decisions, ages
 * suspensions, and leans on requestAudit's dedupe keys for idempotency.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  requestAudit: vi.fn(async (): Promise<string | null> => "run-1"),
  countNewReportsSince: vi.fn(async (): Promise<number> => 0),
  config: {
    auditSweepIntervalHours: 24,
    auditStaleSuspensionDays: 14,
    reportTriageIntervalHours: 24,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  requestAudit: mocks.requestAudit,
}));
vi.mock("../../../src/services/report-service.js", () => ({
  countNewReportsSince: mocks.countNewReportsSince,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import { auditSchedulerTick } from "../../../src/workers/audit-scheduler.js";

// 2026-07-18T12:00:00Z
const NOW = Date.UTC(2026, 6, 18, 12);
const DAY_MS = 86_400_000;

function route(opts: {
  decidedCount?: number;
  staleSuspensions?: Array<{ id: string; suspended_at: Date }>;
}) {
  mocks.rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM contribution_reviews")) {
      return [{ count: opts.decidedCount ?? 0 }];
    }
    if (sql.includes("FROM contributors")) {
      return opts.staleSuspensions ?? [];
    }
    return [];
  });
}

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.requestAudit.mockReset().mockResolvedValue("run-1");
  mocks.countNewReportsSince.mockReset().mockResolvedValue(0);
  mocks.config.auditSweepIntervalHours = 24;
  mocks.config.auditStaleSuspensionDays = 14;
  mocks.config.reportTriageIntervalHours = 24;
});

describe("auditSchedulerTick", () => {
  it("requests one sweep per period when the period saw decisions", async () => {
    route({ decidedCount: 7 });

    const result = await auditSchedulerTick(NOW);

    expect(result.sweepRequested).toBe(true);
    expect(mocks.requestAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: "pattern_analysis",
        triggeredBy: "scheduled_sweep",
        dedupeKey: `sweep:${Math.floor(NOW / DAY_MS)}`,
      })
    );
  });

  it("skips the sweep entirely when no decisions were made", async () => {
    route({ decidedCount: 0 });

    const result = await auditSchedulerTick(NOW);

    expect(result.sweepRequested).toBe(false);
    expect(mocks.requestAudit).not.toHaveBeenCalled();
  });

  it("requests a contributor_review per stale suspension, keyed per month", async () => {
    route({
      decidedCount: 0,
      staleSuspensions: [
        { id: "c-1", suspended_at: new Date(NOW - 30 * DAY_MS) },
        { id: "c-2", suspended_at: new Date(NOW - 20 * DAY_MS) },
      ],
    });
    // c-2's request loses the dedupe race (already reviewed this month).
    mocks.requestAudit
      .mockResolvedValueOnce("run-1")
      .mockResolvedValueOnce(null);

    const result = await auditSchedulerTick(NOW);

    expect(result.suspensionReviewsRequested).toBe(1);
    expect(mocks.requestAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: "contributor_review",
        triggeredBy: "suspension_review",
        dedupeKey: "suspension-review:c-1:2026-07",
      })
    );
  });

  it("a zero interval disables the scheduler", async () => {
    mocks.config.auditSweepIntervalHours = 0;
    route({ decidedCount: 100 });

    const result = await auditSchedulerTick(NOW);

    expect(result).toEqual({
      sweepRequested: false,
      suspensionReviewsRequested: 0,
      reportTriageRequested: false,
    });
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("requests one report_triage per period when new reports arrived (#366)", async () => {
    route({ decidedCount: 0 });
    mocks.countNewReportsSince.mockResolvedValue(4);

    const result = await auditSchedulerTick(NOW);

    expect(result.reportTriageRequested).toBe(true);
    expect(mocks.countNewReportsSince).toHaveBeenCalledWith(new Date(NOW - DAY_MS));
    expect(mocks.requestAudit).toHaveBeenCalledTimes(1);
    expect(mocks.requestAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        auditType: "report_triage",
        triggeredBy: "report_triage",
        dedupeKey: `report-triage:${Math.floor(NOW / DAY_MS)}`,
        context: expect.stringContaining("4 report(s)"),
      })
    );
  });

  it("skips triage when nothing new was reported, and when disabled", async () => {
    route({ decidedCount: 0 });
    mocks.countNewReportsSince.mockResolvedValue(0);
    expect((await auditSchedulerTick(NOW)).reportTriageRequested).toBe(false);

    mocks.countNewReportsSince.mockResolvedValue(9);
    mocks.config.reportTriageIntervalHours = 0;
    expect((await auditSchedulerTick(NOW)).reportTriageRequested).toBe(false);
    expect(mocks.requestAudit).not.toHaveBeenCalled();
  });

  it("triage runs on its own cadence even when audit sweeps are disabled", async () => {
    mocks.config.auditSweepIntervalHours = 0;
    mocks.countNewReportsSince.mockResolvedValue(1);

    const result = await auditSchedulerTick(NOW);

    expect(result.reportTriageRequested).toBe(true);
    expect(result.sweepRequested).toBe(false);
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });
});
