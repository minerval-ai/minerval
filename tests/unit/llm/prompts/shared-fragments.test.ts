import { describe, it, expect } from "vitest";
import { buildAdminPrompt, UNTRUSTED_CONTENT } from "../../../../src/llm/prompts/constitution.js";
import { getClaimStewardSystemPrompt } from "../../../../src/llm/prompts/claim-steward.js";
import { getResearcherSystemPrompt } from "../../../../src/llm/prompts/researcher.js";
import { getCuratorSystemPrompt } from "../../../../src/llm/prompts/curator.js";
import { getMatcherSystemPrompt } from "../../../../src/llm/prompts/matcher.js";
import { getReportToolDefinitions } from "../../../../src/llm/tools/report-tools.js";

/**
 * The block every admin prompt shares (prompts/constitution.ts): said
 * once, in one place, and true.
 */
describe("UNTRUSTED_CONTENT (#772)", () => {
  it("goes with every admin prompt, with or without the constitution", () => {
    expect(buildAdminPrompt("ROLE")).toContain(UNTRUSTED_CONTENT);
    expect(buildAdminPrompt("ROLE", false)).toBe(`ROLE\n\n${UNTRUSTED_CONTENT}`);
  });

  it("reaches the agents that read the most web text and were not told", () => {
    for (const prompt of [
      getClaimStewardSystemPrompt(),
      getResearcherSystemPrompt(),
      getCuratorSystemPrompt(),
      getMatcherSystemPrompt(),
    ]) {
      expect(prompt).toContain(UNTRUSTED_CONTENT);
    }
  });

  it("names search hits, since the server web_search carries no description", () => {
    expect(UNTRUSTED_CONTENT).toMatch(/search hit/);
    expect(UNTRUSTED_CONTENT).toMatch(/never instructions/);
  });
});

describe("raise_issue (#770)", () => {
  it("states no per-run ceiling, because none exists", () => {
    const raise = getReportToolDefinitions().find((t) => t.name === "raise_issue")!;
    expect(raise.description!).not.toMatch(/ceiling|at most|few (reports )?per run/i);
  });
});
