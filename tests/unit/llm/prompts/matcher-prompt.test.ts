import { describe, it, expect } from "vitest";
import { getMatchingPrompt } from "../../../../src/llm/prompts/matcher.js";
import { getSkill, skillsForDomains } from "../../../../src/llm/prompts/skills.js";

/**
 * The Matcher's user turn names the run's recorded domains and the domain
 * skill blocks they activated, so an untagged claim reads as "no skill by
 * design" rather than as a skill block that failed to arrive (#469).
 */
describe("getMatchingPrompt", () => {
  it("says an untagged run carries no domain skill block", () => {
    const prompt = getMatchingPrompt("x", "y", { domains: [], skills: [] });
    expect(prompt).toContain("Recorded domains for this run: none.");
    expect(prompt).toContain("No domain skill block follows your role on this run");
  });

  it("defaults to the untagged wording when the caller passes nothing", () => {
    expect(getMatchingPrompt("x", "y")).toContain("Recorded domains for this run: none.");
  });

  it("names the domains and the spliced skills when a claim is tagged", () => {
    const skills = skillsForDomains(["mathematics"], "matcher");
    expect(skills.map((s) => s.name)).toEqual(["mathematics"]);
    const prompt = getMatchingPrompt("x", "y", { domains: ["mathematics"], skills });
    expect(prompt).toContain("Recorded domains for this run: mathematics.");
    expect(prompt).toContain(
      `Domain skill blocks spliced after your role: Mathematics (version ${getSkill("mathematics").version}).`
    );
  });
});
