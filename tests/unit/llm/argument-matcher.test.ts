import { describe, it, expect, vi, beforeEach } from "vitest";

// Placing an argument passage at ingestion (#541): no call when the claim has
// no arguments, an id outside the candidates is no match, and a failed call
// leaves the passage unplaced rather than losing it.

const completeStructured = vi.hoisted(() => vi.fn());
vi.mock("../../../src/llm/client.js", () => ({ completeStructured }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => ({ matcherModel: "test-model" }) }));
vi.mock("../../../src/llm/prompts/matcher.js", () => ({
  getMatcherSystemPromptBlocks: () => ["system"],
  getArgumentMatchingPrompt: () => "prompt",
}));

import { defaultPlacement, matchArgumentPassage } from "../../../src/llm/agents/argument-matcher.js";

const ARG = "44444444-4444-4444-4444-444444444444";
const candidate = { id: ARG, name: "from the early cases", stance: "for", shows: null, written_form: "Because...", retired: false };
const base = {
  claim: { text: "The outbreak began at the market.", kind: "claim" },
  sourceStance: "denies",
  passage: { verbatim_text: "The earliest cases had no link to the market.", context: null, role: "makes" as const },
};

beforeEach(() => completeStructured.mockReset());

describe("argument placement", () => {
  it("leaves a passage unplaced without a call when the claim has no arguments", async () => {
    const out = await matchArgumentPassage({ ...base, candidates: [] });
    expect(completeStructured).not.toHaveBeenCalled();
    expect(out).toEqual({ argument_id: null, stance: "advances", reading: null, direction: "against", matched_by_model: false });
  });

  it("takes no side for an attacking passage or a quantity", () => {
    expect(defaultPlacement({ claimKind: "claim", sourceStance: "affirms", role: "attacks" })).toMatchObject({
      stance: "criticizes",
      direction: null,
    });
    expect(defaultPlacement({ claimKind: "quantity", sourceStance: "states", role: "makes" }).direction).toBeNull();
  });

  it("places a passage on the argument the model names", async () => {
    completeStructured.mockResolvedValue({
      argument_id: ARG,
      stance: "advances",
      reading: "premise_unstated",
      direction: "for",
      reasoning: "Same inference.",
    });
    const out = await matchArgumentPassage({ ...base, candidates: [candidate] });
    expect(out).toEqual({ argument_id: ARG, stance: "advances", reading: "premise_unstated", direction: null, matched_by_model: true });
  });

  it("treats an id outside the candidates as no match", async () => {
    completeStructured.mockResolvedValue({
      argument_id: "99999999-9999-9999-9999-999999999999",
      stance: "advances",
      reading: "full",
      direction: "against",
      reasoning: "x",
    });
    const out = await matchArgumentPassage({ ...base, candidates: [candidate] });
    expect(out.argument_id).toBeNull();
    expect(out.direction).toBe("against");
  });

  it("leaves the passage unplaced when the call fails", async () => {
    completeStructured.mockRejectedValueOnce(new Error("overloaded"));
    const out = await matchArgumentPassage({ ...base, candidates: [candidate] });
    expect(out).toMatchObject({ argument_id: null, matched_by_model: false, direction: "against" });
  });
});
