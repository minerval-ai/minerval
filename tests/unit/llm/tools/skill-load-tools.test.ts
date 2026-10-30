import { describe, it, expect } from "vitest";
import { createSkillLoadTools } from "../../../../src/llm/tools/skill-load-tools.js";
import { getUsageContext, runWithUsageContext, withSkills } from "../../../../src/llm/usage-context.js";
import { getSkill, getSkillView } from "../../../../src/llm/prompts/skills.js";

/**
 * load_skill: skills are read on demand, as the Agent Skills format intends,
 * and every load is recorded with the run.
 */
describe("createSkillLoadTools", () => {
  it("offers load_skill with the skills the role can load, and nothing for a role with none", () => {
    const steward = createSkillLoadTools("claim-steward");
    expect(steward.definitions.map((t) => t.name)).toEqual(["load_skill"]);
    const schema = steward.definitions[0]!.input_schema as {
      properties: { name: { enum: string[] } };
    };
    expect(schema.properties.name.enum).toEqual(["mathematics", "provenance"]);
    // The Matcher can load Mathematics (it has a Matcher section), not Provenance.
    const matcher = createSkillLoadTools("matcher");
    expect(
      (matcher.definitions[0]!.input_schema as { properties: { name: { enum: string[] } } })
        .properties.name.enum
    ).toEqual(["mathematics"]);
  });

  it("returns the role's view and records the load once, sorted, on the run's list", async () => {
    const loader = createSkillLoadTools("claim-steward");
    const recorded = await withSkills([], async () => {
      const view = await loader.execute("load_skill", { name: "provenance" });
      expect(view).toBe(getSkillView(getSkill("provenance"), "claim-steward"));
      await loader.execute("load_skill", { name: "mathematics" });
      await loader.execute("load_skill", { name: "provenance" });
      return [...(getUsageContext().skills ?? [])];
    });
    expect(recorded).toEqual(["mathematics", "provenance"]);
  });

  it("answers null for other tools, and an error naming the loadable skills for an unknown one", async () => {
    const loader = createSkillLoadTools("matcher");
    expect(await loader.execute("search_similar_claims", {})).toBeNull();
    const out = JSON.parse((await loader.execute("load_skill", { name: "provenance" }))!);
    expect(out.success).toBe(false);
    expect(out.message).toContain("Skills you can load: mathematics.");
  });

  it("records nothing outside a run that opened a skills list", async () => {
    const loader = createSkillLoadTools("claim-steward");
    await runWithUsageContext({}, async () => {
      await loader.execute("load_skill", { name: "provenance" });
      expect(getUsageContext().skills).toBeUndefined();
    });
  });

  it("points to skills by domain or by name, never loading them", () => {
    expect(createSkillLoadTools("claim-steward", { domains: ["mathematics"] }).pointed.map((s) => s.name)).toEqual([
      "mathematics",
    ]);
    // A mandate names its skills; a method skill can be named.
    const named = createSkillLoadTools("grantmaker", { names: ["provenance", "alchemy"] });
    expect(named.pointed.map((s) => s.name)).toEqual(["provenance"]);
    expect(named.pointerNote).toContain("Skills that cover this run's subject: the Provenance skill (provenance).");
    expect(createSkillLoadTools("claim-steward", { domains: [] }).pointerNote).toBe("");
  });
});
