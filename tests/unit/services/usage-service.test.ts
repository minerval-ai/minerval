import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(async () => undefined),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({ insert: () => ({ values: mocks.values }) }),
}));

import { meterLlmUsage } from "../../../src/services/usage-service.js";

// Cost is measured in dollars: the meter records the REAL cost of each
// call. The platform's margin lives entirely in the owl's purchase price,
// never in these rows.
describe("meterLlmUsage (raw cost, no markup)", () => {
  beforeEach(() => {
    mocks.values.mockClear();
  });

  // claude-fable-5-1 list price: $10/Mtok in, $50/Mtok out → 1000 tokens each
  // way = 10_000 + 50_000 = 60_000 micro-USD raw.
  const call = {
    model: "claude-fable-5-1",
    inputTokens: 1000,
    outputTokens: 1000,
  };

  it("records the raw derived cost", async () => {
    await meterLlmUsage(call);
    expect(mocks.values).toHaveBeenCalledOnce();
    expect(mocks.values.mock.calls[0][0].costMicroUsd).toBe(60_000);
  });

  it("records provider-reported costs verbatim", async () => {
    await meterLlmUsage({
      model: "some/openrouter-model",
      provider: "openrouter",
      inputTokens: 500,
      outputTokens: 500,
      providerCostMicroUsd: 12_345,
    });
    expect(mocks.values.mock.calls[0][0].costMicroUsd).toBe(12_345);
  });
});
