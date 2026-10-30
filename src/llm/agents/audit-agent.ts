/**
 * Audit Agent.
 *
 * Reviews decisions for quality, consistency, and policy compliance.
 * The quality control layer that ensures the governance system is working
 * correctly. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getAuditAgentSystemPromptBlocks } from "../prompts/audit-agent.js";
import { listSkills } from "../prompts/skills.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { domainsForAuditContext } from "./skill-selection.js";
import {
  getGovernanceToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getAuditToolDefinitions,
  executeAuditTool,
} from "../tools/audit-tools.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runAudit(
  input: Parameters<typeof runAuditImpl>[0]
): ReturnType<typeof runAuditImpl> {
  return withAgent("audit", () => runAuditImpl(input));
}

async function runAuditImpl(input: {
  auditType: string;
  context: string;
  // The audit_runs row this run executes (#180); findings attach to it.
  runId?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = input.model ?? config.auditModel;

  // Skills load on demand; the domains of the claims in the decisions under
  // review, found through the claims and contributions the context names,
  // point to the domain skills that cover them. A pattern analysis names none.
  const skillLoader = createSkillLoadTools("audit-agent", {
    domains: await domainsForAuditContext(input.context),
  });
  // The tools every skill declares for this role (§3.5), loaded or not: the
  // Mathematics skill brings get_prize_claim and get_proof_attempt, so an
  // audit of a prize acceptance reads the same record the Steward decided
  // on. The Audit's own get_prize_claim_record and record_prize_audit_outcome
  // stay.
  const skillTools = getActiveSkillToolDefinitions(listSkills(), "audit-agent");
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getAuditToolDefinitions(),
    ...skillLoader.definitions,
    ...skillTools,
    ...reportTools.definitions, ...findingTools.definitions,
  ];
  const system = getAuditAgentSystemPromptBlocks();
  const skillsNote = skillLoader.pointerNote;

  const AUDIT_MAX_TURNS = RUN_TURN_GUARD;
  const userMessage = `You have been triggered to perform an audit.

Audit Type: ${input.auditType}
Context: ${input.context}

Investigate with the read tools, check get_audit_findings for prior findings
that bear on this ground, and record what you conclude: flag_issue for each
issue found (its finding_id is what the consequence tools require), or nothing
when the decisions under review hold up.${skillsNote}

${turnBudgetLine(AUDIT_MAX_TURNS)}`;

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
    maxIterations: AUDIT_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      // Skill tools (docs/mathematics.md §3.5), loaded or not.
      if (isSkillTool(name)) {
        return executeSkillTool(name, toolInput, {
          role: "audit-agent",
          run: { trigger: input.auditType, context: input.context, model },
        });
      }
      return executeAuditTool(name, toolInput, { runId: input.runId });
    },
  }));
}
