import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A claim parks as 'error' inside one CASE expression, from any of three
 * lanes, and the park quietly takes the claim out of every candidate set —
 * retiring funded ledger rows unrun (#834). `reportStewardPark` is what
 * makes that visible: it reads the row back to see whether the park
 * happened, and files on the agents' own channel (#366) when it did.
 */
const { state } = vi.hoisted(() => ({
  state: {
    row: null as null | {
      steward_state: string;
      steward_error: string | null;
      steward_attempts: number;
      text: string;
      retired_backing_micro_usd: number;
    },
    throwOnRead: false,
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => {
    if (state.throwOnRead) throw new Error("db down");
    return state.row ? [state.row] : [];
  }),
}));

const raiseIssue = vi.hoisted(() => vi.fn(async () => ({ acknowledged: true })));
vi.mock("../../../src/services/report-service.js", () => ({ raiseIssue }));

import { reportStewardPark } from "../../../src/services/steward-lease.js";

const CLAIM = "a1111111-1111-4111-8111-111111111111";

beforeEach(() => {
  raiseIssue.mockClear();
  state.throwOnRead = false;
  state.row = {
    steward_state: "error",
    steward_error: "boom: null reference in decomposition",
    steward_attempts: 3,
    text: "The sky is blue",
    retired_backing_micro_usd: 0,
  };
});

describe("reportStewardPark (#834)", () => {
  it("reports a park, naming the lane, the attempts and the recorded failure", async () => {
    expect(await reportStewardPark(CLAIM, "steward-pipeline")).toBe(true);
    expect(raiseIssue).toHaveBeenCalledTimes(1);
    const input = raiseIssue.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.kind).toBe("system_failure");
    expect(input.severity).toBe("degraded");
    expect(input.surface).toBe("steward park (steward-pipeline)");
    expect(input.title).toContain(CLAIM);
    expect(String(input.body)).toContain("3 genuine failures");
    expect(String(input.body)).toContain("boom: null reference in decomposition");
    expect(input.contextRefs).toEqual({ claim_id: CLAIM });
  });

  it("reads funded work retired unrun as blocking, with the money named", async () => {
    state.row!.retired_backing_micro_usd = 2_500_000;
    await reportStewardPark(CLAIM, "grant-pipeline");
    const input = raiseIssue.mock.calls[0]![0] as Record<string, unknown>;
    // Someone paid for a pass that will not come until this is looked at.
    expect(input.severity).toBe("blocking");
    expect(String(input.body)).toContain("2.50 USD");
  });

  it("says nothing when the failure update did not park the claim", async () => {
    state.row!.steward_state = "pending";
    expect(await reportStewardPark(CLAIM, "budget-job-pipeline")).toBe(false);
    expect(raiseIssue).not.toHaveBeenCalled();
  });

  it("never throws on the lane that called it", async () => {
    state.throwOnRead = true;
    expect(await reportStewardPark(CLAIM, "steward-pipeline")).toBe(false);
  });
});
