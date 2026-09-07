/**
 * Dispute Arbitrator agent.
 *
 * Handles escalated reviews, appeals, and complex disputes that require
 * deeper analysis. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getDisputeArbitratorSystemPromptBlocks } from "../prompts/dispute-arbitrator.js";
import { skillsForDomains } from "../prompts/skills.js";
import { domainsForContribution } from "./skill-selection.js";
import {
  getGovernanceToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getArbitratorToolDefinitions,
  executeArbitratorTool,
} from "../tools/arbitrator-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runArbitration(
  input: Parameters<typeof runArbitrationImpl>[0]
): ReturnType<typeof runArbitrationImpl> {
  return withAgent("dispute_arbitrator", () => runArbitrationImpl(input));
}

async function runArbitrationImpl(input: {
  contributionId: string;
  trigger: string;
  appealId?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  // Arbitration is the highest-stakes governance call, so it has its own model
  // knob (ARBITRATION_MODEL) rather than sharing governanceModel with the
  // reviewer and auditor. Production sets this to Opus 4.8.
  const model = input.model ?? config.arbitrationModel;

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getArbitratorToolDefinitions(),
    ...reportTools.definitions,
  ];

  // Domain skills come from the contribution's target claim (docs/
  // mathematics.md §3.4); an intake proposal with no claim yet carries none.
  const skills = skillsForDomains(await domainsForContribution(input.contributionId));
  // One cached block for the constitution and role, plus one per active skill.
  const system = getDisputeArbitratorSystemPromptBlocks({ skills });

  let userMessage = `You have been called to arbitrate a dispute.

Trigger: ${input.trigger}
Contribution ID: ${input.contributionId}`;

  if (input.appealId) {
    userMessage += `\nAppeal ID: ${input.appealId}`;
  }

  userMessage += `

Please:
1. Use get_contribution_details to understand the contribution, any existing review, the reviewer's escalation reason, the appeal (with the appellant's reasoning) when one exists, and any prior arbitration results.
2. Use get_claim_with_context to understand the target claim in full.
3. Use get_contributor_profile for the contributor's history.
4. Use get_recent_decisions to check for precedent in similar cases.
5. Apply your decision framework: gather context, analyze policies, assess evidence, decide.
6. Record your decision using record_arbitration_decision.
7. Use notify_claim_steward if the outcome affects the claim.
8. Use flag_for_human_review if the situation exceeds automated capacity.`;

  await withSkills(skills.map((s) => s.name), () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    maxIterations: 12,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      return executeArbitratorTool(name, toolInput);
    },
  }));
}
