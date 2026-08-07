import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(async () => [{ id: "snap-1" }]),
  insertedValues: vi.fn(),
  rawQuery: vi.fn(async () => [
    { kind: "assess_claim", status: "open", n: 7 },
    { kind: "assess_claim", status: "running", n: 2 },
  ]),
  health: vi.fn(async () => ({
    pending: 5,
    running: 1,
    done: 100,
    error: 3,
    deferred: 12,
  })),
  config: { queueDepthSampleIntervalHours: 6 },
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: unknown) => {
        mocks.insertedValues(v);
        return {
          onConflictDoNothing: () => ({ returning: mocks.insertReturning }),
        };
      },
    }),
  }),
  rawQuery: mocks.rawQuery,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  stewardQueueHealth: mocks.health,
}));

import { queueDepthSamplerTick } from "../../../src/workers/queue-depth-sampler.js";

beforeEach(() => {
  mocks.insertReturning.mockClear();
  mocks.insertedValues.mockClear();
  mocks.config.queueDepthSampleIntervalHours = 6;
});

describe("queueDepthSamplerTick", () => {
  it("is disabled at interval 0", async () => {
    mocks.config.queueDepthSampleIntervalHours = 0;
    const result = await queueDepthSamplerTick();
    expect(result.sampled).toBe(false);
    expect(mocks.insertedValues).not.toHaveBeenCalled();
  });

  it("records the period-keyed snapshot with steward + ledger detail", async () => {
    const now = 6 * 3_600_000 * 1000; // period 1000 exactly
    const result = await queueDepthSamplerTick(now);
    expect(result.sampled).toBe(true);
    const row = mocks.insertedValues.mock.calls[0]![0] as {
      periodKey: string;
      stewardPending: number;
      detail: { steward: { pending: number }; actions: Record<string, unknown> };
    };
    expect(row.periodKey).toBe("1000");
    expect(row.stewardPending).toBe(5);
    expect(row.detail.steward.pending).toBe(5);
    expect(row.detail.actions).toEqual({
      assess_claim: { open: 7, running: 2 },
    });
  });

  it("reports sampled=false when another instance already claimed the period", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    const result = await queueDepthSamplerTick();
    expect(result.sampled).toBe(false);
  });
});
