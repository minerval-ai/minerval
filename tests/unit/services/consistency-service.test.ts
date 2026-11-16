import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The parts of the consistency mechanism that need no database: the flag's
 * trigger context the Steward reads, and the checks a flag passes before
 * anything is written. The database paths are covered in
 * tests/db/consistency.test.ts.
 */

const PRIMARY = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const { state } = vi.hoisted(() => ({
  state: { rows: [] as Array<Record<string, unknown>>, sql: [] as string[] },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    state.sql.push(sql);
    return state.rows;
  }),
}));
vi.mock("../../../src/services/action-service.js", () => ({
  ensureAssessActions: vi.fn(),
  ASSESS_GROUP: (id: string) => `assess:${id}`,
}));
vi.mock("../../../src/services/queue-service.js", () => ({ enqueueSteward: vi.fn() }));
vi.mock("../../../src/services/priority-service.js", () => ({ refreshQueuePriority: vi.fn() }));

import {
  checkFlagInput,
  consistencyFlagContext,
  CONSISTENCY_BOUNDS,
  CONSISTENCY_FLAG_KINDS,
} from "../../../src/services/consistency-service.js";

beforeEach(() => {
  state.rows = [];
  state.sql = [];
});

describe("consistencyFlagContext", () => {
  it("carries a consideration from elsewhere with what each cited node establishes (#778)", () => {
    const ctx = consistencyFlagContext({
      kind: "unweighed_consideration",
      rationale: "The cited trial is decisive against the mechanism this verdict assumes.",
      primary: { id: PRIMARY, kind: "claim", status: "supported", claim_credence: 0.8 },
      others: [{
        id: OTHER, text: "The trial found no effect", kind: "claim",
        status: "verified", claim_credence: 0.95, summary: "A preregistered trial of 40,000.",
      }],
    });
    expect(ctx).toContain("Its summary: A preregistered trial of 40,000.");
    expect(ctx).toContain("decided at this node");
    // The flag is a reading for the Steward to weigh, not a limit on what
    // the checker may consider (§1).
    expect(ctx).not.toContain("never truth");
    expect(ctx).toContain("a flag, not a verdict");
  });

  it("names a quantity's estimate and a question's standing, not an assessment (#735)", () => {
    const q = consistencyFlagContext({
      kind: "numeric_mismatch",
      rationale: "The estimate disagrees with the quantities it is defined from.",
      primary: { id: PRIMARY, kind: "quantity", status: null, claim_credence: null, has_record: true },
      others: [{ id: OTHER, text: "Q2", kind: "question", status: "answered", claim_credence: null }],
    });
    expect(q).toContain("this quantity's estimate (a quantity, estimated)");
    expect(q).toContain("(a question, answered)");
  });

  it("words a one-node flag as the verdict not following from its own reasoning (#997)", () => {
    const ctx = consistencyFlagContext({
      kind: "dependency_mismatch",
      rationale: "The summary says the second component is unsupported, yet the conjunction stands supported.",
      primary: { id: PRIMARY, kind: "claim", status: "supported", claim_credence: 0.8 },
      others: [],
    });
    expect(ctx).toContain("does not follow from its own reasoning and evidence (dependency_mismatch)");
    expect(ctx).not.toContain("about these claims");
    expect(ctx).toContain("The checker's reading: The summary says the second component");
    expect(ctx).toContain("a flag, not a verdict");
  });
});

describe("checkFlagInput", () => {
  it("has a kind for a consideration established elsewhere (#778)", () => {
    expect(CONSISTENCY_FLAG_KINDS).toContain("unweighed_consideration");
  });

  it("refuses an over-long rationale with the limit, rather than cutting it (#753)", async () => {
    const res = await checkFlagInput({
      kind: "other",
      primaryClaimId: PRIMARY,
      claimIds: [OTHER],
      rationale: "r".repeat(CONSISTENCY_BOUNDS.rationaleChars + 1),
    });
    expect(res).toMatchObject({ ok: false, code: "RATIONALE_LENGTH" });
    expect((res as { problem: string }).problem).toContain(String(CONSISTENCY_BOUNDS.rationaleChars));
    expect(state.sql).toHaveLength(0);
  });

  it("accepts a quantity as the primary when it has an estimate (#735)", async () => {
    state.rows = [
      { id: PRIMARY, text: "Q", kind: "quantity", state: "active", status: null, claim_credence: null, assessment_id: "est-1", summary: null },
      { id: OTHER, text: "C", kind: "claim", state: "active", status: "supported", claim_credence: 0.7, assessment_id: "a-1", summary: "s" },
    ];
    const res = await checkFlagInput({
      kind: "numeric_mismatch",
      primaryClaimId: PRIMARY,
      claimIds: [OTHER],
      rationale: "The quantity's estimate does not agree with the claim's verdict on it.",
    });
    expect(res).toMatchObject({ ok: true, primary: { assessment_id: "est-1", kind: "quantity" } });
    // The read joins the estimate and standing tables, not assessments alone.
    expect(state.sql[0]).toContain("quantity_estimates");
    expect(state.sql[0]).toContain("question_assessments");
  });

  it("lets a dependency_mismatch name the primary alone (#997)", async () => {
    state.rows = [
      { id: PRIMARY, text: "A and B", kind: "claim", state: "active", status: "supported", claim_credence: 0.8, assessment_id: "a-1", summary: "s" },
    ];
    const res = await checkFlagInput({
      kind: "dependency_mismatch",
      primaryClaimId: PRIMARY,
      claimIds: [],
      rationale: "The summary admits B is unsupported, yet the conjunction stands supported.",
    });
    expect(res).toMatchObject({ ok: true, claimIds: [PRIMARY], others: [] });
  });

  it("still wants a second node for every other kind (#997)", async () => {
    for (const kind of CONSISTENCY_FLAG_KINDS.filter((k) => k !== "dependency_mismatch")) {
      const res = await checkFlagInput({
        kind,
        primaryClaimId: PRIMARY,
        claimIds: [PRIMARY],
        rationale: "A tension that names no node beside the primary.",
      });
      expect(res).toMatchObject({ ok: false, code: "CLAIMS" });
      expect((res as { problem: string }).problem).toContain("dependency_mismatch");
    }
    expect(state.sql).toHaveLength(0);
  });

  it("says what a question lacks when it has no standing yet", async () => {
    state.rows = [
      { id: PRIMARY, text: "Q?", kind: "question", state: "active", status: null, claim_credence: null, assessment_id: null, summary: null },
      { id: OTHER, text: "C", kind: "claim", state: "active", status: "supported", claim_credence: 0.7, assessment_id: "a-1", summary: null },
    ];
    const res = await checkFlagInput({
      kind: "answer_mismatch",
      primaryClaimId: PRIMARY,
      claimIds: [OTHER],
      rationale: "The question's standing disagrees with its answers' assessments.",
    });
    expect(res).toMatchObject({ ok: false, code: "UNASSESSED" });
    expect((res as { problem: string }).problem).toContain("no standing yet");
  });
});
