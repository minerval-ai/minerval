/**
 * Audit Agent.
 *
 * Reviews decisions for quality, consistency, and policy compliance.
 * The quality control layer that ensures the governance system is working
 * correctly. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getAuditAgentSystemPromptBlocks } from "../prompts/audit-agent.js";
import { skillsForDomains } from "../prompts/skills.js";
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

  // Domain skills: the union over the claims in the decisions under review
  // (docs/mathematics.md §3.4), found through the claims and contributions
  // the context names. A pattern analysis names none and runs unskilled.
  const skills = skillsForDomains(await domainsForAuditContext(input.context));
  // The tools a skill declares for this role (§3.5): the Mathematics skill
  // brings get_prize_claim and get_proof_attempt, so an audit of a prize
  // acceptance reads the same record the Steward decided on. The Audit's
  // own get_prize_claim_record and record_prize_audit_outcome stay.
  const skillTools = getActiveSkillToolDefinitions(skills, "audit-agent");
  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getAuditToolDefinitions(),
    ...skillTools,
  ];
  // One cached block for the constitution and role, plus one per active skill.
  const system = getAuditAgentSystemPromptBlocks({ skills });

  const skillsNote =
    skills.length > 0
      ? `\n\nDomain skills active for this run: ${skills.map((s) => s.name).join(", ")}` +
        (skillTools.length > 0
          ? `; the tools they bring (${skillTools.map((t) => t.name).join(", ")}) are in your toolset.`
          : ".")
      : "";

  const userMessage = `You have been triggered to perform an audit.

Audit Type: ${input.auditType}
Context: ${input.context}

Investigate with the read tools, check get_audit_findings for prior findings
that bear on this ground, and record what you conclude: flag_issue for each
issue found (its finding_id is what the consequence tools require), or nothing
when the decisions under review hold up.${skillsNote}`;

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
    maxIterations: 10,
    executeTool: async (name, toolInput) => {
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      // Skill tools (docs/mathematics.md §3.5): present exactly when a
      // skill is active for the decisions under review.
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
