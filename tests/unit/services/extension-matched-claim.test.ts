import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What the page assessor learns about a matched node (#680): the
 * reader-facing summary rather than the internal trace, and for a quantity
 * or a question the estimate or standing that is its assessment, instead of
 * a bare "unknown".
 */
const mocks = vi.hoisted(() => ({
  getClaimById: vi.fn(),
  getCurrentAssessment: vi.fn(),
  getQuantityDefinition: vi.fn(),
  getCurrentEstimate: vi.fn(),
  rawQuery: vi.fn(),
}));

vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: mocks.getCurrentAssessment,
}));
vi.mock("../../../src/services/quantity-service.js", () => ({
  getQuantityDefinition: mocks.getQuantityDefinition,
  getCurrentEstimate: mocks.getCurrentEstimate,
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ publicWebBaseUrl: "https://minerval.ai" }),
}));
vi.mock("../../../src/llm/agents/extension-agent.js", () => ({
  assessPageClaims: vi.fn(),
  extensionChat: vi.fn(),
}));

import { loadMatchedClaim } from "../../../src/services/extension-service.js";

const ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.rawQuery.mockImplementation(async (sql: string) =>
    sql.includes("claim_relationships") ? [{ count: "2" }] : []
  );
});

describe("loadMatchedClaim", () => {
  it("gives a claim's reader-facing summary, not the trace", async () => {
    mocks.getClaimById.mockResolvedValue({ id: ID, kind: "claim", text: "X causes Y." });
    mocks.getCurrentAssessment.mockResolvedValue({
      status: "supported",
      confidence: 0.7,
      summary: "The trials favor it, with one unreplicated exception.",
      reasoningTrace: "Step 1: searched. Step 2: read the trials. ".repeat(40),
    });
    const m = await loadMatchedClaim(ID);
    expect(m).toMatchObject({
      kind: "claim",
      status: "supported",
      statusConfidence: 0.7,
      summary: "The trials favor it, with one unreplicated exception.",
      estimate: null,
      standing: null,
      subclaimCount: 2,
    });
  });

  it("falls back to the trace's opening for a record with no summary", async () => {
    mocks.getClaimById.mockResolvedValue({ id: ID, kind: "claim", text: "X." });
    mocks.getCurrentAssessment.mockResolvedValue({
      status: "doubtful",
      confidence: 0.6,
      summary: null,
      reasoningTrace: "a".repeat(2000),
    });
    const m = await loadMatchedClaim(ID);
    expect(m?.summary).toBe("a".repeat(600));
  });

  it("gives a quantity its definition and estimate rather than 'unknown' alone", async () => {
    mocks.getClaimById.mockResolvedValue({ id: ID, kind: "quantity", text: "US adult obesity rate, 2022." });
    mocks.getCurrentAssessment.mockResolvedValue(null);
    const definition = {
      measures: "share of US adults with BMI of 30 or more",
      population: "US adults",
      conditions: null,
      unit: { kind: "percent" },
    };
    const estimate = { form: "interval", low: 40, high: 43, central: 41.9 };
    mocks.getQuantityDefinition.mockResolvedValue(definition);
    mocks.getCurrentEstimate.mockResolvedValue({
      estimate,
      assessed: { summary: "NHANES puts it near 42%.", work: "long work", model: null, assessed_at: new Date() },
    });
    const m = await loadMatchedClaim(ID);
    expect(m).toMatchObject({
      kind: "quantity",
      status: "unknown",
      definition,
      estimate,
      summary: "NHANES puts it near 42%.",
      standing: null,
    });
  });

  it("gives a question its standing and summary", async () => {
    mocks.getClaimById.mockResolvedValue({ id: ID, kind: "question", text: "What caused X?" });
    mocks.getCurrentAssessment.mockResolvedValue(null);
    mocks.rawQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("claim_relationships")) return [{ count: "0" }];
      if (sql.includes("question_assessments")) {
        return [{ standing: "leaning", summary: "Most evidence favors A over B.", reasoning_trace: "trace" }];
      }
      return [];
    });
    const m = await loadMatchedClaim(ID);
    expect(m).toMatchObject({
      kind: "question",
      standing: "leaning",
      summary: "Most evidence favors A over B.",
      estimate: null,
    });
    expect(mocks.getCurrentEstimate).not.toHaveBeenCalled();
  });

  it("returns null for a claim that does not exist", async () => {
    mocks.getClaimById.mockResolvedValue(null);
    mocks.getCurrentAssessment.mockResolvedValue(null);
    expect(await loadMatchedClaim(ID)).toBeNull();
  });
});
