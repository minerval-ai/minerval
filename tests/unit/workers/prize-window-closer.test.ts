/**
 * The window closer (docs/mathematics.md §8.5): a promoted claim brings a
 * direct Steward invocation on prize_window_closed under the reserve job;
 * an upheld challenge voids and invokes prize_claim_voided; the dated
 * steps each run once per pass and a failure in one never stops the rest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  elapsed: [] as Array<{ id: string }>,
  overturned: [] as Array<{ prize_claim_id: string; content: string; contribution_id: string }>,
  promoted: true,
  steward: [] as Array<Record<string, unknown>>,
  voids: [] as Array<Record<string, unknown>>,
  forfeits: ["pc-old"],
  expireThrows: false,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("status = 'in_challenge_window' AND window_ends_at")) return state.elapsed;
    if (sql.includes("challenged_prize_claim_id AS prize_claim_id")) return state.overturned;
    return [];
  }),
}));
vi.mock("../../../src/workers/steward-direct.js", () => ({
  invokeStewardDirect: vi.fn(async (input: Record<string, unknown>) => {
    state.steward.push(input);
    return { model: "strong", billedMicroUsd: 5 };
  }),
}));
vi.mock("../../../src/services/prize-claim-service.js", () => ({
  promotePayable: vi.fn(async () => ({ promoted: state.promoted, check: null })),
  getPrizeClaimById: vi.fn(async (id: string) => ({ id, claim_id: `claim-of-${id}`, bounty_id: "b-1" })),
  forfeitOverduePrizeClaims: vi.fn(async () => state.forfeits),
  voidPrizeClaim: vi.fn(async (input: Record<string, unknown>) => {
    state.voids.push(input);
    return { ok: true, status: "voided", bounty_status: "rebinding" };
  }),
  challengePauseState: vi.fn(async () => ({ closedMs: 0, openSince: null, arbitrationHumanReview: false, overturned: true })),
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  expireAndWithdrawDueBounties: vi.fn(async () => {
    if (state.expireThrows) throw new Error("boom");
    return { expired: 1, withdrawn: 2 };
  }),
  rebindDueBounties: vi.fn(async () => 1),
  getReserveJob: vi.fn(async () => ({ id: "job-reserve", user_id: "platform" })),
  getPlatformAccountId: vi.fn(async () => "platform"),
}));
vi.mock("../../../src/services/prize-payout-service.js", () => ({
  sweepPrizeTranches: vi.fn(async () => 3),
}));

import { runPrizeWindowCloser, promoteElapsedWindows, voidUpheldChallenges } from "../../../src/workers/prize-window-closer.js";

beforeEach(() => {
  state.elapsed = [];
  state.overturned = [];
  state.promoted = true;
  state.steward = [];
  state.voids = [];
  state.forfeits = ["pc-old"];
  state.expireThrows = false;
});

describe("promotion", () => {
  it("invokes the Steward directly on prize_window_closed under the reserve job for each promoted claim", async () => {
    state.elapsed = [{ id: "pc-1" }, { id: "pc-2" }];
    const r = await promoteElapsedWindows({ model: "m" });
    expect(r).toEqual({ promoted: 2, stewardRuns: 2 });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_window_closed", claimId: "claim-of-pc-1", jobId: "job-reserve", userId: "platform", model: "m" });
    expect(String(state.steward[0]!.context)).toMatch(/pc-1/);
  });

  it("does not invoke the Steward when the window is not ready", async () => {
    state.elapsed = [{ id: "pc-1" }];
    state.promoted = false;
    expect(await promoteElapsedWindows()).toEqual({ promoted: 0, stewardRuns: 0 });
    expect(state.steward).toHaveLength(0);
  });
});

describe("upheld challenges", () => {
  it("voids with the challenge's ground and invokes prize_claim_voided", async () => {
    state.overturned = [{ prize_claim_id: "pc-1", content: "[ground: ineligibility] the claimant is a contractor", contribution_id: "ch-1" }];
    const r = await voidUpheldChallenges();
    expect(r).toEqual({ voided: 1, stewardRuns: 1 });
    expect(state.voids[0]).toMatchObject({ prizeClaimId: "pc-1", ground: "ineligibility", actor: "dispute_arbitrator" });
    expect(state.steward[0]).toMatchObject({ trigger: "prize_claim_voided", claimId: "claim-of-pc-1", jobId: "job-reserve" });
  });
});

describe("one pass", () => {
  it("runs every dated step and reports counts; a failing step never stops the rest", async () => {
    state.expireThrows = true;
    const stats = await runPrizeWindowCloser();
    expect(stats).toEqual({ promoted: 0, voided: 0, forfeited: 1, expired: 0, withdrawn: 0, rebound: 1, tranches: 3, stewardRuns: 0 });
    state.expireThrows = false;
    expect(await runPrizeWindowCloser()).toMatchObject({ expired: 1, withdrawn: 2 });
  });
});
