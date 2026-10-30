import { describe, it, expect } from "vitest";
import { getMatchingPrompt } from "../../../../src/llm/prompts/matcher.js";
import { skillsPointedTo } from "../../../../src/llm/prompts/skills.js";

/**
 * The Matcher's user turn names the run's recorded domains and the domain
 * skills they point to, so the Matcher knows which skill covers the claim's
 * subject before it decides whether to load one (#469).
 */
describe("getMatchingPrompt", () => {
  it("says no domain skill covers an untagged run", () => {
    const prompt = getMatchingPrompt("x", "y", { domains: [], skills: [] });
    expect(prompt).toContain("Recorded domains for this run: none.");
    expect(prompt).toContain("No domain skill covers this claim's recorded domains");
  });

  it("defaults to the untagged wording when the caller passes nothing", () => {
    expect(getMatchingPrompt("x", "y")).toContain("Recorded domains for this run: none.");
  });

  it("names the domains and points to the skill when a claim is tagged", () => {
    const skills = skillsPointedTo(["mathematics"], "matcher");
    expect(skills.map((s) => s.name)).toEqual(["mathematics"]);
    const prompt = getMatchingPrompt("x", "y", { domains: ["mathematics"], skills });
    expect(prompt).toContain("Recorded domains for this run: mathematics.");
    expect(prompt).toContain(
      "These domains point to the Mathematics skill (mathematics); load it with load_skill"
    );
  });
});
