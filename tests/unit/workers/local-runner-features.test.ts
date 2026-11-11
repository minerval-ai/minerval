import { describe, it, expect, beforeEach, vi } from "vitest";

// The runner's prize lanes (the prize check and the window closer) run only
// where a Lean checker is configured and the prizes feature is on
// (src/features.ts); prizes need mathematics, so mathematics off stops them
// too. All lanes are mocked: this is which lanes a drain enters.

const { state } = vi.hoisted(() => ({
  state: {
    config: {} as Record<string, unknown>,
    prizeChecks: 0,
    windowCloses: 0,
  },
}));

vi.mock("../../../src/workers/claim-pipeline.js", () => ({ handleClaimPipeline: vi.fn() }));
vi.mock("../../../src/workers/url-extraction.js", () => ({ handleUrlExtraction: vi.fn() }));
vi.mock("../../../src/workers/contribution-pipeline.js", () => ({
  handleContributionMessage: vi.fn(),
}));
vi.mock("../../../src/workers/arbitration-pipeline.js", () => ({
  handleArbitrationMessage: vi.fn(),
}));
vi.mock("../../../src/workers/order-pipeline.js", () => ({
  processNextOrderTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/budget-job-pipeline.js", () => ({
  processNextBudgetJobTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/engine-executor.js", () => ({
  processNextEngineAction: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  processNextStewardTask: vi.fn(async () => ({ status: "empty" as const })),
  pendingStewardCount: vi.fn(async () => 0),
}));
vi.mock("../../../src/workers/prize-check-pipeline.js", () => ({
  processNextPrizeCheck: vi.fn(async () => {
    state.prizeChecks++;
    return { status: "empty" };
  }),
}));
vi.mock("../../../src/workers/prize-window-closer.js", () => ({
  runPrizeWindowCloser: vi.fn(async () => {
    state.windowCloses++;
    return { promoted: 0, voided: 0, forfeited: 0, expired: 0, withdrawn: 0, rebound: 0, tranches: 0 };
  }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => state.config }));

import {
  drainLocalQueues,
  resetPrizeWindowCloserThrottle,
} from "../../../src/workers/local-runner.js";

const BASE = {
  stewardMaxRuns: 0,
  sqsContributionQueue: "",
  sqsArbitrationQueue: "",
  sqsClaimPipelineQueue: "",
  sqsUrlExtractionQueue: "",
  leanCheckerUrl: "http://lean-checker.internal:8080",
};

beforeEach(() => {
  state.config = { ...BASE };
  state.prizeChecks = 0;
  state.windowCloses = 0;
  resetPrizeWindowCloserThrottle();
});

describe("the runner's prize lanes", () => {
  it("run with a checker configured and everything on", async () => {
    await drainLocalQueues();
    expect(state.prizeChecks).toBeGreaterThan(0);
    expect(state.windowCloses).toBe(1);
  });

  it("do not run with the prizes feature off", async () => {
    state.config = { ...BASE, featuresOff: ["prizes"] };
    await drainLocalQueues();
    expect(state.prizeChecks).toBe(0);
    expect(state.windowCloses).toBe(0);
  });

  it("do not run with mathematics off, which prizes need", async () => {
    state.config = { ...BASE, featuresOff: ["mathematics"] };
    await drainLocalQueues();
    expect(state.prizeChecks).toBe(0);
    expect(state.windowCloses).toBe(0);
  });

  it("are untouched by the extension being off", async () => {
    state.config = { ...BASE, featuresOff: ["extension"] };
    await drainLocalQueues();
    expect(state.prizeChecks).toBeGreaterThan(0);
    expect(state.windowCloses).toBe(1);
  });

  it("do not run without a checker, as before", async () => {
    state.config = { ...BASE, leanCheckerUrl: "" };
    await drainLocalQueues();
    expect(state.prizeChecks).toBe(0);
    expect(state.windowCloses).toBe(0);
  });
});
