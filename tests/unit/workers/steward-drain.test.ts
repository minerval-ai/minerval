import { describe, it, expect, beforeEach, vi } from "vitest";

// The Steward queue is the `claims` table (steward_state='pending'), drained
// highest-importance-first by SQL `ORDER BY importance DESC`. That ordering is
// the DB's job and is verified live in the corpus harness (CI has no Postgres).
// Here we test the drain's CONTROL FLOW — task claiming, the maxTasks cap, the
// empty/budget transitions, and that a budget error returns the claim to the
// queue — by mocking the DB layer and the Steward agent.

const { runCalls, state } = vi.hoisted(() => ({
  runCalls: [] as string[],
  state: {
    pending: [] as string[],
    // Claims whose contribution pot covers the pass: served by the funded
    // lane ahead of everything, outside the daily budget.
    fundedPending: [] as string[],
    consumed: [] as Array<{ id: string; take: number }>,
    budgetThrows: false,
    // Per-claim attempt counter, keyed by id (defaults 0), so a requeued claim
    // is re-served with its incremented count like the real DB column.
    attempts: {} as Record<string, number>,
    // Optional throw factory: given the claim id, return an Error to throw (or
    // null to succeed). Lets a test simulate transient vs genuine failures.
    throwFor: null as null | ((id: string) => Error | null),
    markedPendingAgain: [] as string[],
    markedError: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    const serve = (id: string | undefined) =>
      id
        ? [
            {
              id,
              steward_trigger: "structure_and_assess",
              steward_context: "",
              steward_attempts: state.attempts[id] ?? 0,
            },
          ]
        : [];
    // The two claim-selection queries both carry SKIP LOCKED + UPDATE
    // claims: the covered lane filters on allocations covering the tier
    // cost (action_allocations + ">="), the fallback lane divides by tier
    // cost ("queue_priority /").
    if (q.includes("SKIP LOCKED") && q.includes("UPDATE claims")) {
      if (q.includes("queue_priority /")) return serve(state.pending.shift());
      return serve(state.fundedPending.shift());
    }
    // consumeAllocations' row scan and the pro-rata consumption write.
    if (q.includes("FROM action_allocations") && q.trimStart().startsWith("SELECT id")) {
      return [{ id: "pot-1", unspent: 1_000_000 }];
    }
    if (q.includes("UPDATE action_allocations")) {
      state.consumed.push({ id: params[0] as string, take: params[1] as number });
      return [];
    }
    // The General mandate lookup: none seeded in these tests.
    if (q.includes("is_platform")) return [];
    if (q.includes("count(")) return [{ n: state.pending.length }];
    if (q.startsWith("UPDATE")) {
      const id = params[0] as string;
      if (q.includes("'error'")) {
        state.markedError.push(id);
      } else if (q.includes("'pending'")) {
        state.markedPendingAgain.push(id);
        // Simulate the DB column: capture the attempts value written back, and
        // requeue the id so the drain can re-serve it.
        if (params.length >= 3) state.attempts[id] = params[2] as number;
        state.pending.push(id);
      }
    }
    return [];
  }),
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({
  runClaimSteward: vi.fn(async (input: { claimId: string }) => {
    runCalls.push(input.claimId);
    if (state.budgetThrows) {
      const { LlmBudgetExceededError } = await import("../../../src/llm/errors.js");
      throw new LlmBudgetExceededError("daily_token_count", 1, 1);
    }
    const err = state.throwFor?.(input.claimId);
    if (err) throw err;
  }),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardModel: "claude-sonnet-5", stewardMaxRuns: 0 }),
}));

import {
  drainStewardQueue,
  processNextStewardTask,
} from "../../../src/workers/steward-pipeline.js";

describe("Steward DB-backed drain", () => {
  beforeEach(() => {
    runCalls.length = 0;
    state.pending = [];
    state.fundedPending = [];
    state.consumed = [];
    state.budgetThrows = false;
    state.attempts = {};
    state.throwFor = null;
    state.markedPendingAgain = [];
    state.markedError = [];
  });

  it("drains every pending claim, then reports empty", async () => {
    state.pending = ["a", "b", "c"];
    const res = await drainStewardQueue();
    expect(runCalls).toEqual(["a", "b", "c"]);
    expect(res).toEqual({ processed: 3, budgetHit: false });
  });

  it("serves contribution-funded claims first and consumes their pot", async () => {
    state.pending = ["a"];
    state.fundedPending = ["funded-1"];
    const res = await drainStewardQueue();
    // The funded claim runs before the mandate lane's pick. (Pot
    // consumption follows the METERED cost, which the mocked agent leaves
    // at zero, so it isn't asserted here; the SQL is covered live.)
    expect(runCalls).toEqual(["funded-1", "a"]);
    expect(res.processed).toBe(2);
  });

  it("stops at maxTasks, leaving the rest pending (stubs)", async () => {
    state.pending = ["a", "b", "c", "d"];
    const res = await drainStewardQueue({ maxTasks: 2 });
    expect(runCalls).toEqual(["a", "b"]);
    expect(res.processed).toBe(2);
    expect(state.pending).toEqual(["c", "d"]); // untouched
  });

  it("returns 'empty' when nothing is pending", async () => {
    const r = await processNextStewardTask();
    expect(r.status).toBe("empty");
    expect(runCalls).toEqual([]);
  });

  it("on a budget error, returns the claim to the queue and reports budget", async () => {
    state.pending = ["a", "b"];
    state.budgetThrows = true;
    const r = await processNextStewardTask();
    expect(r.status).toBe("budget");
    expect(runCalls).toEqual(["a"]);
    expect(state.markedPendingAgain).toContain("a"); // re-queued, not lost
  });

  it("on a transient API error, requeues the claim without parking it (#97)", async () => {
    state.pending = ["a"];
    state.throwFor = () =>
      Object.assign(new Error("Your credit balance is too low"), { status: 400 });
    const r = await processNextStewardTask();
    expect(r.status).toBe("transient");
    expect(state.markedPendingAgain).toContain("a"); // back to pending
    expect(state.markedError).not.toContain("a"); // NOT parked as error
    expect(state.attempts["a"] ?? 0).toBe(0); // transient doesn't count an attempt
  });

  it("stops the drain after a run of consecutive transient failures", async () => {
    state.pending = ["a"];
    state.throwFor = () =>
      Object.assign(new Error("429 rate limit"), { status: 429 });
    const res = await drainStewardQueue();
    expect(res.budgetHit).toBe(true); // circuit breaker tripped
    expect(res.processed).toBe(0); // transient failures don't count as processed
    expect(runCalls.length).toBe(5); // TRANSIENT_CIRCUIT_BREAK
    expect(state.markedError).not.toContain("a"); // never parked
  });

  it("parks a genuinely failing claim as error only after the attempt cap", async () => {
    state.pending = ["a"];
    state.throwFor = () => new Error("boom: null reference in decomposition");
    const res = await drainStewardQueue();
    expect(runCalls.length).toBe(3); // MAX_STEWARD_ATTEMPTS
    expect(state.markedError).toContain("a"); // parked after the cap
    expect(res.processed).toBe(3);
  });
});
