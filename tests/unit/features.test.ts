/**
 * Features (src/features.ts): the optional parts of the product a
 * deployment switches off one by one with FEATURES_OFF. The list and its
 * one dependency, the config key, and the agents' tools that belong to a
 * feature (src/llm/tools/feature-tools.ts).
 *
 * What a feature being off does to the routes and the MCP tool list is in
 * tests/unit/mcp/parity.test.ts, which builds the app both ways.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FEATURES,
  FEATURE_NAMES,
  featureOn,
  featureOnGiven,
  listFeatures,
  parseFeaturesOff,
} from "../../src/features.js";
import { TOOL_FEATURES, toolFeature, withoutOffFeatureTools } from "../../src/llm/tools/feature-tools.js";
import {
  builtinToolNames,
  declaredSkillToolNames,
  getActiveSkillToolDefinitions,
} from "../../src/llm/tools/skill-tools.js";
import { listSkills, type SkillRole } from "../../src/llm/prompts/skills.js";
import { getAuditToolDefinitions } from "../../src/llm/tools/audit-tools.js";
import { getReviewerToolDefinitions } from "../../src/llm/tools/reviewer-tools.js";
import {
  getBountyToolDefinitions,
  getConfirmBountyToolDefinition,
} from "../../src/llm/agents/grantmaker.js";

describe("the feature list", () => {
  it("is the extension, mathematics and prizes", () => {
    expect([...FEATURE_NAMES]).toEqual(["extension", "mathematics", "prizes"]);
  });

  it("describes each feature in one sentence that says what switching it off removes", () => {
    for (const feature of FEATURES) {
      expect(feature.description.length, feature.name).toBeGreaterThan(60);
      expect(feature.description, feature.name).toMatch(/switching it off removes/);
      // One sentence: the only full stop is the last character.
      expect(feature.description.indexOf(". "), feature.name).toBe(-1);
      expect(feature.description.endsWith("."), feature.name).toBe(true);
      // No named bundles anywhere near a feature.
      expect(feature.description).not.toMatch(/profile|bundle|evaluator|enterprise/i);
    }
  });

  it("has everything on when nothing is switched off", () => {
    for (const name of FEATURE_NAMES) {
      expect(featureOnGiven(name, [])).toBe(true);
      // A config that carries no list at all (a test's partial config).
      expect(featureOnGiven(name, undefined)).toBe(true);
      expect(featureOn(name, {})).toBe(true);
    }
    expect(listFeatures({ featuresOff: [] }).map((f) => f.on)).toEqual([true, true, true]);
  });

  it("switches each feature off by itself", () => {
    expect(featureOn("extension", { featuresOff: ["extension"] })).toBe(false);
    expect(featureOn("mathematics", { featuresOff: ["extension"] })).toBe(true);
    expect(featureOn("prizes", { featuresOff: ["extension"] })).toBe(true);

    expect(featureOn("prizes", { featuresOff: ["prizes"] })).toBe(false);
    expect(featureOn("mathematics", { featuresOff: ["prizes"] })).toBe(true);
    expect(featureOn("extension", { featuresOff: ["prizes"] })).toBe(true);
  });

  it("switches prizes off with mathematics", () => {
    const config = { featuresOff: ["mathematics" as const] };
    expect(featureOn("mathematics", config)).toBe(false);
    expect(featureOn("prizes", config)).toBe(false);
    expect(featureOn("extension", config)).toBe(true);
    expect(listFeatures(config)).toEqual([
      { name: "extension", on: true, description: expect.any(String) },
      { name: "mathematics", on: false, description: expect.any(String) },
      { name: "prizes", on: false, description: expect.any(String) },
    ]);
  });

  it("names only features in a feature's requirements", () => {
    for (const feature of FEATURES) {
      for (const required of feature.requires) expect(FEATURE_NAMES).toContain(required);
    }
  });
});

describe("FEATURES_OFF", () => {
  it("parses to the features it names, each once, whatever the spacing or case", () => {
    expect(parseFeaturesOff("")).toEqual([]);
    expect(parseFeaturesOff(" , ")).toEqual([]);
    expect(parseFeaturesOff("prizes")).toEqual(["prizes"]);
    expect(parseFeaturesOff(" Prizes , extension,prizes ")).toEqual(["extension", "prizes"]);
    expect(parseFeaturesOff("extension,mathematics,prizes")).toEqual([
      "extension",
      "mathematics",
      "prizes",
    ]);
  });

  it("refuses a name that is not a feature, listing those that are", () => {
    expect(() => parseFeaturesOff("prize")).toThrow(/"prize", which is not a feature/);
    expect(() => parseFeaturesOff("prize")).toThrow(/extension, mathematics, prizes/);
    expect(() => parseFeaturesOff("extension,maths,solver")).toThrow(/"maths", "solver"/);
  });

  describe("in loadConfig", () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.FEATURES_OFF;
      delete process.env.FEATURES_OFF;
      // Config is cached per module instance: each case loads its own.
      vi.resetModules();
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.FEATURES_OFF;
      else process.env.FEATURES_OFF = saved;
    });

    it("defaults to nothing off", async () => {
      const { loadConfig } = await import("../../src/config.js");
      expect(loadConfig().featuresOff).toEqual([]);
      const features = await import("../../src/features.js");
      expect(features.listFeatures().every((f) => f.on)).toBe(true);
    });

    it("reads the names from the environment", async () => {
      process.env.FEATURES_OFF = "mathematics, extension";
      const { loadConfig } = await import("../../src/config.js");
      expect(loadConfig().featuresOff).toEqual(["extension", "mathematics"]);
      const features = await import("../../src/features.js");
      expect(features.featureOn("extension")).toBe(false);
      expect(features.featureOn("mathematics")).toBe(false);
      // Not named, and off all the same: it needs mathematics.
      expect(features.featureOn("prizes")).toBe(false);
    });

    it("fails on an unknown name with the valid ones in the message", async () => {
      process.env.FEATURES_OFF = "extension,prize";
      const { loadConfig } = await import("../../src/config.js");
      expect(() => loadConfig()).toThrow(/FEATURES_OFF names \\?"prize\\?"/);
      expect(() => loadConfig()).toThrow(/The features are: extension, mathematics, prizes/);
    });
  });
});

describe("the agents' tools of a feature", () => {
  const SKILL_ROLES: SkillRole[] = [
    "claim-steward",
    "researcher",
    "audit-agent",
    "dispute-arbitrator",
    "contribution-reviewer",
    "curator",
    "grantmaker",
    "program-officer",
  ];
  // Every tool an agent family or a skill defines, with the Grantmaker's
  // bounty tools, which are defined in its own file.
  const everyTool = () =>
    new Set([
      ...builtinToolNames(),
      ...declaredSkillToolNames(),
      ...getBountyToolDefinitions().map((t) => t.name),
      getConfirmBountyToolDefinition().name,
    ]);

  it("names only tools that exist, each under a feature that exists", () => {
    const known = everyTool();
    for (const [name, feature] of Object.entries(TOOL_FEATURES)) {
      expect(known.has(name), name).toBe(true);
      expect(FEATURE_NAMES).toContain(feature);
    }
  });

  it("lists every tool named for prizes, bounties, Lean, formal statements or proof attempts", () => {
    const named = [...everyTool()].filter((name) =>
      /bount|priz|^lean_|formaliz|proof_attempt|solved_by_platform/.test(name)
    );
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((name) => toolFeature(name) === null)).toEqual([]);
  });

  it("keeps every tool while its feature is on", () => {
    const tools = [...everyTool()].map((name) => ({ name }));
    expect(withoutOffFeatureTools(tools, { featuresOff: [] })).toEqual(tools);
    expect(withoutOffFeatureTools(tools, {})).toEqual(tools);
  });

  it("drops the prize tools with prizes off, and nothing else", () => {
    const config = { featuresOff: ["prizes" as const] };
    const audit = getAuditToolDefinitions();
    const auditOff = withoutOffFeatureTools(audit, config).map((t) => t.name);
    expect(audit.map((t) => t.name).filter((n) => !auditOff.includes(n))).toEqual([
      "get_prize_claim_record",
      "record_prize_audit_outcome",
      "withdraw_bounty_after_audit",
    ]);
    const reviewer = getReviewerToolDefinitions();
    const reviewerOff = withoutOffFeatureTools(reviewer, config).map((t) => t.name);
    expect(reviewer.map((t) => t.name).filter((n) => !reviewerOff.includes(n))).toEqual([
      "get_prize_claim_details",
    ]);
    expect(withoutOffFeatureTools(getBountyToolDefinitions(), config)).toEqual([]);
    // Mathematics is still on: the Lean and proof-attempt tools stay.
    const kept = withoutOffFeatureTools(
      [{ name: "lean_check" }, { name: "get_proof_attempt" }, { name: "get_prize_claim" }],
      config
    );
    expect(kept.map((t) => t.name)).toEqual(["lean_check", "get_proof_attempt"]);
  });

  it("drops the mathematics tools and the prize tools with mathematics off", () => {
    const config = { featuresOff: ["mathematics" as const] };
    const tools = [...everyTool()].map((name) => ({ name }));
    const left = withoutOffFeatureTools(tools, config).map((t) => t.name);
    expect(left.filter((name) => toolFeature(name) !== null)).toEqual([]);
    expect(left).toHaveLength(tools.length - Object.keys(TOOL_FEATURES).length);
  });

  describe("in the toolsets the skills bring", () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.FEATURES_OFF;
      vi.resetModules();
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.FEATURES_OFF;
      else process.env.FEATURES_OFF = saved;
    });

    it("offers every declared skill tool with everything on", () => {
      for (const role of SKILL_ROLES) {
        expect(getActiveSkillToolDefinitions(listSkills(), role)).toEqual(
          getActiveSkillToolDefinitions(listSkills(), role, { declared: true })
        );
      }
    });

    it("offers no role a tool of a feature that is off, and still says what the skills declare", async () => {
      process.env.FEATURES_OFF = "mathematics";
      const skillTools = await import("../../src/llm/tools/skill-tools.js");
      const skills = await import("../../src/llm/prompts/skills.js");
      for (const role of SKILL_ROLES) {
        const offered = skillTools
          .getActiveSkillToolDefinitions(skills.listSkills(), role)
          .map((t) => t.name);
        expect(offered.filter((name) => toolFeature(name) !== null), role).toEqual([]);
        const declared = skillTools
          .getActiveSkillToolDefinitions(skills.listSkills(), role, { declared: true })
          .map((t) => t.name);
        expect(declared.filter((name) => toolFeature(name) === null), role).toEqual(offered);
      }
      // The Steward keeps the tools of the skills that are not a feature's.
      const steward = skillTools
        .getActiveSkillToolDefinitions(skills.listSkills(), "claim-steward")
        .map((t) => t.name);
      expect(steward).toContain("provenance_get_map");
      expect(steward).toContain("cost_sheet");
      expect(steward).not.toContain("lean_check");
      expect(steward).not.toContain("get_proof_attempt");
      expect(steward).not.toContain("decide_prize_claim");
    });

    it("withholds only the prize tools with prizes off", async () => {
      process.env.FEATURES_OFF = "prizes";
      const skillTools = await import("../../src/llm/tools/skill-tools.js");
      const skills = await import("../../src/llm/prompts/skills.js");
      const steward = skillTools
        .getActiveSkillToolDefinitions(skills.listSkills(), "claim-steward")
        .map((t) => t.name);
      expect(steward).toEqual(expect.arrayContaining(["lean_check", "get_proof_attempt"]));
      expect(steward).not.toContain("get_prize_claim");
      expect(steward).not.toContain("decide_prize_claim");
    });
  });

  it("treats the Lean checker as unconfigured with mathematics off", async () => {
    const { leanCheckerConfigured } = await import("../../src/services/lean-checker-client.js");
    const base = { leanCheckerUrl: "http://lean-checker.internal:8080", leanCheckerToken: "t" };
    type Arg = Parameters<typeof leanCheckerConfigured>[0];
    expect(leanCheckerConfigured({ ...base, featuresOff: [] } as unknown as Arg)).toBe(true);
    expect(leanCheckerConfigured({ ...base, featuresOff: ["prizes"] } as unknown as Arg)).toBe(true);
    expect(leanCheckerConfigured({ ...base, featuresOff: ["mathematics"] } as unknown as Arg)).toBe(false);
    expect(leanCheckerConfigured({ leanCheckerUrl: "", featuresOff: [] } as unknown as Arg)).toBe(false);
  });
});
