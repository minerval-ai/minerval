/**
 * A review pass's valuations are funded when the pass ends, not at the next
 * allocation sweep: the mandate's allocator runs right after a pass that
 * wrote valuations, within its daily rate and escrow. The model is scripted;
 * the ledger, valuations and allocator are real.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const script = vi.hoisted(() => ({ actionId: "" }));
vi.mock("../../src/llm/client.js", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    toolUseLoop: vi.fn(async (opts: { executeTool: (n: string, i: Record<string, unknown>) => Promise<string> }) => {
      if (script.actionId) {
        await opts.executeTool("set_valuations", {
          entries: [{ action_id: script.actionId, value: 8, rationale: "a live crux in scope" }],
        });
      }
      return { content: "Valued the open pass on the crux.", toolCalls: [], iterations: 1 };
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { runMandateReview } from "../../src/llm/agents/mandate-review.js";

describe("a review pass that values work", () => {
  it("funds it as the pass ends", async () => {
    const funder = await seedUser("review-funder");
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 50_000_000,
      dailyBudgetMicroUsd: 10_000_000,
    });
    const claim = await seedClaim("review crux");
    const group = `assess:${claim}:${randomUUID().slice(0, 6)}`;
    script.actionId = await seedAction({ group, claimId: claim, costMicroUsd: 1_000_000 });

    const res = await runMandateReview({ grantId });
    expect(res.valuationsWritten).toBe(1);
    expect(res.allocated).toBeGreaterThanOrEqual(1);
    const placed = await rawQuery<{ amount: string }>(
      `SELECT amount_micro_usd AS amount FROM action_allocations
        WHERE grant_id = $1 AND exclusion_group = $2 AND released_at IS NULL`,
      [grantId, group]
    );
    expect(placed.length).toBeGreaterThanOrEqual(1);
  });

  it("allocates nothing when the pass wrote no valuations", async () => {
    const funder = await seedUser("review-funder-2");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000, dailyBudgetMicroUsd: 10_000_000 });
    script.actionId = "";
    const res = await runMandateReview({ grantId });
    expect(res).toMatchObject({ valuationsWritten: 0, allocated: 0 });
  });
});
