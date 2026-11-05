import { describe, it, expect, vi, beforeEach } from "vitest";

// remove_answer (#741): the answer set is the question's Steward's to keep,
// and the reasoning it requires is written to the audit log (§5).

const Q = "11111111-1111-1111-1111-111111111111";
const OTHER_Q = "22222222-2222-2222-2222-222222222222";
const A = "33333333-3333-3333-3333-333333333333";

const { calls } = vi.hoisted(() => ({ calls: [] as { sql: string; params: unknown[] }[] }));

vi.mock("../../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  withTransaction: vi.fn(),
  rawQuery: vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("DELETE FROM claim_relationships")) {
      return [{ id: "edge", answer_basis: "quality", reasoning: "a serious answer" }];
    }
    return [];
  }),
}));

import { executeKindTool } from "../../../../src/llm/tools/kind-tools.js";

const ctx = { role: "question_steward" as const, claimId: Q };

describe("remove_answer", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("removes the answer and logs the reasoning", async () => {
    const out = JSON.parse(
      (await executeKindTool("remove_answer", { question_id: Q, answer_id: A, reasoning: "nobody holds it" }, ctx))!
    );
    expect(out.success).toBe(true);
    const audit = calls.find((c) => c.sql.includes("INSERT INTO audit_log"));
    expect(audit).toBeDefined();
    expect(audit!.params[0]).toBe(Q);
    expect(String(audit!.params[1])).toContain("nobody holds it");
  });

  it("refuses a question that is not the run's own", async () => {
    const out = JSON.parse(
      (await executeKindTool("remove_answer", { question_id: OTHER_Q, answer_id: A, reasoning: "x" }, ctx))!
    );
    expect(out.success).toBe(false);
    expect(calls.some((c) => c.sql.includes("DELETE"))).toBe(false);
  });

  it("refuses without reasoning", async () => {
    const out = JSON.parse((await executeKindTool("remove_answer", { question_id: Q, answer_id: A }, ctx))!);
    expect(out.success).toBe(false);
  });
});
