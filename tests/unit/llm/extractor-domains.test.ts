import { describe, it, expect } from "vitest";

/**
 * The Extractor emits a domain prior per claim (docs/mathematics.md §3.4):
 * a `domains` field in its structured-output schema drawn from the closed
 * list of domains the skills define, and it always carries every skill's
 * "For the Extractor" view so it can tag.
 */
import { getExtractedClaimSchema } from "../../../src/llm/agents/extractor.js";
import { getExtractorSystemPromptBlocks } from "../../../src/llm/prompts/extractor.js";
import { knownDomains, listSkills } from "../../../src/llm/prompts/skills.js";

describe("extracted-claim schema", () => {
  const schema = getExtractedClaimSchema() as {
    properties: Record<string, { type?: string; items?: { type: string; enum?: string[] } }>;
    required: string[];
    additionalProperties: boolean;
  };

  it("has a required domains array from the closed list of skill domains", () => {
    expect(schema.required).toContain("domains");
    expect(schema.additionalProperties).toBe(false);
    const domains = schema.properties.domains!;
    expect(domains.type).toBe("array");
    expect(domains.items!.enum).toEqual(knownDomains());
    expect(domains.items!.enum).toEqual(["mathematics"]);
  });

  it("keeps every field the pipeline already reads", () => {
    for (const f of [
      "original_text",
      "context",
      "proposed_canonical_form",
      "claim_type",
      "confidence",
      "importance",
      "contestation",
      "source_location",
    ]) {
      expect(schema.required).toContain(f);
      expect(schema.properties[f]).toBeDefined();
    }
  });
});

describe("extractor prompt", () => {
  it("names the domains field and carries every skill's Extractor section", () => {
    const blocks = getExtractorSystemPromptBlocks({ skills: listSkills() });
    expect(blocks).toHaveLength(1 + listSkills().length);
    expect(blocks[0]).toContain("**domains**");
    expect(blocks[0]).toContain("## Domain skills");
    const math = blocks[1]!;
    expect(math.startsWith("# Domain skill: Mathematics (version 1)")).toBe(true);
    expect(math.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## For the Extractor"]);
  });
});
