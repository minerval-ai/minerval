import { describe, it, expect, vi } from "vitest";

// The registry never touches the database, but the tool families it checks
// names against import the client; keep the unit suite free of connections.
vi.mock("../../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  rawQuery: vi.fn(async () => []),
}));

import {
  assertSkillToolsRegistered,
  builtinToolNames,
  declaredSkillToolNames,
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
  registerSkillTool,
} from "../../../../src/llm/tools/skill-tools.js";
import { getSkill } from "../../../../src/llm/prompts/skills.js";

describe("skill tool registry", () => {
  it("has an executor for every tool every skill declares, and no collisions", () => {
    expect(() => assertSkillToolsRegistered()).not.toThrow();
  });

  it("knows the declared skill tools and nothing else", () => {
    expect([...declaredSkillToolNames()].sort()).toEqual([
      "lean_check",
      "lean_elaborate",
      "lean_search",
      "publish_formalization",
    ]);
    expect(isSkillTool("lean_search")).toBe(true);
    expect(isSkillTool("web_search")).toBe(false);
    expect(isSkillTool("update_claim_assessment")).toBe(false);
  });

  it("collects every existing tool family for the collision check", () => {
    const names = builtinToolNames();
    for (const n of [
      "update_claim_assessment",
      "set_claim_domains",
      "match_claim",
      "web_search",
      "search_similar_claims",
      "submit_match_decision",
      "get_claim_with_context",
      "merge_claims",
      "record_review_decision",
      "record_arbitration_decision",
      "flag_issue",
      "search_claims",
      "propose_mandate",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    for (const n of declaredSkillToolNames()) expect(names.has(n), n).toBe(false);
  });

  it("fails loudly when a skill tool collides with an existing tool", () => {
    expect(() =>
      assertSkillToolsRegistered({ existingNames: ["lean_search"] })
    ).toThrow(/"lean_search", which collides with an existing tool/);
  });

  it("answers that the Lean tools are not configured until their executors land", async () => {
    for (const name of ["lean_search", "lean_elaborate", "lean_check", "publish_formalization"]) {
      const out = JSON.parse(
        await executeSkillTool(name, { query: "x" }, { role: "claim-steward" })
      );
      expect(out).toEqual({
        success: false,
        message: "Lean tools are not configured in this deployment.",
      });
    }
  });

  it("returns a structured error for an undeclared tool or a throwing executor", async () => {
    const unknown = JSON.parse(
      await executeSkillTool("lean_prove", {}, { role: "claim-steward" })
    );
    expect(unknown.success).toBe(false);
    expect(unknown.message).toMatch(/Unknown skill tool/);

    const original = "lean_search";
    registerSkillTool(original, async () => {
      throw new Error("backend down");
    });
    try {
      const failed = JSON.parse(
        await executeSkillTool(original, {}, { role: "claim-steward" })
      );
      expect(failed.success).toBe(false);
      expect(failed.message).toMatch(/backend down/);
    } finally {
      registerSkillTool(original, async () =>
        JSON.stringify({
          success: false,
          message: "Lean tools are not configured in this deployment.",
        })
      );
    }
  });

  it("flattens the active skills' tools per role", () => {
    const m = getSkill("mathematics");
    expect(getActiveSkillToolDefinitions([m], "claim-steward").map((t) => t.name)).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "publish_formalization",
    ]);
    expect(getActiveSkillToolDefinitions([], "claim-steward")).toEqual([]);
    expect(getActiveSkillToolDefinitions([m], "curator")).toEqual([]);
  });
});
