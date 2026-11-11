import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getClaimStewardSystemPromptBlocks } from "../../../src/llm/prompts/claim-steward.js";
import { getConstitution } from "../../../src/llm/prompts/constitution.js";
import { KNOWN_ROLES } from "../../../src/llm/prompts/known-roles.js";
import { listSkills } from "../../../src/llm/prompts/skills.js";
import { withRunDate } from "../../../src/llm/run-date.js";
import {
  buildPromptSet,
  hashPromptSet,
  promptSetLines,
  type PromptSet,
} from "../../../src/services/prompt-set.js";
import { hashText, splitSetup } from "../../../src/services/setup-split.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the prompt set", () => {
  const set = buildPromptSet();

  it("names the constitution, every known role and every skill", () => {
    expect(set.constitution.hash).toBe(hashText(getConstitution()));
    expect(set.roles).toHaveLength(KNOWN_ROLES.length);
    expect(new Set(set.roles.map((r) => r.name))).toEqual(new Set(KNOWN_ROLES.map((r) => r.name)));
    expect(set.skills.map((s) => s.name)).toEqual(listSkills().map((s) => s.name).sort());
    for (const r of set.roles) expect(r.blocks.length).toBeGreaterThan(0);
  });

  it("hashes a role's blocks as a run's role parts are hashed, whatever the run's date", () => {
    const system = withRunDate(getClaimStewardSystemPromptBlocks(), new Date("2026-11-11T00:00:00Z")) as string[];
    const run = splitSetup({ system }).filter((p) => p.kind === "role").map((p) => p.hash);
    const steward = set.roles.find((r) => r.name === "claim-steward")!;
    expect(run).toEqual(steward.blocks);
  });

  it("can be recomputed from the manifest with nothing but sha256", () => {
    const lines = [
      "minerval-prompt-set/1",
      `constitution ${set.constitution.hash}`,
      ...set.roles.map((r) => `role ${r.name} ${r.blocks.join(" ")}`).sort(),
      ...set.skills.map((s) => `skill ${s.name} ${s.version} ${s.hash}`).sort(),
    ];
    expect(promptSetLines(set)).toEqual(lines);
    expect(set.hash).toBe(sha(lines.join("\n")));
  });

  it("is the same on every build, and does not depend on the order of its entries", () => {
    expect(buildPromptSet()).toEqual(set);
    const shuffled: PromptSet = { ...set, roles: [...set.roles].reverse(), skills: [...set.skills].reverse() };
    expect(hashPromptSet(shuffled)).toBe(set.hash);
  });

  it("changes when the constitution, a role block or a skill changes", () => {
    const other = "0".repeat(64);
    expect(hashPromptSet({ ...set, constitution: { ...set.constitution, hash: other } })).not.toBe(set.hash);
    const roles = set.roles.map((r, i) => (i === 0 ? { ...r, blocks: [other, ...r.blocks.slice(1)] } : r));
    expect(hashPromptSet({ ...set, roles })).not.toBe(set.hash);
    if (set.skills.length > 0) {
      const skills = set.skills.map((s, i) => (i === 0 ? { ...s, version: s.version + 1 } : s));
      expect(hashPromptSet({ ...set, skills })).not.toBe(set.hash);
    }
  });

  it("tells the Researcher's two variants apart under one name", () => {
    const researcher = set.roles.filter((r) => r.name === "researcher");
    expect(researcher).toHaveLength(2);
    expect(researcher[0].blocks).not.toEqual(researcher[1].blocks);
  });
});
