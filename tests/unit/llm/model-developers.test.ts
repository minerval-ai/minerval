import { describe, expect, it } from "vitest";
import { developerDisclosure, modelDeveloper } from "../../../src/llm/model-developers.js";
import { MODELS, OPENROUTER_MODELS } from "../../../src/llm/models.js";

describe("modelDeveloper", () => {
  it("names the developer of every model this codebase pins", () => {
    for (const id of Object.values(MODELS)) {
      expect(modelDeveloper(id)?.name).toBe("Anthropic");
    }
    expect(modelDeveloper(OPENROUTER_MODELS.flash)?.name).toBe("OpenAI");
  });

  it("resolves direct, Bedrock-style and vendor/model ids", () => {
    expect(modelDeveloper("us.anthropic.claude-opus-5-5")?.key).toBe("anthropic");
    expect(modelDeveloper("gpt-5-nano")?.key).toBe("openai");
    expect(modelDeveloper("o3")?.key).toBe("openai");
    expect(modelDeveloper("z-ai/glm-5.3-flash")?.key).toBe("zhipu");
    expect(modelDeveloper("deepseek/deepseek-v4-flash")?.key).toBe("deepseek");
    expect(modelDeveloper("qwen/qwen3-235b-a22b")?.key).toBe("alibaba");
    expect(modelDeveloper("google/gemini-3-pro")?.key).toBe("google");
  });

  it("reads a model served from the deployment's own endpoint as the model the endpoint knows", () => {
    expect(modelDeveloper("endpoint:local/meta-llama/Llama-3.3-70B-Instruct")?.key).toBe("meta");
    expect(modelDeveloper("endpoint:gpu_2/qwen/qwen3-235b-a22b")?.key).toBe("alibaba");
    // A name with no vendor in it says nothing about who built the model.
    expect(modelDeveloper("endpoint:local/llama3.3:70b")).toBeNull();
  });

  it("returns null for missing or unknown ids", () => {
    expect(modelDeveloper(null)).toBeNull();
    expect(modelDeveloper("")).toBeNull();
    expect(modelDeveloper("somevendor/model-x")).toBeNull();
    expect(modelDeveloper("mystery-model")).toBeNull();
  });
});

describe("developerDisclosure", () => {
  const opus = MODELS.strong;

  it("discloses when the claim names the assessor's developer", () => {
    expect(
      developerDisclosure(opus, "Anthropic's Responsible Scaling Policy is adhered to in practice.")
    ).toEqual({ developer: "Anthropic", model: opus, matched: ["Anthropic"] });
    expect(
      developerDisclosure(opus, "Claude Opus 5.5 sandbags on dangerous-capability evaluations.")
        ?.matched
    ).toEqual(["Claude"]);
    expect(developerDisclosure(opus, "Claude is more sycophantic than its peers.")).not.toBeNull();
  });

  it("reads the claim's tags as well as its words", () => {
    expect(
      developerDisclosure(opus, "The lab's RSP thresholds were met before release.", ["Anthropic"])
        ?.matched
    ).toEqual(["Anthropic"]);
  });

  it("is silent when the claim names a different developer", () => {
    expect(developerDisclosure(opus, "OpenAI's preparedness framework was followed.")).toBeNull();
    expect(
      developerDisclosure(OPENROUTER_MODELS.flash, "OpenAI's preparedness framework was followed.")
        ?.developer
    ).toBe("OpenAI");
  });

  it("does not take a person named Claude for the model", () => {
    expect(developerDisclosure(opus, "Claude Shannon founded information theory.")).toBeNull();
    expect(developerDisclosure(opus, "Claude Monet painted water lilies.")).toBeNull();
  });

  it("discloses nothing without a known model", () => {
    expect(developerDisclosure(null, "Anthropic is a public benefit corporation.")).toBeNull();
    expect(developerDisclosure("mystery-model", "Anthropic is a PBC.")).toBeNull();
  });
});
