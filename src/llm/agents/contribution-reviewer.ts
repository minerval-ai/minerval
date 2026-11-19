/**
 * Contribution Reviewer agent.
 *
 * Evaluates contributions against policies and decides whether to accept,
 * reject, or escalate. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getContributionReviewerSystemPromptBlocks } from "../prompts/contribution-reviewer.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { listSkills } from "../prompts/skills.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { withoutOffFeatureTools } from "../tools/feature-tools.js";
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
import { withAgent, withDefaultPassBudget, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createConnectionTools, withConnectionsBlock } from "../tools/connection-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { executeReadPage, getReadPageToolDefinition } from "../tools/read-page-tool.js";
import {
  isPlatformFaultReason,
  PlatformFaultStop,
  type PlatformFaultReason,
} from "../../services/deployment-fault.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site. A review works to a
// budget it is shown (#712), unless its caller set one (the prize worker
// runs reviews under the bounty's reserve).
export function runContributionReview(
  input: Parameters<typeof runContributionReviewImpl>[0]
): ReturnType<typeof runContributionReviewImpl> {
  return withAgent("contribution_reviewer", () =>
    withDefaultPassBudget(
      {
        microUsd: loadConfig().contributionReviewBudgetUsd * 1_000_000,
        source: "the ceiling for one contribution review",
      },
      () => runContributionReviewImpl(input)
    )
  );
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

  // Skills load on demand; the contribution's target claim points to the
  // domain skills that cover its subject (an intake proposal has none).
  const skillLoader = createSkillLoadTools("contribution-reviewer", {
    domains: await domainsForContribution(input.contributionId),
  });

  // The criteria ask the Reviewer to follow evidence to its source (#694):
  // provenance_read_source arrives with the skill tools below, and the open
  // web for a citation the graph does not hold.
  const webSearch = createWebSearch(model);

  // The systems this deployment is connected to, where an administrator
  // offered them to this role. A contribution may cite or contradict what an organization's systems hold.
  // Read, never kept: a judgment that should rest on a reading is recorded
  // by an agent that keeps it (tools/connection-tools.ts).
  const connectionTools = await createConnectionTools({ config, role: "contribution_reviewer", keeps: false });
  const tools = [
    ...connectionTools.definitions,
    ...getGovernanceToolDefinitions(),
    // Less get_prize_claim_details while the prizes feature is off
    // (src/features.ts).
    ...withoutOffFeatureTools(getReviewerToolDefinitions()),
    getReadPageToolDefinition(),
    webSearch.tool,
    ...skillLoader.definitions,
    // The tools the skills declare for this role (a price list, say), in
    // the toolset whether or not the run loads the skill.
    ...getActiveSkillToolDefinitions(listSkills(), "contribution-reviewer"),
    ...reportTools.definitions, ...findingTools.definitions,
  ];

  const system = withConnectionsBlock(getContributionReviewerSystemPromptBlocks(), connectionTools);

  // Money bounds the run (#712); the turn cap only halts a loop that has
  // stopped spending (CLAUDE.md, "Prefer money to counts").
  const REVIEW_MAX_TURNS = RUN_TURN_GUARD;
  // The ids and the budget only: how a review runs is the role prompt's,
  // and a second copy here drifted from it (#708).
  const userMessage = `Review contribution ${input.contributionId}.

${turnBudgetLine(REVIEW_MAX_TURNS)}${skillLoader.pointerNote}`;

  // A review that ends without record_review_decision leaves the contribution
  // claimed-and-pending until the reclaim window passes (two of ten in the
  // GLM 5.3 Flash corpus scenario ended in prose instead). One nudge, only
  // while no decision has been recorded.
  let decisionRecorded = false;
  // A platform fault that stopped record_review_decision (#980: the
  // Matcher's provider out of credits on an intake accept). Nothing was
  // recorded and the next attempt is the queue's, not this run's: the run
  // ends before another turn, and the pipeline gives the attempt back.
  let fault: PlatformFaultReason | null = null;
  const stopOnFault = () => {
    if (fault && !decisionRecorded) throw new PlatformFaultStop(fault, "contribution review");
  };

  await withSkills([], () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    maxTokens: 8192,
    maxIterations: REVIEW_MAX_TURNS,
    finalToolNudge: {
      max: 1,
      when: () => !decisionRecorded && !fault,
      message:
        "No review decision has been recorded for this contribution. Call " +
        "record_review_decision now (accept, reject, or escalate) with your reasoning.",
    },
    beforeTurn: stopOnFault,
    executeTool: async (name, toolInput) => {
      if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
      const page = await executeReadPage(name, toolInput);
      if (page !== null) return page;
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "contribution-reviewer" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const connection = await connectionTools.execute(name, toolInput);
      if (connection !== null) return connection;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      const output = await executeReviewerTool(name, toolInput);
      if (name === "record_review_decision") {
        try {
          const parsed = JSON.parse(output) as { success?: boolean; platform_fault?: unknown };
          decisionRecorded = parsed.success !== false;
          if (isPlatformFaultReason(parsed.platform_fault)) fault = parsed.platform_fault;
        } catch {
          decisionRecorded = true;
        }
      }
      return output;
    },
  }));
  // The fault came on the run's last turn, so no turn followed to stop it.
  stopOnFault();
}
