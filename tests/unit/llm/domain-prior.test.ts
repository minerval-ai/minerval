import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The domain prior runs on a short prompt of its own (#682): what each
 * domain covers, from the domain skills, without the constitution or the
 * Extractor's recording-tool instructions.
 */
const mocks = vi.hoisted(() => ({ completeStructured: vi.fn() }));

vi.mock("../../../src/llm/client.js", () => ({
  completeStructured: mocks.completeStructured,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ matcherModel: "matcher-model" }),
}));

import { inferDomainPrior } from "../../../src/llm/agents/domain-prior.js";
import { getDomainPriorSystemPrompt } from "../../../src/llm/prompts/domain-prior.js";
import { listSkills } from "../../../src/llm/prompts/skills.js";

beforeEach(() => {
  mocks.completeStructured.mockReset().mockResolvedValue({ domains: ["mathematics"] });
});

describe("getDomainPriorSystemPrompt", () => {
  const prompt = getDomainPriorSystemPrompt(listSkills());

  it("describes each domain skill from its description and its Extractor section", () => {
    const math = listSkills().find((s) => s.name === "mathematics")!;
    expect(prompt).toContain("### mathematics (Mathematics)");
    expect(prompt).toContain("Does not apply to claims that merely use a number or a model.");
    const extractorSection = math.sections.find((s) => s.heading === "For the Extractor")!;
    expect(prompt).toContain(extractorSection.body.trim());
  });

  it("leaves out method skills, the constitution and the Extractor's tools", () => {
    expect(prompt).not.toMatch(/provenance \(/i);
    expect(prompt).not.toContain("record_claims");
    expect(prompt).not.toContain("finish_extraction");
    expect(prompt.length).toBeLessThan(5000);
  });

  it("asks for the subject, not the merit", () => {
    expect(prompt).toMatch(/judge its subject, not its merit/);
  });
});

describe("inferDomainPrior", () => {
  it("sends the short prompt and returns the sanitized tags", async () => {
    const tags = await inferDomainPrior({ text: "Every even number above 2 is a sum of two primes." });
    expect(tags).toEqual(["mathematics"]);
    const call = mocks.completeStructured.mock.calls[0]![0] as { system: string; model: string };
    expect(call.system).toBe(getDomainPriorSystemPrompt(listSkills()));
    expect(call.model).toBe("matcher-model");
  });

  it("degrades to no tags on error", async () => {
    mocks.completeStructured.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await inferDomainPrior({ text: "x" })).toEqual([]);
    warn.mockRestore();
  });
});
