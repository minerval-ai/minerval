import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ values: vi.fn(async () => undefined) }));
vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({ insert: () => ({ values: mocks.values }) }),
  rawQuery: vi.fn(),
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => ({ env: "development" }) }));

import { meterExternalUsage } from "../../../src/services/usage-service.js";
import { runWithUsageContext, withCostMeter } from "../../../src/llm/usage-context.js";

describe("meterExternalUsage", () => {
  beforeEach(() => mocks.values.mockClear());

  it("feeds the live meter and lands in llm_usage with zero tokens and the external columns", async () => {
    const { billedMicroUsd } = await withCostMeter(async () => {
      await runWithUsageContext({ jobId: "job1", claimId: "c1", agent: "steward" }, () =>
        meterExternalUsage({ provider: "lean", model: "lean-checker/mathlib-v4.33.0", units: 30_000, unitKind: "wall_ms", costMicroUsd: 21_666.6 })
      );
    });
    expect(billedMicroUsd).toBe(21_667);
    expect(mocks.values).toHaveBeenCalledTimes(1);
    const row = mocks.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      jobId: "job1",
      claimId: "c1",
      agent: "steward",
      model: "lean-checker/mathlib-v4.33.0",
      provider: "lean",
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 21_667,
      externalUnits: "30000",
      externalUnitKind: "wall_ms",
    });
  });

  it("never throws when the insert fails", async () => {
    mocks.values.mockRejectedValueOnce(new Error("db down"));
    await expect(meterExternalUsage({ provider: "elicit", model: "elicit/search_papers", units: 1, unitKind: "call", costMicroUsd: 50_000 })).resolves.toBeUndefined();
  });
});
