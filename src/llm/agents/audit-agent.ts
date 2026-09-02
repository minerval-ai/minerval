/**
 * Audit Agent.
 *
 * Reviews decisions for quality, consistency, and policy compliance.
 * The quality control layer that ensures the governance system is working
 * correctly. Acts through tools -- no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getAuditAgentSystemPrompt } from "../prompts/audit-agent.js";
import {
  getGovernanceToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getAuditToolDefinitions,
  executeAuditTool,
} from "../tools/audit-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

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

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  const tools = [
    ...getGovernanceToolDefinitions(),
    ...getAuditToolDefinitions(),
    ...reportTools.definitions,
  ];

  const userMessage = `You have been triggered to perform an audit.

Audit Type: ${input.auditType}
Context: ${input.context}

Investigate with the read tools, check get_audit_findings for prior findings
that bear on this ground, and record what you conclude: flag_issue for each
issue found (its finding_id is what the consequence tools require), or nothing
when the decisions under review hold up.`;

  await toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system: getAuditAgentSystemPrompt(),
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    maxIterations: 10,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const governanceTools = getGovernanceToolDefinitions().map((t) => t.name);
      if (governanceTools.includes(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      return executeAuditTool(name, toolInput, { runId: input.runId });
    },
  });
}
