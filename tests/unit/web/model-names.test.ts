import { describe, it, expect } from "vitest";

// The web-side display-name mapping for assessing models (#294). Mirrors the
// id inventory in src/llm/models.ts; pure string → string, tests without a DOM.
import { modelDisplayName } from "../../../web/lib/model-names";

describe("modelDisplayName", () => {
  it("maps the known production model ids to their display names", () => {
    expect(modelDisplayName("claude-fable-5-1")).toBe("Claude Fable 5.1");
    // The retired default stays mapped: assessments written under Fable 5
    // must keep naming the model that actually judged them.
    expect(modelDisplayName("claude-fable-5")).toBe("Claude Fable 5");
    expect(modelDisplayName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
  });

  it("prettifies an unmapped claude-family id instead of dropping it", () => {
    expect(modelDisplayName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelDisplayName("claude-mythos-6")).toBe("Claude Mythos 6");
    // Dated snapshot of an unmapped family/version still prettifies.
    expect(modelDisplayName("claude-haiku-4-5-20990101")).toBe("Claude Haiku 4.5");
  });

  it("falls back to the raw id for anything unrecognizable — never nothing", () => {
    expect(modelDisplayName("gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(modelDisplayName("us.anthropic.claude-sonnet-5")).toBe(
      "us.anthropic.claude-sonnet-5"
    );
  });
});
