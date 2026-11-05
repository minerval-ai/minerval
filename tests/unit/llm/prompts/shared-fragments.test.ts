import { describe, it, expect } from "vitest";
import { buildAdminPrompt, UNTRUSTED_CONTENT } from "../../../../src/llm/prompts/constitution.js";
import { RAISING_ISSUES } from "../../../../src/llm/prompts/raising-issues.js";
import { getClaimStewardSystemPrompt } from "../../../../src/llm/prompts/claim-steward.js";
import { getResearcherSystemPrompt } from "../../../../src/llm/prompts/researcher.js";
import { getCuratorSystemPrompt } from "../../../../src/llm/prompts/curator.js";
import { getMatcherSystemPrompt } from "../../../../src/llm/prompts/matcher.js";
import { getReportToolDefinitions } from "../../../../src/llm/tools/report-tools.js";

/**
 * The blocks every admin prompt shares (prompts/constitution.ts,
 * prompts/raising-issues.ts): said once, in one place, and true.
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

describe("RAISING_ISSUES (#770)", () => {
  it("states no per-run ceiling, here or in raise_issue, because none exists", () => {
    const raise = getReportToolDefinitions().find((t) => t.name === "raise_issue")!;
    for (const text of [RAISING_ISSUES, raise.description!]) {
      expect(text).not.toMatch(/ceiling|at most|few (reports )?per run/i);
    }
  });

  it("keeps to what the tool descriptions cannot say", () => {
    expect(RAISING_ISSUES).toMatch(/Look first/);
    expect(RAISING_ISSUES).toMatch(/Ordinary difficulty is the work/);
    expect(RAISING_ISSUES).not.toMatch(/no memory across runs/);
    expect(RAISING_ISSUES.split(/\s+/).length).toBeLessThan(200);
  });
});
