import { describe, it, expect } from "vitest";

import { formatAssessment } from "../../../src/routes/claims.js";

describe("formatAssessment", () => {
  const base = {
    id: "11111111-1111-1111-1111-111111111111",
    status: "supported",
    confidence: 0.8,
    claimCredence: 0.9,
    summary: "The evidence favours this claim.",
    reasoningTrace: "because",
    subclaimSummary: { a: 1 } as unknown,
    assessedAt: new Date("2026-01-01T00:00:00.000Z"),
    model: "claude-fable-5",
  };

  it("serializes a fully-populated assessment with snake_case fields", () => {
    expect(formatAssessment(base)).toEqual({
      id: base.id,
      status: "supported",
      confidence: 0.8,
      claim_credence: 0.9,
      summary: "The evidence favours this claim.",
      reasoning_trace: "because",
      subclaim_summary: { a: 1 },
      assessed_at: "2026-01-01T00:00:00.000Z",
      model: "claude-fable-5",
    });
  });

  it("keeps the model null for legacy rows that predate the column (#294)", () => {
    expect(formatAssessment({ ...base, model: null }).model).toBeNull();
    const { model: _model, ...withoutModel } = base;
    expect(formatAssessment(withoutModel).model).toBeNull();
  });

  it("keeps an unstated credence null — distinct from credence 0 (constitution §7)", () => {
    expect(formatAssessment({ ...base, claimCredence: null }).claim_credence).toBeNull();
  });

  it("falls back to the reasoning trace when summary is null (pre-split rows)", () => {
    expect(formatAssessment({ ...base, summary: null }).summary).toBe("because");
  });

  it("never emits a null subclaim_summary (issue #17)", () => {
    const result = formatAssessment({ ...base, subclaimSummary: null });
    expect(result.subclaim_summary).toEqual({});
    // clients rely on this being safe to Object.entries()
    expect(() => Object.entries(result.subclaim_summary as object)).not.toThrow();
  });
});
