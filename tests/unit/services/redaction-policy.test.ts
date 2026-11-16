/**
 * A boundary's redaction policy (src/services/redaction-policy.ts): the
 * text every boundary starts from, and what a saved version may not do.
 */
import { describe, expect, it } from "vitest";
import { ALWAYS_SHOWN, DEFAULT_CATEGORIES, hashPolicy, policyProblems, renderPolicy } from "../../../src/services/redaction-policy.js";

describe("the text every boundary starts from", () => {
  const body = renderPolicy(DEFAULT_CATEGORIES, 1);

  it("can itself be saved", () => {
    expect(policyProblems(DEFAULT_CATEGORIES)).toEqual([]);
  });

  it("states how removal works and everything that is always shown, whatever the categories", () => {
    for (const line of ALWAYS_SHOWN) expect(body).toContain(`- ${line}`);
    const own = renderPolicy([{ name: "plant layout", covers: "Where machines stand.", examples: "A floor plan." }], 4);
    for (const line of ALWAYS_SHOWN) expect(own).toContain(`- ${line}`);
    expect(own).toContain("# Redaction policy, version 4");
    expect(own).toContain("Whether it is favorable or unfavorable to anyone is not a reason to remove it or to keep it.");
    expect(own).not.toContain("personal data\n\nDetail");
    expect(hashPolicy(own)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is worded for any organization: no category or example is about evaluating AI systems", () => {
    const categories = DEFAULT_CATEGORIES.map((c) => `${c.name}. ${c.covers} ${c.examples}`).join("\n");
    expect(categories).not.toMatch(/\b(model|evaluat\w*|jailbreak|benchmark|sandbag\w*|training|AI|lab|developer)\b/i);
    expect(DEFAULT_CATEGORIES.map((c) => c.name)).toEqual([
      "personal data",
      "security detail",
      "privileged or third-party confidential material",
      "unreleased product detail",
      "commercial figures",
      "internal identifiers",
      "weaknesses in others' systems",
      "detail that would help cause serious harm",
      "test content",
    ]);
  });

  it("says a supplier's name and the words of an interest or a gap are removable parts, outside the list no category covers", () => {
    // Three agents in the first run with real models read a sentence inside
    // the always-shown list as making these words unremovable, and held whole
    // pages. Nothing in the list may name words a category can cover.
    for (const line of ALWAYS_SHOWN) {
      expect(line, line).not.toMatch(/\bname\b|\bwords\b|part of the page/i);
    }
    const [list, after] = body.split("No category covers any of these.");
    expect(list).not.toContain("supplier's name");
    expect(after).toContain(
      "A supplier's name, the words of a recorded interest and the words of a gap are not among these. They are " +
        "parts of the page like any other: a category covers them as it covers any passage, and removing one does " +
        "not hold the page."
    );
  });

  it("names no label and ranks none: a boundary is a pair, not a level", () => {
    expect(body).not.toMatch(/restricted|internal\b(?! identifiers)|higher|lower|Boundary [AB]/);
  });

  it("is in American spelling, with no em-dash", () => {
    expect(body).not.toMatch(/—|favour|organis|recognis|judgement|behaviour/);
  });
});

describe("what a version may not do", () => {
  const category = (name: string, covers: string) => [{ name, covers, examples: "" }];

  it("define a category by whether a passage is favorable", () => {
    for (const [name, covers] of [
      ["sensitive findings", "Anything unfavorable to the organization."],
      ["reputation", "Statements about our conduct."],
      ["embarrassing detail", "Internal mistakes."],
      ["critical remarks", "Passages critical of the management."],
      ["tone", "Text that reflects badly on a partner."],
    ] as const) {
      const [problem] = policyProblems(category(name, covers));
      expect(problem?.problem, name).toContain("worded by how a passage reflects on someone");
      expect(problem?.problem, name).toContain("Say what kind of content is meant instead.");
    }
  });

  it("name something that is shown whenever a page is shown", () => {
    for (const [name, covers] of [
      ["bad verdicts", "A status of contradicted."],
      ["uncertainty", "The credence, where it is low."],
      ["method", "The prompt set and the policy version."],
    ] as const) {
      const [problem] = policyProblems(category(name, covers));
      expect(problem?.problem, name).toContain("names something that is shown whenever a page is shown");
    }
  });

  it("leave a mark ambiguous or unreadable", () => {
    expect(policyProblems(category("a ] bracket", "x"))[0]!.problem).toContain("no square brackets");
    expect(policyProblems(category("", "x"))[0]!.category).toBe("(unnamed)");
    expect(policyProblems([...category("plant layout", "x"), ...category("Plant Layout", "y")])[0]!.problem).toContain("Two categories have this name");
    expect(policyProblems(category("plant layout", ""))[0]!.problem).toContain("says what it covers");
  });

  it("is free to add, reword and drop categories that name kinds of content", () => {
    expect(
      policyProblems([
        { name: "critical infrastructure detail", covers: "Locations of substations and their protection settings.", examples: "" },
        { name: "court filings under seal", covers: "Documents a court has sealed.", examples: "" },
        { name: "cost estimates", covers: "Internal estimates of what a project will cost.", examples: "" },
        { name: "insurance coverage terms", covers: "The limits and exclusions of the organization's policies.", examples: "" },
        { name: "negative test results of named patients", covers: "A named patient's laboratory results.", examples: "" },
      ])
    ).toEqual([]);
    expect(policyProblems([])).toEqual([]);
  });
});
