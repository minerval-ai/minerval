import { describe, it, expect, vi } from "vitest";

/**
 * The mathematics event kinds on the claim history (docs/mathematics.md
 * §11.1): formalization transitions, checker verdicts, bounties and prize
 * claims, and solver attempts, each derived from its row so the record is
 * reproducible; and the in-process emit seam the writers fire through.
 */
import {
  composeClaimEvents,
  emitClaimEvent,
  subscribeClaimEvents,
  type ClaimEvent,
  type ClaimEventsInput,
} from "../../../src/services/claim-events-service.js";

const CLAIM = {
  id: "c0000000-0000-4000-8000-000000000001",
  createdBy: "extractor",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const F1 = "f0000000-0000-4000-8000-000000000001";
const F2 = "f0000000-0000-4000-8000-000000000002";

function base(): ClaimEventsInput {
  return {
    claim: CLAIM,
    assessments: [],
    contributions: [],
    reviews: [],
    appeals: [],
    arbitrations: [],
    auditEntries: [],
  };
}

const formalization = (over: Partial<NonNullable<ClaimEventsInput["formalizations"]>[0]> = {}) => ({
  id: F1,
  version: 1,
  status: "published",
  namespace: "Minerval.Sc0000000_v1",
  pinId: "mathlib-v4.33.0",
  sourceHash: "src",
  exprHash: "expr",
  authoredBy: "claim_steward",
  reviewedAt: new Date("2026-02-01T00:00:00.000Z"),
  publishedAt: new Date("2026-02-02T00:00:00.000Z"),
  reviewPeriodEndsAt: new Date("2026-02-16T00:00:00.000Z"),
  retiredAt: null,
  retireReason: null,
  ...over,
});

describe("composeClaimEvents: mathematics kinds", () => {
  it("composes exactly as before when the mathematics rows are absent", () => {
    expect(composeClaimEvents(base()).map((e) => e.kind)).toEqual(["created"]);
  });

  it("derives reviewed, published, and retired events from a statement's timestamps", () => {
    const events = composeClaimEvents({
      ...base(),
      formalizations: [
        formalization({
          status: "retired",
          retiredAt: new Date("2026-03-01T00:00:00.000Z"),
          retireReason: "superseded by version 2",
        }),
        formalization({
          id: F2,
          version: 2,
          reviewedAt: new Date("2026-02-28T00:00:00.000Z"),
          publishedAt: new Date("2026-03-01T00:00:00.000Z"),
        }),
      ],
    });
    const f = events.filter((e): e is Extract<ClaimEvent, { kind: "formalization" }> => e.kind === "formalization");
    // Newest first; version 1's retirement and version 2's publication share
    // an instant and keep row order.
    expect(f.map((e) => [e.version, e.subtype])).toEqual([
      [1, "retired"],
      [2, "published"],
      [2, "reviewed"],
      [1, "published"],
      [1, "reviewed"],
    ]);
    expect(f[0]).toMatchObject({
      id: `formalization:${F1}:retired`,
      at: "2026-03-01T00:00:00.000Z",
      actor: "claim_steward",
      claim_id: CLAIM.id,
      formalization_id: F1,
      reason: "superseded by version 2",
      review_period_ends_at: "2026-02-16T00:00:00.000Z",
    });
  });

  it("carries a checker verdict with the failed gate, and orders it after the statement at the same instant", () => {
    const at = new Date("2026-02-02T00:00:00.000Z");
    const events = composeClaimEvents({
      ...base(),
      formalizations: [formalization()],
      leanChecks: [
        {
          id: "lc-1",
          formalizationId: F1,
          mode: "steward",
          kind: "proof",
          verdict: "rejected",
          checks: { static_policy: { status: "pass" }, compile: { status: "pass" }, axioms: { status: "fail" } },
          submittedBy: "claim_steward",
          pinId: "mathlib-v4.33.0",
          submissionSha256: "abc",
          createdAt: new Date("2026-02-01T23:00:00.000Z"),
          finishedAt: at,
        },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(["lean_check", "formalization", "formalization", "created"]);
    expect(events[0]).toMatchObject({
      kind: "lean_check",
      id: "lean_check:lc-1",
      at: at.toISOString(),
      actor: "claim_steward",
      lean_check_id: "lc-1",
      formalization_id: F1,
      mode: "steward",
      check_kind: "proof",
      verdict: "rejected",
      failed_gate: "axioms",
    });
  });

  it("derives prize events from the bounty and its claims, and attempt events from the attempts", () => {
    const events = composeClaimEvents({
      ...base(),
      bounties: [
        {
          id: "b-1",
          formalizationId: F1,
          amountMicroUsd: 2_500_000_000,
          status: "paid",
          rulesVersion: "2026-09",
          requestedAt: new Date("2026-03-01T00:00:00.000Z"),
          openedAt: new Date("2026-03-02T00:00:00.000Z"),
          resolvedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
      prizeClaims: [
        {
          id: "pc-1",
          bountyId: "b-1",
          formalizationId: F1,
          direction: "proof",
          status: "paid",
          creditName: "A. Solver",
          rulesVersion: "2026-09",
          submittedAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
      attempts: [
        {
          id: "att-1",
          formalizationId: F1,
          variant: "max",
          effort: "max",
          status: "completed",
          outcome: "negative",
          spentMicroUsd: 84_000_000,
          isCalibration: false,
          startedAt: new Date("2026-02-20T00:00:00.000Z"),
          finishedAt: new Date("2026-02-20T05:00:00.000Z"),
          publishedAt: new Date("2026-02-21T00:00:00.000Z"),
        },
      ],
    });
    expect(events.map((e) => e.id)).toEqual([
      "prize:bounty:b-1:resolved",
      "prize:claim:pc-1:decided",
      "prize:claim:pc-1:filed",
      "prize:bounty:b-1:opened",
      "prize:bounty:b-1:requested",
      "attempt:att-1:published",
      "attempt:att-1:finished",
      "attempt:att-1:started",
      `created:${CLAIM.id}`,
    ]);
    expect(events[1]).toMatchObject({
      kind: "prize",
      subtype: "claim_decided",
      actor: "A. Solver",
      bounty_id: "b-1",
      prize_claim_id: "pc-1",
      direction: "proof",
      status: "paid",
      credit_name: "A. Solver",
    });
    expect(events[4]).toMatchObject({
      kind: "prize",
      subtype: "bounty_requested",
      amount_micro_usd: 2_500_000_000,
      rules_version: "2026-09",
      actor: "minerval",
    });
    expect(events[6]).toMatchObject({
      kind: "attempt",
      subtype: "finished",
      attempt_id: "att-1",
      variant: "max",
      outcome: "negative",
      spent_micro_usd: 84_000_000,
      is_calibration: false,
      actor: "math_solver",
    });
  });
});

describe("emitClaimEvent", () => {
  it("delivers to every subscriber and survives a listener that throws", async () => {
    const seen: string[] = [];
    const off1 = subscribeClaimEvents((e) => {
      seen.push(`one:${e.id}`);
    });
    const off2 = subscribeClaimEvents(() => {
      throw new Error("listener failure");
    });
    const off3 = subscribeClaimEvents(async (e) => {
      seen.push(`three:${e.id}`);
    });
    const muted = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await emitClaimEvent({
        kind: "lean_check",
        id: "lean_check:x",
        at: "2026-01-01T00:00:00.000Z",
        actor: "claim_steward",
        claim_id: CLAIM.id,
        lean_check_id: "x",
        formalization_id: F1,
        mode: "steward",
        check_kind: "proof",
        verdict: "accepted",
        failed_gate: null,
        pin_id: "p",
        submission_sha256: "s",
      });
    } finally {
      muted.mockRestore();
      off1();
      off2();
      off3();
    }
    expect(seen).toEqual(["one:lean_check:x", "three:lean_check:x"]);
  });
});

