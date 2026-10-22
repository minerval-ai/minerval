import { describe, it, expect } from "vitest";
import { getMatcherSystemPrompt, getMatchingPrompt } from "../../../../src/llm/prompts/matcher.js";
import { getExtractorSystemPrompt } from "../../../../src/llm/prompts/extractor.js";
import { getClaimStewardSystemPrompt } from "../../../../src/llm/prompts/claim-steward.js";

/**
 * The first source to mention a claim does not own its framing (#360). These
 * guard the prompt norms that de-privilege it: the canonical direction is
 * chosen on the proposition's terms rather than inherited from the source in
 * front of the Matcher, the verbatim excerpt is not called "original", and
 * the Steward is told to weigh sources plural rather than "the source
 * document", without presuming a two-party debate.
 */
describe("de-privileged ingestion framing (#360)", () => {
  const matcher = getMatcherSystemPrompt();
  const extractor = getExtractorSystemPrompt();
  const steward = getClaimStewardSystemPrompt();

  it("the Matcher no longer writes the form in the source's direction", () => {
    expect(matcher).not.toMatch(/direction the source\s+asserts/);
    expect(matcher).not.toMatch(/so the new instance's stance is "affirms"/);
    expect(matcher).toContain("## Canonical Direction");
    expect(matcher).toContain("direction_note");
    // The harder judgment is stated, not left undefined.
    expect(matcher).toMatch(/affirmative form of the question/);
    expect(matcher).toMatch(/first instance is "denies"/);
  });

  it("the Matcher's task message does not call the excerpt the original", () => {
    const msg = getMatchingPrompt("some text", "some form");
    expect(msg).not.toMatch(/original/i);
    expect(msg).toContain("verbatim");
  });

  it("original_text is gone from the vocabulary the agents see", () => {
    for (const p of [matcher, extractor, steward]) {
      expect(p).not.toContain("original_text");
    }
    expect(extractor).toContain("verbatim_text");
    expect(steward).toContain("verbatim_text");
  });

  it("the Extractor is told the document is not the claim's home", () => {
    expect(extractor).toMatch(/not the claim's home/);
    expect(extractor).toMatch(/even when this\s+document argues against it/);
  });

  it("the Steward weighs sources plural and does not presume sides", () => {
    expect(steward).toContain("## Provenance Is Evidence, Not an Anchor");
    expect(steward).toContain("canonical_direction_note");
    // The norm names the failure ("the source document") only to forbid it;
    // it must not use the phrase in its own voice elsewhere.
    const inOwnVoice = steward
      .split("\n")
      .filter((l) => /source document/.test(l) && !/"the source document"/.test(l));
    expect(inOwnVoice).toEqual([]);
    expect(steward).not.toMatch(/on both\s+sides/);
    expect(steward).not.toMatch(/between credible\s+sides/);
    // Instances describe the debate; they are not votes on the verdict.
    expect(steward).not.toMatch(/strong signal/);
    expect(steward).toMatch(/They do not tell you whether the claim is true/);
  });
});

/**
 * The Steward thinks, it does not survey. These guard the norms against
 * "Wikipedia-brain": reporting consensus and tallying sources in place of
 * judgment, decomposing one source's argument instead of the
 * question, and reasoning about dated forecasts without knowing the date.
 */
describe("assessment as thinking, not surveying", () => {
  const steward = getClaimStewardSystemPrompt();

  it("no norm reads as a limit on what the Steward may consider", () => {
    expect(steward).not.toMatch(/discourse ends/);
    expect(steward).not.toMatch(/not preemptively/);
    expect(steward).not.toMatch(/demarcate scope/);
    expect(steward).not.toMatch(/carved out of/);
    expect(steward).not.toMatch(/usually settled/);
    expect(steward).toMatch(/it does not limit what you consider/);
    expect(steward).toMatch(/Nothing in this constitution limits what an admin may consider/);
  });

  it("the Steward forms its own view before searching", () => {
    expect(steward).toMatch(/Reason about the question before you search/);
    expect(steward).toMatch(/Do not cite a\s+consensus as a reason/);
  });

  it("decomposition follows the proposition, not one source's argument", () => {
    expect(steward).toMatch(/Decompose the proposition, not any one source's argument/);
    expect(steward).toMatch(/only as sound as the framework it depends on/);
    expect(steward).toMatch(/the\s+decomposition is incomplete/);
  });

  it("credence is the Steward's own judgment", () => {
    expect(steward).toMatch(/not\s+the midpoint of the debate/);
  });
});
