/**
 * A mandate's review pass works to the budget its payer sets (#820),
 * against real Postgres: the operating policy carries the figure with its
 * reason; every site that opens or reopens the review row writes it as the
 * row's estimate (the reconcile sweep, the wake on new events); a pass the
 * day's rate or the escrow cannot fund in full starts short and is told so
 * with figures, and waits below the floor; and a running pass adds to its
 * own budget through the commission path, with the day's rate checked and a
 * refusal that carries the figures, settling as any allocation does.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

type Exec = (name: string, input: Record<string, unknown>) => Promise<string>;
const seen = vi.hoisted(() => ({
  briefing: "",
  tools: [] as string[],
  script: null as null | ((exec: Exec) => Promise<void>),
}));
vi.mock("../../src/llm/client.js", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    toolUseLoop: vi.fn(
      async (opts: { initialMessages: Array<{ content: string }>; tools: Array<{ name: string }>; executeTool: Exec }) => {
        seen.briefing = String(opts.initialMessages[0]?.content ?? "");
        seen.tools = opts.tools.map((t) => t.name);
        if (seen.script) await seen.script(opts.executeTool);
        return { content: "Reviewed.", toolCalls: [], iterations: 1 };
      }
    ),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { seedGrantWithJob, seedUser } from "./helpers.js";
import {
  REVIEW_GROUP,
  claimAction,
  completeAction,
  reconcileActions,
  reviewPassBudgetMicroUsd,
} from "../../src/services/action-service.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";
import { committedWithinMicroUsd } from "../../src/services/pace-service.js";
import { openReviewsForEscalations } from "../../src/services/mandate-event-service.js";
import {
  getOperatingPolicy,
  reviewPassBudget,
  writeOperatingPolicy,
} from "../../src/services/operating-policy-service.js";
import { getMandateAllocationView } from "../../src/services/mandate-service.js";
import { runMandateReview } from "../../src/llm/agents/mandate-review.js";
import { runBudget, withPassBudget } from "../../src/llm/usage-context.js";

const OWL = 1_000_000;

async function mandate(opts: { budgetOwls?: number; dailyOwls?: number } = {}) {
  const funder = await seedUser("pass-budget-funder");
  const { grantId, jobId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: (opts.budgetOwls ?? 50) * OWL,
    dailyBudgetMicroUsd: (opts.dailyOwls ?? 0) * OWL,
  });
  return { funder, grantId, jobId };
}

async function reviewRow(grantId: string) {
  const [row] = await rawQuery<{ id: string; status: string; est: string }>(
    `SELECT id, status, cost_est_micro_usd::text AS est FROM actions WHERE exclusion_group = $1`,
    [REVIEW_GROUP(grantId)]
  );
  return row ? { id: row.id, status: row.status, est: Number(row.est) } : null;
}

async function placements(grantId: string) {
  return rawQuery<{ amount: string; spent: string; released: boolean }>(
    `SELECT amount_micro_usd::text AS amount, spent_micro_usd::text AS spent, released_at IS NOT NULL AS released
       FROM action_allocations WHERE grant_id = $1 AND exclusion_group = $2 ORDER BY created_at`,
    [grantId, REVIEW_GROUP(grantId)]
  );
}

/** Open the mandate's review row and fund it from its own escrow. */
async function openAndFund(grantId: string) {
  await reconcileActions();
  // Every active mandate with no live Grantmaker session has its review
  // opened by the reconcile, and the funding sweep takes the oldest open
  // rows first: other files' mandates would fill its places ahead of this one.
  await rawQuery(
    `UPDATE actions SET status = 'cancelled'
      WHERE status = 'open' AND kind IN ('mandate_review', 'grant_planning') AND target_ref <> $1`,
    [grantId]
  );
  await fundGrantSelfActions();
  return (await reviewRow(grantId))!;
}

describe("the review-pass budget in the operating policy", () => {
  it("is the platform's default until the Grantmaker sets one, then its own figure with its reason", async () => {
    const { grantId } = await mandate();
    expect(reviewPassBudget(await getOperatingPolicy(grantId))).toMatchObject({ microUsd: 5 * OWL, fromPolicy: false });

    await writeOperatingPolicy({ grantId, section: "mission", content: "Map the field.", note: "First draft.", author: "grantmaker" });
    const res = await writeOperatingPolicy({
      grantId,
      content: "",
      note: "A survey and a round of valuations cost about eight owls.",
      author: "grantmaker",
      reviewPassOwls: 8,
    });
    expect(res.ok).toBe(true);
    const policy = await getOperatingPolicy(grantId);
    // The figure alone: the prose stays as it was.
    expect(policy.mission).toBe("Map the field.");
    expect(reviewPassBudget(policy)).toEqual({
      microUsd: 8 * OWL,
      fromPolicy: true,
      reason: "A survey and a round of valuations cost about eight owls.",
    });
    // Kept as a version, and shown on the mandate's public allocation view.
    const versions = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM mandate_policy_versions WHERE grant_id = $1`,
      [grantId]
    );
    expect(versions[0]!.n).toBe(2);
    const view = await getMandateAllocationView(grantId);
    expect(view?.review_pass).toEqual({ owls: 8, reason: "A survey and a round of valuations cost about eight owls." });
  });

  it("refuses a figure of zero or less", async () => {
    const { grantId } = await mandate();
    const res = await writeOperatingPolicy({ grantId, content: "", note: "n", author: "grantmaker", reviewPassOwls: 0 });
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("review_pass_owls") });
  });
});

describe("the review row's estimate", () => {
  it("is the mandate's figure wherever the row is opened or reopened", async () => {
    const { grantId } = await mandate();
    await reconcileActions();
    const opened = (await reviewRow(grantId))!;
    expect(opened).toMatchObject({ status: "open", est: 5 * OWL });

    await writeOperatingPolicy({ grantId, content: "", note: "Eight covers a survey.", author: "grantmaker", reviewPassOwls: 8 });
    const [g] = await rawQuery<{ id: string; mandate: Record<string, unknown> }>(`SELECT id, mandate FROM grants WHERE id = $1`, [grantId]);
    expect(await reviewPassBudgetMicroUsd(g!)).toBe(8 * OWL);
    // A planning pass runs before there is a policy: the default.
    expect(await reviewPassBudgetMicroUsd(g!, "planning")).toBe(5 * OWL);

    // The daily reopen (reconcile), from a row left at some other figure.
    await rawQuery(
      `UPDATE actions SET status = 'done', cost_est_micro_usd = 123, updated_at = now() - interval '3 days' WHERE id = $1`,
      [opened.id]
    );
    await reconcileActions();
    expect(await reviewRow(grantId)).toMatchObject({ status: "open", est: 8 * OWL });

    // A pass opened for an escalation no live session can receive.
    await rawQuery(
      `UPDATE actions SET status = 'done', cost_est_micro_usd = 123, updated_at = now() - interval '2 hours' WHERE id = $1`,
      [opened.id]
    );
    await rawQuery(
      `INSERT INTO petitions (grant_id, kind, asked_micro_usd, plan, status, waiting) VALUES ($1, 'more_budget', 1000000, 'p', 'escalated', true)`,
      [grantId]
    );
    expect(await openReviewsForEscalations()).toBeGreaterThanOrEqual(1);
    expect(await reviewRow(grantId)).toMatchObject({ status: "open", est: 8 * OWL });
    await rawQuery(`UPDATE petitions SET status = 'refused' WHERE grant_id = $1`, [grantId]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [REVIEW_GROUP(grantId)]);
  });
});

describe("a pass the day or the escrow cannot fund in full", () => {
  it("starts with what today's rate has left, and its briefing says so with the figures", async () => {
    const { grantId } = await mandate({ dailyOwls: 3 });
    const row = await openAndFund(grantId);
    expect(row.est).toBe(3 * OWL);
    expect((await placements(grantId)).map((p) => Number(p.amount))).toEqual([3 * OWL]);

    expect(await claimAction(row.id)).toBe(true);
    seen.script = null;
    await withPassBudget(
      { microUsd: row.est, source: "the mandate's allocation for this pass", funding: { actionId: row.id } },
      () => runMandateReview({ grantId })
    );
    expect(seen.briefing).toContain("This run has a budget of $3.00");
    expect(seen.briefing).toContain("the platform's default for a review pass, 5 owls");
    expect(seen.briefing).toContain("This pass was started with less than that, 3 owls");
    expect(seen.briefing).toContain("3 of 3 owls of the pace's window are committed, this pass's budget included");
    expect(seen.briefing).toContain("add_to_pass_budget");
    // The sentence that was never true of this pass.
    expect(seen.briefing).not.toContain("high end of what work like this usually costs");
    await completeAction(row.id, 400_000);
  });

  it("starts with what the escrow has left", async () => {
    const { grantId } = await mandate({ budgetOwls: 2 });
    const row = await openAndFund(grantId);
    expect(row.est).toBe(2 * OWL);
    expect((await placements(grantId)).map((p) => Number(p.amount))).toEqual([2 * OWL]);
  });

  it("waits when less than the floor can be found", async () => {
    const { grantId } = await mandate({ dailyOwls: 0.5 });
    const row = await openAndFund(grantId);
    expect(row).toMatchObject({ status: "open", est: 5 * OWL });
    expect(await placements(grantId)).toEqual([]);
  });

  it("is told the policy's figure and reason when funded in full", async () => {
    const { grantId } = await mandate({ dailyOwls: 20 });
    await writeOperatingPolicy({ grantId, content: "", note: "Eight covers a survey.", author: "grantmaker", reviewPassOwls: 8 });
    const row = await openAndFund(grantId);
    expect(row.est).toBe(8 * OWL);
    expect(await claimAction(row.id)).toBe(true);
    seen.script = null;
    await withPassBudget(
      { microUsd: row.est, source: "the mandate's allocation for this pass", funding: { actionId: row.id } },
      () => runMandateReview({ grantId })
    );
    expect(seen.briefing).toContain("review_pass_owls in your operating policy, 8 owls (Eight covers a survey.)");
    expect(seen.briefing).not.toContain("started with less");
    await completeAction(row.id, 400_000);
  });
});

describe("add_to_pass_budget", () => {
  it("places more of the escrow on the running pass, refuses past the day's rate with figures, and settles", async () => {
    const { grantId } = await mandate({ dailyOwls: 10 });
    const row = await openAndFund(grantId);
    expect(row.est).toBe(5 * OWL);
    expect(await claimAction(row.id)).toBe(true);

    const out: Array<Record<string, unknown>> = [];
    let ceilingAfter = 0;
    seen.script = async (exec) => {
      out.push(JSON.parse(await exec("add_to_pass_budget", { owls: 3, reason: "The survey found sixty children to value." })));
      ceilingAfter = runBudget()!.ceilingMicroUsd;
      out.push(JSON.parse(await exec("add_to_pass_budget", { owls: 5, reason: "And the rest." })));
    };
    await withPassBudget(
      { microUsd: row.est, source: "the mandate's allocation for this pass", funding: { actionId: row.id } },
      () => runMandateReview({ grantId })
    );
    seen.script = null;
    expect(seen.tools).toContain("add_to_pass_budget");

    expect(out[0]).toMatchObject({ success: true, added_owls: 3, budget_owls: 8 });
    expect(ceilingAfter).toBe(8 * OWL);
    // The mandate's one live placement on the row grew; no second row.
    expect((await placements(grantId)).map((p) => Number(p.amount))).toEqual([8 * OWL]);
    expect(await committedWithinMicroUsd(grantId, 24)).toBe(8 * OWL);

    // 8 of today's 10 owls are held: 5 more is refused, with what is left.
    expect(out[1]).toMatchObject({ success: false, code: "OVER_PACE" });
    expect(String(out[1]!.problem)).toContain("2 of 10 owls");
    expect(String(out[1]!.problem)).toContain("the pace is the funder's to change");
    expect((await placements(grantId)).map((p) => Number(p.amount))).toEqual([8 * OWL]);

    // Settlement is the usual one: what the pass metered is spent, the rest freed.
    await completeAction(row.id, 6_500_000);
    expect(await placements(grantId)).toEqual([{ amount: String(8 * OWL), spent: "6500000", released: true }]);
    expect(await committedWithinMicroUsd(grantId, 24)).toBe(6_500_000);
  });

  it("refuses past the uncommitted escrow with figures", async () => {
    const { grantId } = await mandate({ budgetOwls: 6 });
    const row = await openAndFund(grantId);
    expect(await claimAction(row.id)).toBe(true);
    const out: Array<Record<string, unknown>> = [];
    seen.script = async (exec) => {
      out.push(JSON.parse(await exec("add_to_pass_budget", { owls: 4, reason: "More survey." })));
    };
    await withPassBudget(
      { microUsd: row.est, source: "the mandate's allocation for this pass", funding: { actionId: row.id } },
      () => runMandateReview({ grantId })
    );
    seen.script = null;
    expect(out[0]).toMatchObject({ success: false, code: "OVER_ESCROW" });
    expect(String(out[0]!.problem)).toContain("(1 owls)");
    await completeAction(row.id, 100_000);
  });
});
