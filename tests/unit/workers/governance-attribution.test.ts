import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Governance spend has an owner.
 *
 * Metering never missed these calls — the LLM chokepoint sees every one — but
 * four worker pipelines established no usage context at all, so the Reviewer,
 * the Arbitrator and the Curator wrote `llm_usage` rows with a null user and a
 * null job. Real money, correctly priced, owned by nobody, and invisible to
 * every per-user and per-mandate view for a whole live epoch.
 *
 * Review and arbitration exist because a person asked for something, so the
 * person who asked is the owner. The queue hop is where it was lost: a message
 * is handled in a fresh async context, so identity survives only if the message
 * carries it and the handler restores it.
 */

const CONTRIB = "c0000000-0000-4000-8000-000000000001";
const APPEAL = "a0000000-0000-4000-8000-000000000002";
const CONTRIBUTOR = "u0000000-0000-4000-8000-000000000003";
const APPELLANT = "u0000000-0000-4000-8000-000000000004";

const { state, record } = vi.hoisted(() => {
  const state = {
    contributorId: null as string | null,
    appellantId: null as string | null,
    /** Usage context observed inside each agent run. */
    seen: [] as Array<{
      agent: string;
      userId?: string | null;
      jobId?: string | null;
    }>,
  };
  // Each agent records the ambient context it would be metered under. Defined
  // here because vi.mock factories are hoisted above module-level consts.
  const record = (agent: string) => async () => {
    const { getUsageContext } = await import("../../../src/llm/usage-context.js");
    const ctx = getUsageContext();
    state.seen.push({ agent, userId: ctx.userId, jobId: ctx.jobId });
  };
  return { state, record };
});

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.trimStart().startsWith("UPDATE") && q.includes("RETURNING")) {
      return [{ id: params[0] }];
    }
    if (q.includes("contributor_id FROM contributions")) {
      return [{ contributor_id: state.contributorId }];
    }
    if (q.includes("appellant_id FROM appeals")) {
      return [{ appellant_id: state.appellantId }];
    }
    return [];
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    sqsContributionQueue: "",
    sqsArbitrationQueue: "",
    sqsCuratorQueue: "",
    curatorMaxRuns: 0,
    curatorModel: "claude-fable-5-1",
  }),
}));

vi.mock("../../../src/llm/agents/contribution-reviewer.js", () => ({
  runContributionReview: vi.fn(record("contribution_reviewer")),
}));
vi.mock("../../../src/llm/agents/dispute-arbitrator.js", () => ({
  runArbitration: vi.fn(record("dispute_arbitrator")),
}));
vi.mock("../../../src/llm/agents/curator.js", () => ({
  runCurator: vi.fn(record("curator")),
}));

import { handleContributionMessage } from "../../../src/workers/contribution-pipeline.js";
import { handleArbitrationMessage } from "../../../src/workers/arbitration-pipeline.js";
import { handleCuratorMessage } from "../../../src/workers/curator-pipeline.js";

beforeEach(() => {
  state.contributorId = CONTRIBUTOR;
  state.appellantId = APPELLANT;
  state.seen = [];
});

describe("contribution review attribution", () => {
  it("meters the review to the contributor who submitted it", async () => {
    await handleContributionMessage({ contributionId: CONTRIB });
    // jobId is left unset rather than nulled: a review is owned by a person,
    // not by a funded job, and inventing a job would be a lie in the meter.
    expect(state.seen).toEqual([
      { agent: "contribution_reviewer", userId: CONTRIBUTOR, jobId: undefined },
    ]);
  });

  it("still runs when the contribution has no contributor (system intake)", async () => {
    state.contributorId = null;
    await handleContributionMessage({ contributionId: CONTRIB });
    // Attribution is best-effort: an owner-less row is worse than a failed
    // review, so this degrades rather than throwing.
    expect(state.seen[0]!.userId).toBeNull();
  });
});

describe("arbitration attribution", () => {
  it("meters an appeal to the APPELLANT, not the original contributor", async () => {
    // The party who asked for the arbitration is the party it is for, and an
    // appeal can be filed against someone else's rejected contribution.
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "appeal",
      appealId: APPEAL,
    });
    expect(state.seen).toEqual([
      { agent: "dispute_arbitrator", userId: APPELLANT, jobId: undefined },
    ]);
  });

  it("meters a reviewer escalation to the contributor", async () => {
    // No appellant exists: nobody appealed, the reviewer escalated.
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "escalated_review",
    });
    expect(state.seen[0]!.userId).toBe(CONTRIBUTOR);
  });

  it("falls back to the contributor when the appeal row has no appellant", async () => {
    state.appellantId = null;
    await handleArbitrationMessage({
      contributionId: CONTRIB,
      trigger: "appeal",
      appealId: APPEAL,
    });
    expect(state.seen[0]!.userId).toBe(CONTRIBUTOR);
  });
});

describe("curator attribution across the queue hop", () => {
  it("restores the identity the escalating run put on the message", async () => {
    await handleCuratorMessage({
      trigger: "steward_escalation",
      claimId: "cl000000-0000-4000-8000-000000000005",
      context: "possible duplicate",
      userId: null,
      jobId: "job-7",
    });
    expect(state.seen).toEqual([
      { agent: "curator", userId: null, jobId: "job-7" },
    ]);
  });

  it("carries nothing when the message carried nothing", async () => {
    // A message enqueued before this change, or from a path with no funder.
    await handleCuratorMessage({
      trigger: "steward_escalation",
      claimId: "cl000000-0000-4000-8000-000000000005",
      context: "possible duplicate",
    });
    expect(state.seen[0]).toEqual({
      agent: "curator",
      userId: null,
      jobId: null,
    });
  });
});
