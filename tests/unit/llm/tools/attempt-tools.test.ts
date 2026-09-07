import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The attempt tools (docs/mathematics.md §7.6): get_proof_attempt returns
 * the record the service assembles (never the transcript unless a tail is
 * asked for, clamped to fifty steps), and mark_problem_solved_by_platform
 * is mechanical, passing the service's refusals through as structured
 * results and never throwing.
 */
const mocks = vi.hoisted(() => ({
  getAttemptForSteward: vi.fn(),
  markProblemSolvedByPlatform: vi.fn(),
}));

vi.mock("../../../../src/services/attempt-service.js", () => ({
  getAttemptForSteward: mocks.getAttemptForSteward,
  markProblemSolvedByPlatform: mocks.markProblemSolvedByPlatform,
}));

import {
  ATTEMPT_TOOL_NAMES,
  executeGetProofAttempt,
  executeMarkProblemSolvedByPlatform,
  registerAttemptTools,
} from "../../../../src/llm/tools/attempt-tools.js";

const ctx = { role: "claim-steward" as const };

beforeEach(() => {
  mocks.getAttemptForSteward.mockReset();
  mocks.markProblemSolvedByPlatform.mockReset();
});

describe("registration", () => {
  it("registers exactly the two declared tools", () => {
    const registered: string[] = [];
    registerAttemptTools((name) => registered.push(name));
    expect(registered).toEqual(["get_proof_attempt", "mark_problem_solved_by_platform"]);
    expect([...ATTEMPT_TOOL_NAMES]).toEqual(registered);
  });
});

describe("get_proof_attempt", () => {
  it("requires attempt_id and reports a missing attempt", async () => {
    expect(JSON.parse(await executeGetProofAttempt({}, ctx))).toEqual({
      success: false,
      message: "attempt_id is required.",
    });
    mocks.getAttemptForSteward.mockResolvedValueOnce(null);
    const out = JSON.parse(await executeGetProofAttempt({ attempt_id: "a1" }, ctx));
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/No attempt a1/);
  });

  it("returns the record without a transcript by default, with a clamped tail on request", async () => {
    const record = {
      attempt: { id: "a1", status: "completed", outcome: "proof" },
      report: { outcome: "proof" },
      lean_proof: "p",
      lean_check_id: "chk-1",
      notebook: { plan: "x" },
      lean_checks: [{ id: "chk-1", verdict: "accepted" }],
      formalization: { id: "f1" },
      bounty: null,
    };
    mocks.getAttemptForSteward.mockResolvedValue(record);
    const out = JSON.parse(await executeGetProofAttempt({ attempt_id: "a1" }, ctx));
    expect(out).toMatchObject({ success: true, ...record });
    expect(out.note).toMatch(/written by the server/);
    expect(mocks.getAttemptForSteward).toHaveBeenLastCalledWith("a1", { transcriptTail: undefined });

    await executeGetProofAttempt({ attempt_id: "a1", include_transcript_tail: 500 }, ctx);
    expect(mocks.getAttemptForSteward).toHaveBeenLastCalledWith("a1", { transcriptTail: 50 });
    await executeGetProofAttempt({ attempt_id: "a1", include_transcript_tail: 7.9 }, ctx);
    expect(mocks.getAttemptForSteward).toHaveBeenLastCalledWith("a1", { transcriptTail: 7 });
    await executeGetProofAttempt({ attempt_id: "a1", include_transcript_tail: 0 }, ctx);
    expect(mocks.getAttemptForSteward).toHaveBeenLastCalledWith("a1", { transcriptTail: undefined });
  });
});

describe("mark_problem_solved_by_platform", () => {
  it("names the missing fields", async () => {
    const out = JSON.parse(await executeMarkProblemSolvedByPlatform({ attempt_id: "a1" }, ctx));
    expect(out.success).toBe(false);
    expect(out.message).toBe("Missing required field(s): formalization_id, lean_check_id, reason.");
    expect(mocks.markProblemSolvedByPlatform).not.toHaveBeenCalled();
  });

  it("passes a refusal through as a structured result", async () => {
    mocks.markProblemSolvedByPlatform.mockResolvedValueOnce({
      ok: false,
      code: "NOT_A_RESULT",
      message: "partial settles nothing",
    });
    const out = JSON.parse(
      await executeMarkProblemSolvedByPlatform(
        { formalization_id: "f1", attempt_id: "a1", lean_check_id: "c1", reason: "r" },
        ctx
      )
    );
    expect(out).toEqual({ success: false, code: "NOT_A_RESULT", message: "partial settles nothing" });
  });

  it("passes the pending human claims through on HUMAN_CLAIM_PENDING", async () => {
    mocks.markProblemSolvedByPlatform.mockResolvedValueOnce({
      ok: false,
      code: "HUMAN_CLAIM_PENDING",
      message: "a claim filed earlier is judged first",
      pending_prize_claims: [{ id: "pc-1", status: "in_review", submitted_at: "2026-08-30T12:00:00.000Z" }],
    });
    const out = JSON.parse(
      await executeMarkProblemSolvedByPlatform(
        { formalization_id: "f1", attempt_id: "a1", lean_check_id: "chk-1", reason: "faithful" },
        ctx
      )
    );
    expect(out).toEqual({
      success: false,
      code: "HUMAN_CLAIM_PENDING",
      message: "a claim filed earlier is judged first",
      pending_prize_claims: [{ id: "pc-1", status: "in_review", submitted_at: "2026-08-30T12:00:00.000Z" }],
    });
  });

  it("returns the record on success, saying what happened to the bounty", async () => {
    mocks.markProblemSolvedByPlatform.mockResolvedValueOnce({
      ok: true,
      attempt_id: "a1",
      formalization_id: "f1",
      lean_check_id: "c1",
      outcome: "proof",
      bounty: { id: "b1", status: "resolved_internally", previous_status: "house_result_pending" },
      published_at: "2026-09-03T00:00:00.000Z",
    });
    const out = JSON.parse(
      await executeMarkProblemSolvedByPlatform(
        { formalization_id: "f1", attempt_id: "a1", lean_check_id: "c1", reason: "faithful" },
        ctx
      )
    );
    expect(out).toMatchObject({
      success: true,
      attempt_id: "a1",
      outcome: "proof",
      bounty: { id: "b1", status: "resolved_internally" },
      published_at: "2026-09-03T00:00:00.000Z",
    });
    expect(out.message).toMatch(/Bounty b1 moved from house_result_pending to resolved_internally/);
    expect(mocks.markProblemSolvedByPlatform).toHaveBeenCalledWith({
      formalizationId: "f1",
      attemptId: "a1",
      leanCheckId: "c1",
      reason: "faithful",
    });
  });
});
