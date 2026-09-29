import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * escalate_to_curator (#363): a Steward's structural concern becomes a
 * curation request on the ledger, carrying the claim it came from (the
 * per-claim bound) and the other claim when the Steward names one. It no
 * longer enqueues a Curator run billed to the escalating run's funder:
 * whether the Curator runs is the mandates' valuation.
 */

const ANCHOR = "c3333333-3333-4333-8333-333333333333";
const OTHER = "c4444444-4444-4444-8444-444444444444";
const STEWARDED = "c5555555-5555-4555-8555-555555555555";

const mocks = vi.hoisted(() => ({
  requestCuration: vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true as boolean,
    requestId: "r1" as string | null,
    actionId: "a1" as string | null,
    repeat: false,
    problem: undefined as string | undefined,
  })),
}));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => ({}),
  rawQuery: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1]),
}));
vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
}));
vi.mock("../../../../src/services/curation-service.js", () => ({
  requestCuration: mocks.requestCuration,
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";
import { runWithUsageContext } from "../../../../src/llm/usage-context.js";

beforeEach(() => {
  mocks.requestCuration.mockClear();
});

describe("escalate_to_curator", () => {
  it("records a curation request from the stewarded claim, naming the other claim", async () => {
    const out = JSON.parse(
      await runWithUsageContext({ claimId: STEWARDED, jobId: "job-funder" }, () =>
        executeStewardTool("escalate_to_curator", {
          claim_id: ANCHOR,
          other_claim_id: OTHER,
          concern: "likely duplicate",
        })
      )
    );
    expect(out.success).toBe(true);
    expect(mocks.requestCuration).toHaveBeenCalledWith({
      anchorClaimId: ANCHOR,
      otherClaimId: OTHER,
      source: "steward_escalation",
      concern: "likely duplicate",
      requestedByClaimId: STEWARDED,
      requestedByRunId: null,
    });
    // The escalating run's funder is not carried anywhere: it does not pay.
    expect(JSON.stringify(mocks.requestCuration.mock.calls[0])).not.toContain("job-funder");
  });

  it("says so when the concern is already waiting", async () => {
    mocks.requestCuration.mockResolvedValueOnce({
      ok: true,
      requestId: null,
      actionId: "a1",
      repeat: true,
      problem: undefined,
    });
    const out = JSON.parse(
      await executeStewardTool("escalate_to_curator", { claim_id: ANCHOR, concern: "dup" })
    );
    expect(out).toMatchObject({ success: true });
    expect(out.message).toContain("already waiting");
  });

  it("passes a refusal back to the Steward", async () => {
    mocks.requestCuration.mockResolvedValueOnce({
      ok: false,
      requestId: null,
      actionId: null,
      repeat: false,
      problem: "this claim already has 3 structural concerns waiting",
    });
    const out = JSON.parse(
      await executeStewardTool("escalate_to_curator", { claim_id: ANCHOR, concern: "dup" })
    );
    expect(out).toEqual({
      success: false,
      message: "this claim already has 3 structural concerns waiting",
    });
  });
});
