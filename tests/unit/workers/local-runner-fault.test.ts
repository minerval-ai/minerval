import { describe, it, expect, beforeEach, vi } from "vitest";

// #971: on 2026-11-12 one model provider's account ran out of credits. A
// lookout run on it, the most-backed runnable engine row, was refused and
// handed back every few minutes for thirteen hours; each refusal ended the
// whole drain and paused the runner, so the Steward lane behind it, whose
// provider was healthy, never ran. A row a deployment fault stops now waits
// on its own, and the drain goes on to the lanes behind it. All lanes are
// mocked: this is the runner's control flow.

const { lanes } = vi.hoisted(() => ({
  lanes: {
    engine: [] as Array<Record<string, unknown>>,
    steward: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../src/workers/claim-pipeline.js", () => ({ handleClaimPipeline: vi.fn() }));
vi.mock("../../../src/workers/url-extraction.js", () => ({ handleUrlExtraction: vi.fn() }));
vi.mock("../../../src/workers/contribution-pipeline.js", () => ({ handleContributionMessage: vi.fn() }));
vi.mock("../../../src/workers/arbitration-pipeline.js", () => ({ handleArbitrationMessage: vi.fn() }));
vi.mock("../../../src/workers/order-pipeline.js", () => ({
  processNextOrderTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/budget-job-pipeline.js", () => ({
  processNextBudgetJobTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/engine-executor.js", () => ({
  processNextEngineAction: vi.fn(async () => lanes.engine.shift() ?? { status: "empty" }),
}));
vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  processNextStewardTask: vi.fn(async () => lanes.steward.shift() ?? { status: "empty" }),
  pendingStewardCount: vi.fn(async () => 0),
}));
vi.mock("../../../src/workers/prize-check-pipeline.js", () => ({ processNextPrizeCheck: vi.fn() }));
vi.mock("../../../src/workers/prize-window-closer.js", () => ({ runPrizeWindowCloser: vi.fn() }));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    stewardMaxRuns: 0,
    sqsContributionQueue: "",
    sqsArbitrationQueue: "",
    sqsClaimPipelineQueue: "",
    sqsUrlExtractionQueue: "",
  }),
}));
vi.mock("../../../src/features.js", () => ({ featureOn: () => false }));

import { drainLocalQueues, type RunnerEvent } from "../../../src/workers/local-runner.js";
import { processNextStewardTask } from "../../../src/workers/steward-pipeline.js";

const REFUSED = "402 This request's maximum cost exceeds your available credits.";

beforeEach(() => {
  lanes.engine = [];
  lanes.steward = [];
  vi.clearAllMocks();
});

describe("a deployment fault in one lane", () => {
  it("does not stop the drain: the Steward lane behind a refused lookout still runs", async () => {
    // The lookout's row is refused for credits and now waits; the engine lane
    // then has nothing runnable, and two covered Steward passes are behind it.
    lanes.engine = [
      { status: "transient", actionId: "lookout-row", kind: "lookout_run", error: REFUSED, waitingOn: "credits_fault" },
    ];
    lanes.steward = [
      { status: "processed", claimId: "c1", trigger: "structure_and_assess", ok: true },
      { status: "processed", claimId: "c2", trigger: "structure_and_assess", ok: true },
    ];
    const events: RunnerEvent[] = [];
    const stats = await drainLocalQueues({ onEvent: (e) => events.push(e) });

    expect(stats.stoppedOnTransient).toBeUndefined();
    expect(stats.processed.steward).toBe(2);
    // The refused attempt is counted and visible, never silent.
    expect(stats.errors.engine).toBe(1);
    expect(events[0]).toMatchObject({
      queue: "engine",
      ok: false,
      message: { actionId: "lookout-row", waitingOn: "credits_fault" },
    });
  });

  it("does the same for rejected credentials, and for a Steward pass's own row", async () => {
    lanes.engine = [
      { status: "transient", actionId: "sweep-row", kind: "consistency_sweep", waitingOn: "credentials_fault" },
    ];
    lanes.steward = [
      { status: "transient", claimId: "c-strong", waitingOn: "credits_fault", error: REFUSED },
      { status: "processed", claimId: "c-standard", ok: true },
    ];
    const stats = await drainLocalQueues();
    expect(stats.stoppedOnTransient).toBeUndefined();
    expect(stats.processed.steward).toBe(1);
    expect(stats.errors.steward).toBe(1);
    expect(stats.errors.engine).toBe(1);
  });

  it("still stops, for the governor to slow down, on a failure that is load or that left no row waiting", async () => {
    // A rate limit or an overload is pressure: the runner backs off.
    lanes.engine = [{ status: "transient", actionId: "a", kind: "lookout_run", waitingOn: "provider_unavailable" }];
    lanes.steward = [{ status: "processed", claimId: "c1", ok: true }];
    let stats = await drainLocalQueues();
    expect(stats.stoppedOnTransient).toBe(true);
    expect(processNextStewardTask).not.toHaveBeenCalled();

    // A deployment fault whose row is not in a wait (nothing paces it) must
    // not be retried in a loop: the drain stops as it always has.
    lanes.engine = [{ status: "transient", actionId: "a", kind: "lookout_run", error: REFUSED }];
    stats = await drainLocalQueues();
    expect(stats.stoppedOnTransient).toBe(true);
    expect(processNextStewardTask).not.toHaveBeenCalled();
  });

  it("cannot spin: every refused row counts toward the drain's cap", async () => {
    lanes.engine = Array.from({ length: 50 }, (_, i) => ({
      status: "transient",
      actionId: `row-${i}`,
      kind: "lookout_run",
      waitingOn: "credits_fault",
    }));
    const stats = await drainLocalQueues({ maxMessages: 10 });
    expect(stats.errors.engine).toBe(10);
  });
});
