import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(async () => undefined),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({ insert: () => ({ values: mocks.values }) }),
}));

// Config is cached at module level, so each scenario re-imports the service
// after setting the env.
async function loadUsageService(multiplier: string | undefined) {
  if (multiplier === undefined) delete process.env.USAGE_MARKUP_MULTIPLIER;
  else process.env.USAGE_MARKUP_MULTIPLIER = multiplier;
  vi.resetModules();
  return import("../../../src/services/usage-service.js");
}

describe("meterLlmUsage markup", () => {
  let savedMultiplier: string | undefined;
  beforeEach(() => {
    savedMultiplier = process.env.USAGE_MARKUP_MULTIPLIER;
    mocks.values.mockClear();
  });
  afterEach(() => {
    if (savedMultiplier === undefined) delete process.env.USAGE_MARKUP_MULTIPLIER;
    else process.env.USAGE_MARKUP_MULTIPLIER = savedMultiplier;
  });

  // claude-fable-5 list price: $10/Mtok in, $50/Mtok out → 1000 tokens each
  // way = 10_000 + 50_000 = 60_000 micro-USD raw.
  const call = {
    model: "claude-fable-5",
    inputTokens: 1000,
    outputTokens: 1000,
  };

  it("bills raw derived cost times the default multiplier (4)", async () => {
    const { meterLlmUsage } = await loadUsageService(undefined);
    await meterLlmUsage(call);
    expect(mocks.values).toHaveBeenCalledOnce();
    expect(mocks.values.mock.calls[0][0].costMicroUsd).toBe(240_000);
  });

  it("honours USAGE_MARKUP_MULTIPLIER", async () => {
    const { meterLlmUsage } = await loadUsageService("1.5");
    await meterLlmUsage(call);
    expect(mocks.values.mock.calls[0][0].costMicroUsd).toBe(90_000);
  });

  it("marks up provider-reported costs too", async () => {
    const { meterLlmUsage } = await loadUsageService("2");
    await meterLlmUsage({
      model: "some/openrouter-model",
      provider: "openrouter",
      inputTokens: 500,
      outputTokens: 500,
      providerCostMicroUsd: 12_345,
    });
    expect(mocks.values.mock.calls[0][0].costMicroUsd).toBe(24_690);
  });
});
