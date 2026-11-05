/**
 * Dispute Arbitrator agent.
 *
 * Handles escalated reviews, appeals, and complex disputes that require
 * deeper analysis. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getDisputeArbitratorSystemPromptBlocks } from "../prompts/dispute-arbitrator.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
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
import { createFindingTools } from "../tools/finding-tools.js";
import { turnBudgetLine } from "../prompts/turn-budget.js";
import { listSkills } from "../prompts/skills.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { executeReadPage, getReadPageToolDefinition } from "../tools/read-page-tool.js";

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
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });

  // Skills load on demand; the contribution's target claim points to the
  // domain skills that cover its subject (an intake proposal has none).
  const skillLoader = createSkillLoadTools("dispute-arbitrator", {
    domains: await domainsForContribution(input.contributionId),
  });

  // "Read the evidence" needs a way to open it (#694): the tools the skills
  // declare for this role (provenance_read_source among them), and the open
  // web for a citation the graph does not hold.
  const webSearch = createWebSearch(model);

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getArbitratorToolDefinitions(),
    getReadPageToolDefinition(),
    webSearch.tool,
    ...skillLoader.definitions,
    ...getActiveSkillToolDefinitions(listSkills(), "dispute-arbitrator"),
    ...reportTools.definitions, ...findingTools.definitions,
  ];

  const system = getDisputeArbitratorSystemPromptBlocks();

  const ARBITRATION_MAX_TURNS = 12;
  // The ids, the trigger and the budget only: how to arbitrate is the role
  // prompt's. The step list that used to sit here had drifted from it
  // ("analyze policies", flag_for_human_review over the human_review
  // outcome) (#708).
  let userMessage = `Arbitrate contribution ${input.contributionId}.

Trigger: ${input.trigger}`;

  if (input.appealId) {
    userMessage += `\nAppeal ID: ${input.appealId} (pass it to record_arbitration_decision; recording it resolves the appeal)`;
  }

  userMessage += `

${turnBudgetLine(ARBITRATION_MAX_TURNS)}${skillLoader.pointerNote}`;

  await withSkills([], () => toolUseLoop({
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
    maxIterations: ARBITRATION_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
      const page = await executeReadPage(name, toolInput);
      if (page !== null) return page;
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "dispute-arbitrator" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      return executeArbitratorTool(name, toolInput);
    },
  }));
}
