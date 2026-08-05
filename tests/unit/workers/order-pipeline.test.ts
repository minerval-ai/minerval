import { describe, it, expect, beforeEach, vi } from "vitest";

// The express lane's CONTROL FLOW: charge-at-start, the busy/requeue path,
// transient retries keeping their charge, and refund-on-genuine-failure.
// The DB layer and the Steward agent are mocked (CI has no Postgres); the
// SQL itself is exercised live in the corpus harness.

const { state, runCalls } = vi.hoisted(() => ({
  runCalls: [] as Array<{ claimId: string; trigger: string }>,
  state: {
    orders: [] as Array<{
      id: string;
      user_id: string;
      claim_id: string;
      contribution_id: string | null;
      price_micro_usd: number;
      charge_entry_id: string | null;
    }>,
    claimBusy: false,
    claimDecompositionStatus: "complete",
    claimPriorState: "done",
    chargeResult: { charged: true, entryId: "charge-1" } as {
      charged: boolean;
      entryId: string | null;
    },
    charges: [] as unknown[],
    refunds: [] as unknown[],
    stakes: [] as unknown[],
    orderUpdates: [] as Array<{ sql: string; params: unknown[] }>,
    claimReleases: [] as Array<{ id: string; to: string }>,
    throwFor: null as null | ((claimId: string) => Error | null),
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("UPDATE assessment_orders") && q.includes("SKIP LOCKED")) {
      const order = state.orders.shift();
      return order ? [order] : [];
    }
    if (q.includes("FROM (SELECT id, steward_state AS prior_state")) {
      return state.claimBusy
        ? []
        : [
            {
              id: params[0],
              prior_state: state.claimPriorState,
              decomposition_status: state.claimDecompositionStatus,
            },
          ];
    }
    if (q.includes("INSERT INTO claim_stakes")) {
      state.stakes.push(params);
      return [];
    }
    if (q.includes("UPDATE assessment_orders")) {
      state.orderUpdates.push({ sql: q, params });
      return [];
    }
    if (q.includes("UPDATE claims") && q.includes("CASE")) {
      state.claimReleases.push({
        id: params[0] as string,
        to: params[1] as string,
      });
      return [];
    }
    if (q.includes("count(")) return [{ n: state.orders.length }];
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({
  runClaimSteward: vi.fn(
    async (input: { claimId: string; trigger: string }) => {
      runCalls.push({ claimId: input.claimId, trigger: input.trigger });
      const err = state.throwFor?.(input.claimId);
      if (err) throw err;
    }
  ),
}));

vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  OWL_REASONS: { refund: "refund" },
  chargeOwls: vi.fn(async (input: unknown) => {
    state.charges.push(input);
    return state.chargeResult;
  }),
  recordOwlEntry: vi.fn(async (input: unknown) => {
    state.refunds.push(input);
    return true;
  }),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardModel: "claude-sonnet-5", owlPriceMicroUsd: 4_000_000 }),
}));

import { processNextOrderTask } from "../../../src/workers/order-pipeline.js";
import { isTransientApiError } from "../../../src/llm/errors.js";

function order(overrides: Partial<(typeof state.orders)[number]> = {}) {
  return {
    id: "order-1",
    user_id: "user-1",
    claim_id: "claim-1",
    contribution_id: null,
    price_micro_usd: 4_000_000,
    charge_entry_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  runCalls.length = 0;
  state.orders = [];
  state.claimBusy = false;
  state.claimDecompositionStatus = "complete";
  state.claimPriorState = "done";
  state.chargeResult = { charged: true, entryId: "charge-1" };
  state.charges = [];
  state.refunds = [];
  state.stakes = [];
  state.orderUpdates = [];
  state.claimReleases = [];
  state.throwFor = null;
});

describe("processNextOrderTask", () => {
  it("returns empty when the lane is clear", async () => {
    expect((await processNextOrderTask()).status).toBe("empty");
    expect(runCalls).toHaveLength(0);
  });

  it("charges at start, stakes, runs the Steward, and settles done", async () => {
    state.orders = [order()];
    const r = await processNextOrderTask();

    expect(r).toMatchObject({ status: "processed", ok: true, orderId: "order-1" });
    // Charged exactly once, for the assessment op, before the run.
    expect(state.charges).toEqual([
      {
        userId: "user-1",
        priceOwls: 1,
        op: "assessment",
        claimId: "claim-1",
      },
    ]);
    // The stake rides with the charge.
    expect(state.stakes).toHaveLength(1);
    // An assessed claim gets the re-assessment trigger.
    expect(runCalls).toEqual([{ claimId: "claim-1", trigger: "user_order" }]);
    // Claim slot settled 'done', order settled 'done'.
    expect(state.claimReleases).toContainEqual({ id: "claim-1", to: "done" });
    expect(
      state.orderUpdates.some((u) => u.sql.includes("'done'"))
    ).toBe(true);
  });

  it("runs structure_and_assess for a never-stewarded claim", async () => {
    state.orders = [order()];
    state.claimDecompositionStatus = "pending";
    await processNextOrderTask();
    expect(runCalls[0]!.trigger).toBe("structure_and_assess");
  });

  it("skips the charge for a pre-paid (proposal-funded) order", async () => {
    state.orders = [order({ charge_entry_id: "proposal-charge" })];
    const r = await processNextOrderTask();
    expect(r.ok).toBe(true);
    expect(state.charges).toHaveLength(0);
  });

  it("requeues (still uncharged) when the claim is mid-run elsewhere", async () => {
    state.orders = [order()];
    state.claimBusy = true;
    const r = await processNextOrderTask();
    expect(r.status).toBe("busy");
    expect(state.charges).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    // Returned to pending for the next tick.
    expect(
      state.orderUpdates.some((u) => u.sql.includes("'pending'"))
    ).toBe(true);
  });

  it("fails the order without charging when the balance raced away", async () => {
    state.orders = [order()];
    state.chargeResult = { charged: false, entryId: null };
    const r = await processNextOrderTask();
    expect(r).toMatchObject({ status: "processed", ok: false });
    expect(state.refunds).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    // The claim slot goes back exactly as found (it was 'done').
    expect(state.claimReleases).toContainEqual({ id: "claim-1", to: "done" });
    expect(state.orderUpdates.some((u) => u.sql.includes("'failed'"))).toBe(
      true
    );
  });

  it("requeues a transient failure with the charge intact (no refund, no double-charge)", async () => {
    state.orders = [order()];
    const transient = Object.assign(new Error("529 overloaded"), {
      status: 529,
    });
    expect(isTransientApiError(transient)).toBe(true);
    state.throwFor = () => transient;

    const r = await processNextOrderTask();
    expect(r.status).toBe("transient");
    expect(state.charges).toHaveLength(1);
    expect(state.refunds).toHaveLength(0);
    expect(
      state.orderUpdates.some((u) => u.sql.includes("'pending'"))
    ).toBe(true);
    // Claim goes back to pending so the background lane can still serve it.
    expect(state.claimReleases).toContainEqual({
      id: "claim-1",
      to: "pending",
    });
  });

  it("refunds and fails the order on a genuine failure", async () => {
    state.orders = [order()];
    state.throwFor = () => new Error("steward logic error");

    const r = await processNextOrderTask();
    expect(r).toMatchObject({ status: "processed", ok: false });
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({
      userId: "user-1",
      amountMicroUsd: 4_000_000,
      reason: "refund",
      idempotencyKey: "refund:order:order-1",
    });
    expect(state.orderUpdates.some((u) => u.sql.includes("'failed'"))).toBe(
      true
    );
  });
});
