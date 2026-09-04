import { describe, it, expect, beforeEach, vi } from "vitest";

// The review/arbitration recovery mechanics (#218) are CONTROL FLOW over the
// DB claim columns: the atomic claim before the agent runs, the release/refund
// on budget errors, the keep-claim backoff on genuine errors, and the sweep's
// re-enqueue of stalled rows. The SQL itself runs live in prod; here the DB
// layer is mocked and we verify which statements fire and what gets enqueued.

const { state } = vi.hoisted(() => ({
  state: {
    // What the claim UPDATE returns: [] simulates "row already claimed/terminal".
    claimGranted: true,
    queries: [] as Array<{ q: string; params: unknown[] }>,
    // Rows served to the sweep's three SELECTs, keyed by a substring.
    pendingRows: [] as Array<{ id: string }>,
    escalatedRows: [] as Array<{ id: string }>,
    appealRows: [] as Array<{ id: string; contribution_id: string }>,
    reviewError: null as Error | null,
    arbitrationError: null as Error | null,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    if (q.trimStart().startsWith("UPDATE") && q.includes("RETURNING")) {
      return state.claimGranted ? [{ id: params[0] }] : [];
    }
    if (q.includes("review_status = 'pending'")) return state.pendingRows;
    if (q.includes("review_status = 'escalated'")) return state.escalatedRows;
    if (q.includes("FROM appeals")) return state.appealRows;
    if (q.includes("AS n")) return [{ n: 0 }];
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/contribution-reviewer.js", () => ({
  runContributionReview: vi.fn(async () => {
    if (state.reviewError) throw state.reviewError;
  }),
}));

vi.mock("../../../src/llm/agents/dispute-arbitrator.js", () => ({
  runArbitration: vi.fn(async () => {
    if (state.arbitrationError) throw state.arbitrationError;
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    sqsContributionQueue: "",
    sqsArbitrationQueue: "",
    sqsCuratorQueue: "",
    sqsAuditQueue: "",
    sqsClaimPipelineQueue: "",
    sqsUrlExtractionQueue: "",
  }),
}));

import { handleContributionMessage } from "../../../src/workers/contribution-pipeline.js";
import { handleArbitrationMessage } from "../../../src/workers/arbitration-pipeline.js";
import { sweepStalledReviewWork } from "../../../src/workers/recovery-sweep.js";
import { getLocalQueue } from "../../../src/services/queue-service.js";
import { runContributionReview } from "../../../src/llm/agents/contribution-reviewer.js";
import { runArbitration } from "../../../src/llm/agents/dispute-arbitrator.js";
import { LlmBudgetExceededError } from "../../../src/llm/errors.js";

const CONTRIB = "11111111-1111-1111-1111-111111111111";
const APPEAL = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  state.claimGranted = true;
  state.queries = [];
  state.pendingRows = [];
  state.escalatedRows = [];
  state.appealRows = [];
  state.reviewError = null;
  state.arbitrationError = null;
  vi.clearAllMocks();
  getLocalQueue("contribution").length = 0;
  getLocalQueue("arbitration").length = 0;
});

describe("handleContributionMessage claim guard", () => {
  it("claims the row before running the reviewer", async () => {
    await handleContributionMessage({ contributionId: CONTRIB });
    expect(state.queries[0].q).toContain("review_claimed_at = now()");
    expect(state.queries[0].params).toEqual([CONTRIB]);
    expect(runContributionReview).toHaveBeenCalledOnce();
  });

  it("no-ops when the claim is not granted (duplicate message)", async () => {
    state.claimGranted = false;
    await handleContributionMessage({ contributionId: CONTRIB });
    expect(runContributionReview).not.toHaveBeenCalled();
  });

  it("releases the claim and refunds the attempt on budget errors", async () => {
    state.reviewError = new LlmBudgetExceededError("hourly_token_count", 1, 1);
    await expect(
      handleContributionMessage({ contributionId: CONTRIB })
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    const release = state.queries.at(-1)!;
    expect(release.q).toContain("review_claimed_at = NULL");
    expect(release.q).toContain("review_attempts = review_attempts - 1");
  });

  it("never claims a claim_prize contribution: its review is the prize-check worker's", async () => {
    await handleContributionMessage({ contributionId: CONTRIB });
    expect(state.queries[0].q).toContain("contribution_type <> 'claim_prize'");
  });

  it("keeps the claim on genuine errors (reclaim-window backoff)", async () => {
    state.reviewError = new Error("agent exploded");
    await expect(
      handleContributionMessage({ contributionId: CONTRIB })
    ).rejects.toThrow("agent exploded");
    // No release: the claim is held so the retry waits out the reclaim window.
    // Asserted on the absence of the release UPDATE rather than on a query
    // count, which also counts the read that attributes the review to its
    // contributor.
    expect(
      state.queries.filter((q) => q.q.includes("review_claimed_at = NULL"))
    ).toEqual([]);
  });
});

describe("handleArbitrationMessage claim guard", () => {
  it("claims the appeal row for appeal-driven arbitration", async () => {
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "appeal",
      appealId: APPEAL,
    });
    expect(state.queries[0].q).toContain("UPDATE appeals");
    expect(state.queries[0].params).toEqual([APPEAL]);
    expect(runArbitration).toHaveBeenCalledOnce();
  });

  it("claims the escalated contribution when there is no appeal", async () => {
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "escalated_review",
    });
    expect(state.queries[0].q).toContain("review_status = 'escalated'");
    expect(state.queries[0].params).toEqual([CONTRIB]);
  });

  it("no-ops on an unclaimed (already resolved) case", async () => {
    state.claimGranted = false;
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "escalated_review",
    });
    expect(runArbitration).not.toHaveBeenCalled();
  });

  it("releases the appeal claim on budget errors", async () => {
    state.arbitrationError = new LlmBudgetExceededError("hourly_token_count", 1, 1);
    await expect(
      handleArbitrationMessage({
        contributionId: CONTRIB,
        trigger: "appeal",
        appealId: APPEAL,
      })
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
    const release = state.queries.at(-1)!;
    expect(release.q).toContain("UPDATE appeals");
    expect(release.q).toContain("claimed_at = NULL");
  });
});

describe("sweepStalledReviewWork", () => {
  it("re-enqueues stalled reviews, escalations, and appeals with the right messages", async () => {
    state.pendingRows = [{ id: "c-pending" }];
    state.escalatedRows = [{ id: "c-escalated" }];
    state.appealRows = [{ id: "a-1", contribution_id: "c-appealed" }];

    const stats = await sweepStalledReviewWork();

    expect(stats).toMatchObject({
      contributionsRequeued: 1,
      escalationsRequeued: 1,
      appealsRequeued: 1,
    });
    expect(getLocalQueue("contribution")).toEqual([
      { contributionId: "c-pending" },
    ]);
    expect(getLocalQueue("arbitration")).toEqual([
      { contributionId: "c-escalated", trigger: "escalated_review" },
      { contributionId: "c-appealed", trigger: "appeal", appealId: "a-1" },
    ]);
  });

  it("leaves claim_prize contributions to the prize-check worker (docs/mathematics.md §8.4)", async () => {
    await sweepStalledReviewWork();
    const pendingSelect = state.queries.find(
      (e) => e.q.trimStart().startsWith("SELECT") && e.q.includes("review_status = 'pending'")
    );
    expect(pendingSelect).toBeDefined();
    expect(pendingSelect!.q).toContain("contribution_type <> 'claim_prize'");
  });

  it("only selects unclaimed, under-cap rows", async () => {
    await sweepStalledReviewWork();
    const selects = state.queries.filter((e) => e.q.trimStart().startsWith("SELECT"));
    for (const s of selects.slice(0, 3)) {
      expect(s.q).toMatch(/claimed_at IS NULL/);
      expect(s.q).toMatch(/attempts < 3/);
    }
  });
});
