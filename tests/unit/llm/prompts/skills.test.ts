import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import {
  ROLE_VIEW,
  SKILL_ROLES,
  SKILL_SECTIONS,
  SKILL_STANDING,
  buildAdminPromptBlocks,
  domainSkillsSection,
  getSkill,
  getSkillCatalog,
  getSkillToolDefinitions,
  getSkillView,
  knownDomains,
  listSkills,
  methodSkills,
  METHOD_SKILL_STANDING,
  parseSkill,
  sectionsForRole,
  skillsForDomains,
  systemFromBlocks,
} from "../../../../src/llm/prompts/skills.js";
import { buildAdminPrompt } from "../../../../src/llm/prompts/constitution.js";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(here, "../../../../skills");

const skillDirs = readdirSync(SKILLS_DIR)
  .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
  .sort();

describe("skill authoring rules", () => {
  it("every skill directory carries a SKILL.md the loader accepts", () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    expect(listSkills().map((s) => s.name)).toEqual(skillDirs);
  });

  for (const name of skillDirs) {
    const raw = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf-8");
    const lines = raw.split("\n");

    it(`${name}: is under 600 lines`, () => {
      expect(lines.length).toBeLessThan(600);
    });

    it(`${name}: uses only the recognized H2 headings, each once`, () => {
      const headings = lines
        .filter((l) => l.startsWith("## "))
        .map((l) => l.slice(3).trim());
      for (const h of headings) {
        expect(SKILL_SECTIONS as readonly string[]).toContain(h);
      }
      expect(new Set(headings).size).toBe(headings.length);
    });

    it(`${name}: contains no em-dash character`, () => {
      expect(raw.includes("—")).toBe(false);
    });

    it(`${name}: contains no time-sensitive text in its body`, () => {
      const body = getSkill(name).body;
      // A skill is read for years: no calendar years, no "currently" or
      // "recently", no "as of" or "this year".
      expect(body).not.toMatch(/\b(19|20)\d{2}\b/);
      expect(body).not.toMatch(/\b(currently|recently|nowadays|this year|last year|as of today)\b/i);
    });

    it(`${name}: frontmatter obeys the Agent Skills constraints`, () => {
      const skill = getSkill(name);
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(Number.isInteger(skill.version) && skill.version >= 1).toBe(true);
      expect(skill.sinceEpoch).toMatch(/^\d{4}-\d{2}-/);
      // A domain skill claims at least one domain; a method skill claims none.
      if (skill.kind === "domain") expect(skill.domains.length).toBeGreaterThan(0);
      else expect(skill.domains).toEqual([]);
    });
  }
});

describe("the Mathematics skill", () => {
  it("loads with the frontmatter Appendix A specifies", () => {
    const m = getSkill("mathematics");
    expect(m.displayName).toBe("Mathematics");
    expect(m.version).toBe(1);
    expect(m.sinceEpoch).toBe("2026-09-domain-skills");
    expect(m.domains).toEqual(["mathematics"]);
    expect(m.description).toMatch(/^How the constitution applies to propositions of mathematics/);
    expect(m.description).toMatch(/Does not apply to claims that merely use a number or a model\.$/);
  });

  it("carries every administrator section in document order (the researcher's is the Provenance skill's)", () => {
    const m = getSkill("mathematics");
    expect(m.sections.map((s) => s.heading)).toEqual(
      SKILL_SECTIONS.filter((h) => h !== "For the researcher")
    );
    for (const s of m.sections) expect(s.body.length).toBeGreaterThan(50);
  });

  it("declares the eight tools with their roles", () => {
    const m = getSkill("mathematics");
    expect(m.tools.map((t) => t.name)).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "publish_formalization",
      "get_proof_attempt",
      "mark_problem_solved_by_platform",
      "get_prize_claim",
      "decide_prize_claim",
    ]);
    // The solver is not a skill role: it borrows these schemas under its own
    // descriptions. The researcher (#298) is one, and gets the two search and
    // elaboration tools on a mathematical claim, never a check.
    expect(m.tools[0]!.roles).toEqual(["claim-steward", "researcher"]);
    expect(m.tools[1]!.roles).toEqual(["claim-steward", "researcher"]);
    expect(m.tools[2]!.roles).toEqual(["claim-steward"]);
    expect(m.tools[3]!.roles).toEqual(["claim-steward"]);
    expect(m.tools[4]!.roles).toEqual(["claim-steward", "audit-agent"]);
    expect(m.tools[6]!.roles).toEqual(["claim-steward", "audit-agent"]);
  });

  it("owns the only known domain (the method skill claims none)", () => {
    expect(knownDomains()).toEqual(["mathematics"]);
    expect(getSkill("mathematics").kind).toBe("domain");
  });
});

describe("the Provenance skill", () => {
  const p = getSkill("provenance");

  it("is a method skill with no domain, carried by the roles it addresses", () => {
    expect(p.kind).toBe("method");
    expect(p.domains).toEqual([]);
    expect(methodSkills().map((s) => s.name)).toEqual(["provenance"]);
    expect(p.sections.map((s) => s.heading)).toEqual([
      "For every administrator",
      "For the Claim Steward",
      "For the Audit Agent",
      "For the Curator",
      "For the Extractor",
      "For the researcher",
      "Standards for judging",
      "Failure modes",
    ]);
  });

  it("declares its six tools: five for the researcher too, the two reads also for Audit, the map for the Steward alone", () => {
    expect(p.tools.map((t) => t.name)).toEqual([
      "provenance_get_map",
      "provenance_read_source",
      "provenance_record_reading",
      "provenance_record_edge",
      "provenance_record_source_relationship",
      "provenance_write_map",
    ]);
    expect(p.tools[0]!.roles).toEqual(["claim-steward", "audit-agent", "researcher"]);
    expect(p.tools[1]!.roles).toEqual(["claim-steward", "audit-agent", "researcher"]);
    for (const t of p.tools.slice(2, 5)) expect(t.roles).toEqual(["claim-steward", "researcher"]);
    expect(p.tools[5]!.roles).toEqual(["claim-steward"]);
  });

  it("is headed as a method skill with its own sentence of standing", () => {
    const view = getSkillView(p, "claim-steward");
    expect(view.startsWith("# Method skill: Provenance (version 1)\n\n" + METHOD_SKILL_STANDING)).toBe(true);
    expect(view).not.toContain("## Failure modes");
  });
});

describe("ROLE_VIEW", () => {
  const every = [
    "For every administrator",
    "For the Claim Steward",
    "For the Grantmaker",
    "For the Contribution Reviewer and the Dispute Arbitrator",
    "For the Audit Agent",
    "For the Curator",
    "For the Matcher",
    "For the Extractor",
  ];

  it("is exactly the composition table of section 3.3", () => {
    expect(ROLE_VIEW["claim-steward"]).toEqual(every);
    expect(ROLE_VIEW["audit-agent"]).toEqual([...every, "Standards for judging"]);
    expect(ROLE_VIEW.grantmaker).toEqual(["For every administrator", "For the Grantmaker"]);
    expect(ROLE_VIEW["contribution-reviewer"]).toEqual([
      "For every administrator",
      "For the Contribution Reviewer and the Dispute Arbitrator",
    ]);
    expect(ROLE_VIEW["dispute-arbitrator"]).toEqual(ROLE_VIEW["contribution-reviewer"]);
    expect(ROLE_VIEW.curator).toEqual([
      "For every administrator",
      "For the Curator",
      "For the Matcher",
    ]);
    expect(ROLE_VIEW.matcher).toEqual(["For the Matcher"]);
    expect(ROLE_VIEW.extractor).toEqual(["For the Extractor"]);
    expect(ROLE_VIEW.researcher).toEqual(["For the researcher"]);
    expect(SKILL_ROLES).toEqual([
      "claim-steward",
      "audit-agent",
      "grantmaker",
      "contribution-reviewer",
      "dispute-arbitrator",
      "curator",
      "matcher",
      "extractor",
      "researcher",
    ]);
  });

  it("never hands Failure modes to any role, and Standards for judging only to Audit", () => {
    for (const role of SKILL_ROLES) {
      expect(ROLE_VIEW[role]).not.toContain("Failure modes");
      if (role !== "audit-agent") {
        expect(ROLE_VIEW[role]).not.toContain("Standards for judging");
      }
    }
  });
});

describe("views", () => {
  const m = getSkill("mathematics");

  it("wraps the role's sections with the citable heading and the standing sentence", () => {
    const view = getSkillView(m, "claim-steward");
    expect(view.startsWith("# Domain skill: Mathematics (version 1)\n\n" + SKILL_STANDING)).toBe(
      true
    );
    for (const h of ROLE_VIEW["claim-steward"]) expect(view).toContain(`## ${h}\n`);
    expect(view).not.toContain("## For the solver");
    expect(view).not.toContain("## Standards for judging");
    expect(view).not.toContain("## Failure modes");
  });

  it("gives the Matcher only its own section, verbatim", () => {
    const view = getSkillView(m, "matcher");
    const headings = view.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## For the Matcher"]);
    const section = m.sections.find((s) => s.heading === "For the Matcher")!;
    expect(view).toContain(section.body);
  });

  it("gives Audit the judging standards, and no role a solver section (the solver's prompt is its own)", () => {
    expect(getSkillView(m, "audit-agent")).toContain("## Standards for judging");
    expect(m.body).not.toContain("## For the solver");
  });

  it("selects domain skills by domain and carries method skills on every run, alphabetically", () => {
    expect(skillsForDomains(["mathematics"]).map((s) => s.name)).toEqual([
      "mathematics",
      "provenance",
    ]);
    expect(skillsForDomains(["economics"]).map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains([]).map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains(undefined).map((s) => s.name)).toEqual(["provenance"]);
  });

  it("leaves a method skill out of a run whose role it has no section for", () => {
    expect(skillsForDomains([], "claim-steward").map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains([], "audit-agent").map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains([], "curator").map((s) => s.name)).toEqual(["provenance"]);
    // The Reviewer, Arbitrator, and Grantmaker receive "For every
    // administrator", so they carry the skill's shared section; the Matcher
    // receives only its own section, which the skill does not have.
    expect(skillsForDomains([], "contribution-reviewer").map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains([], "grantmaker").map((s) => s.name)).toEqual(["provenance"]);
    expect(skillsForDomains([], "matcher")).toEqual([]);
    expect(skillsForDomains(["mathematics"], "matcher").map((s) => s.name)).toEqual(["mathematics"]);
  });

  it("fails loudly for a skill that does not exist", () => {
    expect(() => getSkill("alchemy")).toThrow(/skill "alchemy" not found/);
  });

  it("lists the skills in the catalog with the role's sections", () => {
    const catalog = getSkillCatalog("grantmaker");
    expect(catalog).toMatch(
      /^Skills that exist: mathematics \(version 1; activated by domain mathematics; you receive: For every administrator, For the Grantmaker\); provenance \(version 1; a method skill, carried on every run; you receive: For every administrator\)\.$/
    );
    expect(getSkillCatalog("claim-steward")).toContain(
      "provenance (version 1; a method skill, carried on every run; you receive: For every administrator, For the Claim Steward, For the Audit Agent, For the Curator, For the Extractor)"
    );
    const section = domainSkillsSection("claim-steward");
    expect(section.startsWith("## Domain skills\n")).toBe(true);
    expect(section).toContain("never outranks either");
    expect(section).toContain(getSkillCatalog("claim-steward"));
  });

  it("hands each role only the tools declared for it, in the Anthropic shape", () => {
    const steward = getSkillToolDefinitions(m, "claim-steward");
    expect(steward.map((t) => t.name)).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "publish_formalization",
      "get_proof_attempt",
      "mark_problem_solved_by_platform",
      "get_prize_claim",
      "decide_prize_claim",
    ]);
    expect(Object.keys(steward[0]!).sort()).toEqual(["description", "input_schema", "name"]);
    expect(getSkillToolDefinitions(m, "matcher")).toEqual([]);
  });
});

describe("prompt composition", () => {
  it("buildAdminPromptBlocks keeps buildAdminPrompt as the first block", () => {
    const blocks = buildAdminPromptBlocks("# Role\n\nDo the thing.", ["# Domain skill: X (version 1)"]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(buildAdminPrompt("# Role\n\nDo the thing."));
    expect(blocks[1]).toBe("# Domain skill: X (version 1)");
    expect(buildAdminPromptBlocks("r")).toEqual([buildAdminPrompt("r")]);
  });

  it("systemFromBlocks joins the blocks with a rule", () => {
    expect(systemFromBlocks(["a", "b", "c"])).toBe("a\n\n---\n\nb\n\n---\n\nc");
    expect(systemFromBlocks(["only"])).toBe("only");
  });
});

describe("parseSkill", () => {
  const frontmatter = `---
name: sample
description: >-
  A sample skill for the tests. Applies to nothing.
metadata:
  minerval:
    version: 2
    since_epoch: 2026-09-domain-skills
    domains: [sample, samples]
---
`;

  it("parses folded descriptions, nested metadata, and inline lists", () => {
    const skill = parseSkill({
      raw: frontmatter + "\n## For every administrator\n\nBody.\n\n## For the Matcher\n\nMatch.\n",
      path: "sample/SKILL.md",
      toolsJson: JSON.stringify([
        { name: "sample_tool", description: "d", input_schema: { type: "object" }, roles: ["matcher"] },
      ]),
    });
    expect(skill.name).toBe("sample");
    expect(skill.displayName).toBe("Sample");
    expect(skill.description).toBe("A sample skill for the tests. Applies to nothing.");
    expect(skill.version).toBe(2);
    expect(skill.sinceEpoch).toBe("2026-09-domain-skills");
    expect(skill.domains).toEqual(["sample", "samples"]);
    expect(skill.sections.map((s) => s.heading)).toEqual([
      "For every administrator",
      "For the Matcher",
    ]);
    expect(skill.sections[0]!.body).toBe("Body.");
    expect(skill.tools[0]!.roles).toEqual(["matcher"]);
    expect(getSkillToolDefinitions(skill, "matcher")).toHaveLength(1);
    expect(getSkillToolDefinitions(skill, "curator")).toHaveLength(0);
  });

  it("rejects an unrecognized H2 heading", () => {
    expect(() =>
      parseSkill({
        raw: frontmatter + "\n## For the Janitor\n\nSweep.\n",
        path: "sample/SKILL.md",
      })
    ).toThrow(/unrecognized H2 heading "For the Janitor"/);
  });

  it("rejects text before the first section and a name that does not match its directory", () => {
    expect(() =>
      parseSkill({
        raw: frontmatter + "\nStray preamble.\n\n## For the Matcher\n\nMatch.\n",
        path: "sample/SKILL.md",
      })
    ).toThrow(/before the first H2 heading/);
    expect(() =>
      parseSkill({
        raw: frontmatter + "\n## For the Matcher\n\nMatch.\n",
        path: "other/SKILL.md",
        expectedName: "other",
      })
    ).toThrow(/does not match its directory/);
  });

  it("reads the kind, and refuses a method skill with domains or a domain skill without", () => {
    const method = frontmatter.replace("    domains: [sample, samples]\n", "    kind: method\n");
    const skill = parseSkill({ raw: method + "\n## For the Matcher\n\nMatch.\n", path: "sample/SKILL.md" });
    expect(skill.kind).toBe("method");
    expect(skill.domains).toEqual([]);
    expect(getSkillView(skill, "matcher").startsWith("# Method skill: Sample (version 2)")).toBe(true);
    expect(
      parseSkill({ raw: frontmatter + "\n## For the Matcher\n\nMatch.\n", path: "sample/SKILL.md" }).kind
    ).toBe("domain");
    expect(() =>
      parseSkill({
        raw: frontmatter.replace("    domains: [sample, samples]\n", "    kind: method\n    domains: [sample]\n") +
          "\n## For the Matcher\n\nMatch.\n",
        path: "sample/SKILL.md",
      })
    ).toThrow(/a method skill claims no domain/);
    expect(() =>
      parseSkill({
        raw: frontmatter.replace("    domains: [sample, samples]\n", "") + "\n## For the Matcher\n\nMatch.\n",
        path: "sample/SKILL.md",
      })
    ).toThrow(/must list at least one domain/);
    expect(() =>
      parseSkill({
        raw: frontmatter.replace("    domains: [sample, samples]\n", "    kind: habit\n") + "\n## For the Matcher\n\nMatch.\n",
        path: "sample/SKILL.md",
      })
    ).toThrow(/kind must be "domain" or "method"/);
  });

  it("rejects a file without frontmatter and a tool naming an unknown role", () => {
    expect(() => parseSkill({ raw: "## For the Matcher\n\nx\n", path: "p" })).toThrow(
      /frontmatter/
    );
    expect(() =>
      parseSkill({
        raw: frontmatter + "\n## For the Matcher\n\nMatch.\n",
        path: "sample/SKILL.md",
        toolsJson: JSON.stringify([
          { name: "t", description: "d", input_schema: {}, roles: ["janitor"] },
        ]),
      })
    ).toThrow(/unknown role "janitor"/);
  });
});
