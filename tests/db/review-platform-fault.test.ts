/**
 * A platform fault during a contribution review, against real Postgres
 * (#980, #996).
 *
 * On 2026-11-12 the Matcher's provider ran out of credits. A Reviewer's
 * accept of an intake proposal runs the Matcher before anything is written,
 * so record_review_decision returned the provider's raw "402" text, nothing
 * was recorded, and each such run spent one of the contribution's three
 * attempts. After three the recovery sweep stopped re-driving it, and the
 * contribution read 'pending' for good.
 *
 * Here the Reviewer's own wrapper, its real tool and the real pipeline run;
 * only the model loop (which calls the tool as a model would) and the
 * Matcher (which fails as the provider did) are stood in for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  toolResults: [] as string[],
  // What the stand-in model loop does: call record_review_decision, or fail
  // on its own call as the provider did.
  loop: "accept" as "accept" | "own_call_402",
}));

const providerOutOfCredits = () => Object.assign(new Error("402 Insufficient credits"), { status: 402 });

vi.mock("../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () => {
    throw providerOutOfCredits();
  }),
}));
vi.mock("../../src/llm/agents/domain-prior.js", () => ({
  inferDomainPrior: vi.fn(async () => []),
}));
vi.mock("../../src/llm/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/client.js")>()),
  toolUseLoop: vi.fn(
    async (options: {
      initialMessages: Array<{ content: unknown }>;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
      beforeTurn?: (turn: number) => Promise<void> | void;
    }) => {
      await options.beforeTurn?.(0);
      if (mocks.loop === "own_call_402") throw providerOutOfCredits();
      const id = /contribution ([0-9a-f-]{36})/.exec(String(options.initialMessages[0]!.content))![1]!;
      mocks.toolResults.push(
        await options.executeTool("record_review_decision", {
          contribution_id: id,
          decision: "accept",
          reasoning: "A well-formed question, asked in good faith.",
          confidence: 0.9,
          policy_citations: ["§4"],
        })
      );
      // The model's next turn: the wrapper ends the run before it.
      await options.beforeTurn?.(1);
      return { messages: [], finalResult: null };
    }
  ),
}));

import { rawQuery } from "../../src/db/client.js";
import { seedUser } from "./helpers.js";
import { createClaimProposal } from "../../src/services/intake-service.js";
import { handleContributionMessage, MAX_REVIEW_ATTEMPTS } from "../../src/workers/contribution-pipeline.js";
import { PlatformFaultStop } from "../../src/services/deployment-fault.js";

async function row(id: string) {
  const [r] = await rawQuery<{ review_status: string; review_attempts: number; review_claimed_at: Date | null }>(
    `SELECT review_status, review_attempts, review_claimed_at FROM contributions WHERE id = $1`,
    [id]
  );
  return r!;
}

/** Let the reclaim window lapse, as the recovery sweep would find the row. */
async function lapse(id: string): Promise<void> {
  await rawQuery(`UPDATE contributions SET review_claimed_at = now() - interval '1 hour' WHERE id = $1`, [id]);
}

beforeEach(() => {
  mocks.toolResults = [];
  mocks.loop = "accept";
});

describe("a Matcher refused for credits while a Reviewer accepts an intake proposal", () => {
  it("tells the Reviewer by class, ends the run, records nothing, and gives the attempt back", async () => {
    const user = await seedUser("fault asker");
    const asked = await createClaimProposal({
      claimText: "Where did the 1918 influenza pandemic begin?",
      contributorId: user,
      kind: "question",
    });

    await expect(handleContributionMessage({ contributionId: asked.id })).rejects.toBeInstanceOf(PlatformFaultStop);

    const result = JSON.parse(mocks.toolResults[0]!);
    expect(result).toMatchObject({ success: false, platform_fault: "credits_fault" });
    expect(result.error).toContain("Nothing was recorded");
    expect(result.error).toContain("do not raise_issue");
    expect(mocks.toolResults[0]).not.toMatch(/402|Insufficient credits/);

    expect(await rawQuery(`SELECT 1 FROM contribution_reviews WHERE contribution_id = $1`, [asked.id])).toEqual([]);
    const after = await row(asked.id);
    expect(after.review_status).toBe("pending");
    expect(after.review_attempts).toBe(0);
    // Kept, restamped: the reclaim window is the wait before the next try.
    expect(after.review_claimed_at).not.toBeNull();
    expect(Date.now() - new Date(after.review_claimed_at!).getTime()).toBeLessThan(60_000);
    // While it holds, a second message no-ops.
    await handleContributionMessage({ contributionId: asked.id });
    expect(mocks.toolResults).toHaveLength(1);
  });

  it("never parks the contribution, however many windows the fault lasts", async () => {
    const user = await seedUser("fault asker 2");
    const asked = await createClaimProposal({
      claimText: "Did the 1918 influenza pandemic begin in Kansas?",
      contributorId: user,
    });
    for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 2; i++) {
      await lapse(asked.id);
      await expect(handleContributionMessage({ contributionId: asked.id })).rejects.toBeInstanceOf(PlatformFaultStop);
    }
    expect(mocks.toolResults).toHaveLength(MAX_REVIEW_ATTEMPTS + 2);
    expect(await row(asked.id)).toMatchObject({ review_status: "pending", review_attempts: 0 });
  });
});

describe("a Reviewer whose own model call is refused for credits", () => {
  it("gives the attempt back", async () => {
    const user = await seedUser("fault asker 3");
    const asked = await createClaimProposal({
      claimText: "Was the 1918 influenza pandemic first recorded at Camp Funston?",
      contributorId: user,
    });
    mocks.loop = "own_call_402";
    await expect(handleContributionMessage({ contributionId: asked.id })).rejects.toThrow("402");
    expect(await row(asked.id)).toMatchObject({ review_status: "pending", review_attempts: 0 });
  });
});
