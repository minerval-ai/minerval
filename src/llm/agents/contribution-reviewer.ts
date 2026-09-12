/**
 * Contribution Reviewer agent.
 *
 * Evaluates contributions against policies and decides whether to accept,
 * reject, or escalate. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getContributionReviewerSystemPromptBlocks } from "../prompts/contribution-reviewer.js";
import { skillsForDomains } from "../prompts/skills.js";
import { domainsForContribution } from "./skill-selection.js";
import {
  getGovernanceToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getReviewerToolDefinitions,
  executeReviewerTool,
} from "../tools/reviewer-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runContributionReview(
  input: Parameters<typeof runContributionReviewImpl>[0]
): ReturnType<typeof runContributionReviewImpl> {
  return withAgent("contribution_reviewer", () => runContributionReviewImpl(input));
}

async function runContributionReviewImpl(input: {
  contributionId: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = input.model ?? config.governanceModel;

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getReviewerToolDefinitions(),
    ...reportTools.definitions, ...findingTools.definitions,
  ];

  // Domain skills come from the contribution's target claim (docs/
  // mathematics.md §3.4); an intake proposal with no claim yet carries none.
  const skills = skillsForDomains(await domainsForContribution(input.contributionId), "contribution-reviewer");
  // One cached block for the constitution and role, plus one per active skill.
  const system = getContributionReviewerSystemPromptBlocks({ skills });

  const userMessage = `A new contribution has been submitted for review.

Contribution ID: ${input.contributionId}

Please review this contribution:
1. Use get_contribution_details to load the contribution and understand what is being proposed.
2. If it targets an existing claim, use get_claim_with_context to understand that claim. Intake contributions (propose_claim, propose_source) have no target claim; the proposal itself is what you are judging.
3. Use get_contributor_profile to understand the contributor's history and trust level.
4. Evaluate the contribution against the acceptance criteria for its type.
5. Record your decision using record_review_decision (accept, reject, or escalate).
6. If you accept a contribution on an existing claim, use notify_claim_steward so the steward can integrate the change. Accepted INTAKE contributions are materialized automatically by record_review_decision (matching/canonicalization, then claim creation or extraction); do not call notify_claim_steward for those; the result is reported back to you in the tool result.
7. If you escalate, use escalate_to_arbitrator with your reasoning.`;

  // A review that ends without record_review_decision leaves the contribution
  // claimed-and-pending until the reclaim window passes (two of ten in the
  // GLM 5.3 Flash corpus scenario ended in prose instead). One nudge, only
  // while no decision has been recorded.
  let decisionRecorded = false;

  await withSkills(skills.map((s) => s.name), () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    maxTokens: 8192,
    maxIterations: 8,
    finalToolNudge: {
      max: 1,
      when: () => !decisionRecorded,
      message:
        "No review decision has been recorded for this contribution. Call " +
        "record_review_decision now (accept, reject, or escalate) with your reasoning.",
    },
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      const output = await executeReviewerTool(name, toolInput);
      if (name === "record_review_decision") {
        try {
          decisionRecorded = (JSON.parse(output) as { success?: boolean }).success !== false;
        } catch {
          decisionRecorded = true;
        }
      }
      return output;
    },
  }));
}
