import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  expireTextAnalyses: vi.fn(async () => 0),
  config: { traceRetentionDays: 30, runLogMode: "best_effort" },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: mocks.rawQuery }));
vi.mock("../../../src/services/text-analysis-service.js", () => ({
  expireTextAnalyses: mocks.expireTextAnalyses,
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import { traceRetentionTick } from "../../../src/workers/trace-retention.js";

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.expireTextAnalyses.mockReset().mockResolvedValue(0);
  mocks.config.traceRetentionDays = 30;
  mocks.config.runLogMode = "best_effort";
});

describe("traceRetentionTick", () => {
  it("is disabled at 0 days and touches nothing", async () => {
    mocks.config.traceRetentionDays = 0;
    const r = await traceRetentionTick();
    expect(r).toEqual({ deleted: 0, analysesExpired: 0, swept: false });
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  // A text analysis quotes the reader's own text, which the terms say is not
  // kept: it expires whatever the run log's retention, record mode included.
  it("expires finished text analyses even when run retention is off", async () => {
    mocks.expireTextAnalyses.mockResolvedValue(3);
    mocks.config.runLogMode = "record";
    expect(await traceRetentionTick()).toEqual({ deleted: 0, analysesExpired: 3, swept: false });
    mocks.config.runLogMode = "best_effort";
    mocks.config.traceRetentionDays = 0;
    expect(await traceRetentionTick()).toEqual({ deleted: 0, analysesExpired: 3, swept: false });
  });

  it("deletes runs older than the retention window, in batches, until a short batch", async () => {
    mocks.rawQuery
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })))
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    const now = new Date("2026-09-02T00:00:00Z");
    const r = await traceRetentionTick(now);
    expect(r).toEqual({ deleted: 502, analysesExpired: 0, swept: true });
    expect(mocks.rawQuery).toHaveBeenCalledTimes(2);
    const [sqlText, params] = mocks.rawQuery.mock.calls[0]!;
    expect(sqlText).toMatch(/DELETE FROM agent_runs/);
    // Runs that wrote to the graph are kept for good.
    expect(sqlText).toMatch(/wrote_to_graph = false/);
    expect((params as [Date, number])[0].toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect((params as [Date, number])[1]).toBe(500);
  });

  it("bounds the work per tick", async () => {
    mocks.rawQuery.mockResolvedValue(Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })));
    const r = await traceRetentionTick();
    expect(mocks.rawQuery).toHaveBeenCalledTimes(20);
    expect(r.deleted).toBe(10_000);
  });
});
