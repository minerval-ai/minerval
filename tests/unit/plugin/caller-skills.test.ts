import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { syncPluginContent } from "../../../scripts/sync-frontend-content.js";
import {
  callerSkillsDir,
  getCallerSkill,
  listCallerSkills,
  MCP_INSTRUCTIONS,
} from "../../../src/mcp/caller-skills.js";
import { ROUTE_TOOLS } from "../../../src/mcp/route-tools.js";

/**
 * The caller skills (#620): plugin/skills/, shipped by the plugin and served
 * by the MCP server as resources. They must stay true as what they refer to
 * changes, so this file checks the three ways they can drift: a vendored copy
 * (the constitution, the administrators' skills and role prompts) going
 * stale, a tool they name being renamed or removed, and a constitution
 * section they cite being renumbered.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginSkills = join(root, "plugin/skills");
const FIX = "run: npx tsx scripts/sync-frontend-content.ts";

describe("caller skills", () => {
  it("vendors the constitution, admin skills, and role prompts verbatim", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minerval-plugin-"));
    try {
      const written = syncPluginContent(tmp);
      expect(written).toContain("minerval-constitution/constitution.md");
      expect(written).toContain("administrator-skills/CATALOG.md");
      for (const rel of written) {
        const have = join(pluginSkills, rel);
        expect(existsSync(have), `plugin/skills/${rel} is missing; ${FIX}`).toBe(true);
        expect(
          readFileSync(have, "utf-8") === readFileSync(join(tmp, rel), "utf-8"),
          `plugin/skills/${rel} has drifted from its source; ${FIX}`
        ).toBe(true);
      }
      // Nothing stale left behind from a removed skill or role.
      for (const sub of ["skills", "roles"]) {
        const dir = `administrator-skills/${sub}`;
        expect(readdirSync(join(pluginSkills, dir)).sort(), `${dir}; ${FIX}`).toEqual(
          readdirSync(join(tmp, dir)).sort()
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loads every skill with a valid name and description", () => {
    const skills = listCallerSkills();
    expect(skills.map((s) => s.name)).toEqual([
      "administrator-skills",
      "claim-checking",
      "commissioning-research",
      "minerval-constitution",
    ]);
    for (const s of skills) {
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.name.length).toBeLessThanOrEqual(64);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      // The Agent Skills guidance: keep SKILL.md under 500 lines.
      expect(s.text.split("\n").length).toBeLessThan(500);
      // House style, as for the administrators' skills.
      expect(s.text, `${s.name} contains an em-dash`).not.toContain("—");
    }
    expect(callerSkillsDir()).toBe(pluginSkills);
  });

  it("names only MCP tools that exist", () => {
    const server = readFileSync(join(root, "src/mcp/server.ts"), "utf-8");
    const native = [...server.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(native).toContain("match_claim");
    const tools = new Set([...native, ...Object.values(ROUTE_TOOLS).map((t) => t.name)]);
    // A backticked identifier that reads as a tool call (verb_noun), as
    // opposed to a field name such as `page_url`.
    const TOOLISH =
      /`((?:get|list|search|match|assess|extract|submit|propose|order|fund|start|send|approve|raise|cite|top_up|cancel|export|challenge)_[a-z_]+)`/g;
    const texts = [
      ...listCallerSkills()
        .filter((s) => s.name !== "administrator-skills")
        .map((s) => ({ where: s.name, text: s.text })),
      { where: "MCP_INSTRUCTIONS", text: MCP_INSTRUCTIONS.replace(/\b([a-z]+_[a-z_]+)\b/g, "`$1`") },
    ];
    for (const { where, text } of texts) {
      for (const m of text.matchAll(TOOLISH)) {
        expect(tools.has(m[1]!), `${where} names \`${m[1]}\`, which is not an MCP tool`).toBe(
          true
        );
      }
    }
  });

  it("cites only constitution sections that exist", () => {
    const constitution = readFileSync(join(root, "admin_constitution.md"), "utf-8");
    const sections = new Set(
      [...constitution.matchAll(/^###\s+(\d+a?)\./gm)].map((m) => m[1]!)
    );
    expect(sections.has("7a")).toBe(true);
    for (const s of listCallerSkills().filter((x) => x.name !== "administrator-skills")) {
      for (const m of s.text.matchAll(/§(\d+a?)/g)) {
        expect(sections.has(m[1]!), `${s.name} cites §${m[1]}, not in the constitution`).toBe(
          true
        );
      }
    }
  });

  it("points the skills and the instructions at the constitution", () => {
    for (const name of ["claim-checking", "commissioning-research", "administrator-skills"]) {
      expect(getCallerSkill(name)!.text).toContain("minerval-constitution");
    }
    expect(MCP_INSTRUCTIONS).toContain("minerval://constitution");
    for (const s of listCallerSkills()) {
      expect(MCP_INSTRUCTIONS).toContain(`minerval://skills/${s.name}`);
    }
    expect(getCallerSkill("no-such-skill")).toBeNull();
  });
});
