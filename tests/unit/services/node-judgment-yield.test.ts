import { describe, it, expect, vi } from "vitest";

// Quantities and questions record marginal_yield (and a question its
// confidence), and the allocation SQL reads yield and recency from the
// table each kind keeps its judgment in (#755).

vi.mock("../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  withTransaction: vi.fn(),
  rawQuery: vi.fn(async () => []),
}));

vi.mock("../../../src/services/question-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/question-service.js")>()),
  recordQuestionAssessment: vi.fn(async () => ({ id: "qa" })),
}));

import { nodeAssessedAtSql, nodeMarginalYieldSql } from "../../../src/services/node-judgment-sql.js";
import { executeKindTool, getQuantityToolDefinitions, getQuestionToolDefinitions } from "../../../src/llm/tools/kind-tools.js";
import { recordQuestionAssessment } from "../../../src/services/question-service.js";

const Q = "11111111-1111-1111-1111-111111111111";

describe("node judgment SQL", () => {
  it("reads each kind's own table", () => {
    for (const sql of [nodeMarginalYieldSql("c"), nodeAssessedAtSql("c")]) {
      expect(sql).toMatch(/WHEN 'quantity' THEN \(SELECT j\.\w+ FROM quantity_estimates_in_force j/);
      expect(sql).toMatch(/WHEN 'question' THEN \(SELECT j\.\w+ FROM question_assessments_in_force j/);
      expect(sql).toMatch(/ELSE \(SELECT j\.\w+ FROM assessments_in_force j/);
      expect(sql).toContain("WHERE j.claim_id = c.id");
    }
    expect(nodeMarginalYieldSql("c")).toContain("j.marginal_yield");
    expect(nodeAssessedAtSql("c")).toContain("j.assessed_at");
  });
});

describe("judgment tools for quantities and questions", () => {
  it("offer marginal_yield, and confidence for a question", () => {
    const props = (name: string, tools: { name: string; input_schema: unknown }[]) =>
      Object.keys((tools.find((t) => t.name === name)!.input_schema as { properties: object }).properties);
    expect(props("update_quantity_estimate", getQuantityToolDefinitions())).toContain("marginal_yield");
    const question = props("update_question_assessment", getQuestionToolDefinitions());
    expect(question).toContain("marginal_yield");
    expect(question).toContain("confidence");
  });

  it("record a question's confidence and yield, clamped", async () => {
    const out = JSON.parse(
      (await executeKindTool(
        "update_question_assessment",
        {
          claim_id: Q,
          standing: "open",
          assessment: "Level between the leading answers.",
          reasoning_trace: "Examined both.",
          confidence: 0.7,
          marginal_yield: -0.2,
        },
        { role: "question_steward", claimId: Q }
      ))!
    );
    expect(out.success).toBe(true);
    expect(recordQuestionAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: Q, confidence: 0.7, marginalYield: 0 })
    );
  });
});
