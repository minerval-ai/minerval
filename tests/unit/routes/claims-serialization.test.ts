import { describe, it, expect } from "vitest";
import fastJson from "fast-json-stringify";
import { assessmentSchema, claimSchema } from "../../../src/routes/claims.js";

/**
 * Regression test for issue #16: the claim detail endpoint returned
 * `"assessment": {}` (and `"tree": {}`) even though the assessment row was
 * retrieved. fast-json-stringify strips every key from a schema declared
 * `{ type: "object" }` with no `properties`/`additionalProperties`, so the
 * frontend rendered assessed claims as "not yet assessed."
 */
describe("claim detail response serialization", () => {
  const sampleAssessment = {
    id: "ecd9425f-8cf0-4057-9b9d-39371ee2ce77",
    status: "supported",
    confidence: 0.72,
    summary: "The evidence favours this claim; no credible challenge has surfaced.",
    reasoning_trace: "The claim is well supported by sources.",
    subclaim_summary: { supported: 2, inconclusive: 0 },
    assessed_at: "2026-06-21T04:18:43.337Z",
  };

  it("demonstrates the bug: a bare object schema strips all fields", () => {
    const stringify = fastJson({ type: "object", nullable: true } as never);
    const out = JSON.parse(stringify(sampleAssessment));
    // This is what the endpoint used to return.
    expect(out).toEqual({});
  });

  it("preserves assessment fields under the fixed schema", () => {
    const stringify = fastJson(assessmentSchema as never);
    const out = JSON.parse(stringify(sampleAssessment));

    expect(out.status).toBe("supported");
    expect(out.confidence).toBe(0.72);
    expect(out.id).toBe(sampleAssessment.id);
    expect(out.summary).toBe(sampleAssessment.summary);
    expect(out.reasoning_trace).toBe(sampleAssessment.reasoning_trace);
    expect(out.assessed_at).toBe(sampleAssessment.assessed_at);
    // subclaim_summary is an arbitrary object and must pass through intact.
    expect(out.subclaim_summary).toEqual({ supported: 2, inconclusive: 0 });
  });

  it("preserves importance and steward_state on the claim (same stripping class as #16)", () => {
    const stringify = fastJson(claimSchema as never);
    const out = JSON.parse(
      stringify({
        id: "ecd9425f-8cf0-4057-9b9d-39371ee2ce77",
        text: "a claim",
        claim_type: "empirical_derived",
        state: "active",
        decomposition_status: "pending",
        importance: 0.82,
        steward_state: "pending",
        created_by: "extractor",
        created_at: "2026-06-21T04:18:43.337Z",
        updated_at: "2026-06-21T04:18:43.337Z",
      }),
    );
    // The frontend keys an "unassessed / may still decompose" caption off these;
    // if fast-json-stringify drops them (issue #16's failure mode) the UI
    // silently regresses to claiming the unprocessed claim is "atomic".
    expect(out.importance).toBe(0.82);
    expect(out.steward_state).toBe("pending");
  });

  // #524: dispute is shown beside the verdict, read from contestation, so the
  // claim schema must carry it through the serializer, null included.
  it("preserves contestation on the claim, null when unjudged", () => {
    const stringify = fastJson(claimSchema as never);
    const base = {
      id: "ecd9425f-8cf0-4057-9b9d-39371ee2ce77",
      text: "a claim",
      claim_type: "empirical_derived",
      state: "active",
      decomposition_status: "complete",
      importance: 0.6,
      steward_state: "done",
      created_by: "extractor",
      created_at: "2026-06-21T04:18:43.337Z",
      updated_at: "2026-06-21T04:18:43.337Z",
    };
    expect(JSON.parse(stringify({ ...base, contestation: 0.75 })).contestation).toBe(0.75);
    expect(JSON.parse(stringify({ ...base, contestation: null })).contestation).toBeNull();
  });

  it("serializes a null assessment as null", () => {
    const stringify = fastJson(assessmentSchema as never);
    expect(stringify(null)).toBe("null");
  });

  it("preserves a nested tree under an additionalProperties schema", () => {
    const treeSchema = {
      type: "object",
      nullable: true,
      additionalProperties: true,
    } as never;
    const tree = {
      id: "root",
      text: "root claim",
      assessment_status: "supported",
      children: [
        { id: "child", text: "subclaim", assessment_status: "inconclusive", children: [] },
      ],
    };
    const stringify = fastJson(treeSchema);
    const out = JSON.parse(stringify(tree));

    expect(out.assessment_status).toBe("supported");
    expect(out.children).toHaveLength(1);
    expect(out.children[0].assessment_status).toBe("inconclusive");
  });
});
