/**
 * Monitor scheduler (#334 S9): the candidate detectors' hits reach the
 * Audit Agent as anomaly_investigation INPUT, capped per sweep, deduped per
 * claim per reflag period through requestAudit's dedupe key, and off when
 * the sweep interval is 0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAudit: vi.fn(async (_input: unknown): Promise<string | null> => "run-1"),
  performedSettling: vi.fn(async (): Promise<unknown> => ({ candidates: [] })),
  emptyChairs: vi.fn(async (): Promise<unknown> => ({ candidates: [] })),
  config: {
    monitorSweepIntervalHours: 6,
    monitorReflagDays: 14,
    monitorSweepMaxFlags: 5,
  },
}));

vi.mock("../../../src/services/queue-service.js", () => ({ requestAudit: mocks.requestAudit }));
vi.mock("../../../src/services/monitor-service.js", () => ({
  defaultThresholds: (o: Record<string, unknown>) => ({ limit: 25, ...o }),
  performedSettling: mocks.performedSettling,
  emptyChairs: mocks.emptyChairs,
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import {
  flagMonitorCandidates,
  monitorSchedulerTick,
  reflagBucket,
  resetMonitorSchedulerState,
  performedSettlingContext,
  emptyChairsContext,
} from "../../../src/workers/monitor-scheduler.js";

const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 86_400_000;

const settling = (id: string, importance: number) => ({
  claimId: id,
  text: `settled claim ${id}`,
  importance,
  status: "verified",
  confidence: 0.9,
  credence: 0.85,
  assessedAt: "2026-09-01T00:00:00Z",
  reasons: ["opposed_instances", "contested_requires_child"],
  affirms: 3,
  denies: 2,
  sources: 4,
  lastAcceptedChallengeAt: null,
  contestedRequiresChildren: 1,
});
const chair = (id: string, importance: number) => ({
  claimId: id,
  text: `contested claim ${id}`,
  importance,
  status: "contested",
  confidence: 0.6,
  credence: 0.5,
  assessedAt: "2026-09-01T00:00:00Z",
  reasons: ["instances_one_stance"],
  instances: 3,
  instanceStance: "affirms",
  arguments: 0,
  argumentStance: null,
});

beforeEach(() => {
  mocks.requestAudit.mockReset().mockResolvedValue("run-1");
  mocks.performedSettling.mockReset().mockResolvedValue({ candidates: [] });
  mocks.emptyChairs.mockReset().mockResolvedValue({ candidates: [] });
  mocks.config.monitorSweepIntervalHours = 6;
  mocks.config.monitorReflagDays = 14;
  mocks.config.monitorSweepMaxFlags = 5;
  resetMonitorSchedulerState();
});

describe("reflagBucket", () => {
  it("rolls over once per reflag window", () => {
    const b = reflagBucket(NOW, 14);
    const boundary = (b + 1) * 14 * DAY;
    expect(reflagBucket(boundary - 1, 14)).toBe(b);
    expect(reflagBucket(boundary, 14)).toBe(b + 1);
    expect(reflagBucket(boundary + 13 * DAY, 14)).toBe(b + 1);
  });
});

describe("flagMonitorCandidates", () => {
  it("requests an anomaly_investigation per candidate, most important first, keyed by signal, claim and period", async () => {
    mocks.performedSettling.mockResolvedValue({ candidates: [settling("s1", 0.9), settling("s2", 0.3)] });
    mocks.emptyChairs.mockResolvedValue({ candidates: [chair("e1", 0.6)] });

    const r = await flagMonitorCandidates({ now: NOW });
    expect(r.candidates).toBe(3);
    expect(r.requested).toBe(3);
    expect(r.flags.map((f) => [f.signal, f.claimId])).toEqual([
      ["performed_settling", "s1"],
      ["empty_chairs", "e1"],
      ["performed_settling", "s2"],
    ]);
    const first = mocks.requestAudit.mock.calls[0]![0] as Record<string, unknown>;
    expect(first.auditType).toBe("anomaly_investigation");
    expect(first.triggeredBy).toBe("monitor_signal");
    expect(first.dedupeKey).toBe(`monitor:performed_settling:s1:${reflagBucket(NOW, 14)}`);
    expect(String(first.context)).toContain("candidate, not a verdict");
    expect(String(first.context)).toContain("s1");
  });

  it("caps flags per sweep and passes the cap as the detectors' limit", async () => {
    mocks.config.monitorSweepMaxFlags = 2;
    mocks.performedSettling.mockResolvedValue({ candidates: [settling("s1", 0.9), settling("s2", 0.8), settling("s3", 0.7)] });
    const r = await flagMonitorCandidates({ now: NOW });
    expect(r.requested).toBe(2);
    expect(mocks.requestAudit).toHaveBeenCalledTimes(2);
    expect(mocks.performedSettling.mock.calls[0]![0]).toMatchObject({ limit: 2 });
  });

  it("counts a deduped request (null run id) as not requested and keeps going", async () => {
    mocks.performedSettling.mockResolvedValue({ candidates: [settling("s1", 0.9), settling("s2", 0.8)] });
    mocks.requestAudit.mockResolvedValueOnce(null).mockResolvedValueOnce("run-2");
    const r = await flagMonitorCandidates({ now: NOW });
    expect(r.flags.map((f) => f.runId)).toEqual([null, "run-2"]);
    expect(r.requested).toBe(1);
  });

  it("does nothing with a zero cap", async () => {
    mocks.config.monitorSweepMaxFlags = 0;
    const r = await flagMonitorCandidates({ now: NOW });
    expect(r.requested).toBe(0);
    expect(mocks.performedSettling).not.toHaveBeenCalled();
  });
});

describe("monitorSchedulerTick", () => {
  it("is off at interval 0", async () => {
    mocks.config.monitorSweepIntervalHours = 0;
    expect(await monitorSchedulerTick(NOW)).toEqual({ swept: false, flags: null });
    expect(mocks.performedSettling).not.toHaveBeenCalled();
  });

  it("sweeps once per period", async () => {
    mocks.performedSettling.mockResolvedValue({ candidates: [settling("s1", 0.9)] });
    const first = await monitorSchedulerTick(NOW);
    expect(first.swept).toBe(true);
    expect(first.flags?.requested).toBe(1);
    const again = await monitorSchedulerTick(NOW + 60_000);
    expect(again.swept).toBe(false);
    const next = await monitorSchedulerTick(NOW + 6 * 3_600_000);
    expect(next.swept).toBe(true);
    expect(mocks.requestAudit).toHaveBeenCalledTimes(2);
  });
});

describe("contexts", () => {
  it("name the signal, the claim, every reason, and the candidate posture", () => {
    const s = performedSettlingContext({ ...settling("abc", 0.5), reasons: ["opposed_instances", "recent_accepted_challenge", "contested_requires_child"], lastAcceptedChallengeAt: "2026-09-10T00:00:00Z" } as never);
    expect(s).toContain("performed_settling");
    expect(s).toContain("abc");
    expect(s).toContain("deny it 2 time(s)");
    expect(s).toContain("2026-09-10");
    expect(s).toContain("1 claim(s) it requires are currently contested");
    expect(s).toContain("do not change the claim yourself");
    const e = emptyChairsContext(chair("xyz", 0.5) as never);
    expect(e).toContain("empty_chairs");
    expect(e).toContain("all 3 of its instances affirm it");
  });
});
