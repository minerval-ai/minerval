/**
 * Dispute Arbitrator agent.
 *
 * Handles escalated reviews, appeals, and complex disputes that require
 * deeper analysis. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getDisputeArbitratorSystemPrompt } from "../prompts/dispute-arbitrator.js";
import {
  getGovernanceToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getArbitratorToolDefinitions,
  executeArbitratorTool,
} from "../tools/arbitrator-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";

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

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getArbitratorToolDefinitions(),
  ];

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

  await toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system: getDisputeArbitratorSystemPrompt(),
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    maxIterations: 12,
    executeTool: async (name, toolInput) => {
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      return executeArbitratorTool(name, toolInput);
    },
  });
}
