import { describe, it, expect, beforeEach, vi } from "vitest";

// drainLocalQueues dequeues a message BEFORE running its handler. #218: a
// budget error must put the message back (it was never processed) instead of
// silently dropping it, while genuine handler errors are counted and skipped
// like the SQS poller. All handlers are mocked — this is runner control flow.

const { state } = vi.hoisted(() => ({
  state: {
    contributionError: null as Error | null,
    handled: [] as string[],
  },
}));

vi.mock("../../../src/workers/claim-pipeline.js", () => ({
  handleClaimPipeline: vi.fn(),
}));
vi.mock("../../../src/workers/url-extraction.js", () => ({
  handleUrlExtraction: vi.fn(),
}));
vi.mock("../../../src/workers/curator-pipeline.js", () => ({
  handleCuratorMessage: vi.fn(),
}));
vi.mock("../../../src/workers/contribution-pipeline.js", () => ({
  handleContributionMessage: vi.fn(async (m: { contributionId: string }) => {
    if (state.contributionError) throw state.contributionError;
    state.handled.push(m.contributionId);
  }),
}));
vi.mock("../../../src/workers/arbitration-pipeline.js", () => ({
  handleArbitrationMessage: vi.fn(),
}));
vi.mock("../../../src/workers/audit-pipeline.js", () => ({
  handleAuditMessage: vi.fn(),
}));
vi.mock("../../../src/workers/order-pipeline.js", () => ({
  processNextOrderTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/budget-job-pipeline.js", () => ({
  processNextBudgetJobTask: vi.fn(async () => ({ status: "empty" })),
}));
vi.mock("../../../src/workers/steward-pipeline.js", () => ({
  processNextStewardTask: vi.fn(async () => ({ status: "empty" as const })),
  pendingStewardCount: vi.fn(async () => 0),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    stewardMaxRuns: 0,
    sqsContributionQueue: "",
    sqsArbitrationQueue: "",
    sqsCuratorQueue: "",
    sqsAuditQueue: "",
    sqsClaimPipelineQueue: "",
    sqsUrlExtractionQueue: "",
  }),
}));

import { drainLocalQueues } from "../../../src/workers/local-runner.js";
import { getLocalQueue } from "../../../src/services/queue-service.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";

beforeEach(() => {
  state.contributionError = null;
  state.handled = [];
  getLocalQueue("contribution").length = 0;
  vi.clearAllMocks();
});

describe("drainLocalQueues budget requeue", () => {
  it("puts the message back at the front when the handler hits the budget", async () => {
    getLocalQueue("contribution").push(
      { contributionId: "c-1" },
      { contributionId: "c-2" }
    );
    state.contributionError = new LlmBudgetExceededError("hourly_token_count", 1, 1);

    await expect(drainLocalQueues()).rejects.toBeInstanceOf(LlmBudgetExceededError);

    expect(getLocalQueue("contribution")).toEqual([
      { contributionId: "c-1" },
      { contributionId: "c-2" },
    ]);

    // Next drain (budget back) processes both, in order.
    state.contributionError = null;
    await drainLocalQueues();
    expect(state.handled).toEqual(["c-1", "c-2"]);
    expect(getLocalQueue("contribution")).toHaveLength(0);
  });

  it("still drops and counts genuinely failed messages", async () => {
    getLocalQueue("contribution").push({ contributionId: "c-bad" });
    state.contributionError = new Error("poisoned");

    const stats = await drainLocalQueues();

    expect(stats.errors.contribution).toBe(1);
    expect(getLocalQueue("contribution")).toHaveLength(0);
  });
});
