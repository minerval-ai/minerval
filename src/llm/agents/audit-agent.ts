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
import { withoutOffFeatureTools } from "../tools/feature-tools.js";
import { oneLabelOnly } from "../../services/judgment-version-service.js";

/** The tools of a redaction_fidelity audit, which exist only where a deployment has more than one label. */
const REDACTION_CHECK_TOOLS: ReadonlySet<string> = new Set(["get_redaction_to_check", "record_fidelity_outcome"]);
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { createResearchTools } from "../tools/research-tools.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import { getSpendToolDefinitions, executeSpendTool } from "../tools/spend-tools.js";
import { executeSessionTool, getSessionToolDefinitions, openSession, type AgentSession, type SessionResume } from "../tools/session-tools.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runAudit(
  input: Parameters<typeof runAuditImpl>[0],
  /** A paused session to continue (engine-executor.ts, runResumeAction). */
  resume?: SessionResume
): ReturnType<typeof runAuditImpl> {
  // The run belongs to a session (session-service.ts): what it asks for and
  // waits on comes back into it, and it pauses at the end when answers are
  // outstanding, keeping its input to be rebuilt when it resumes.
  return withAgent("audit", () => {
    const sess = openSession("audit", null, input, resume);
    return sess.run(async () => {
      const result = await runAuditImpl(input, sess);
      await sess.close(input.model ?? "");
      return result;
    });
  });
}

async function runAuditImpl(input: {
  auditType: string;
  context: string;
  // The audit_runs row this run executes (#180); findings attach to it.
  runId?: string;
  model?: string;
}, sess: AgentSession): Promise<void> {
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
  // The researcher, for checking what a decision rests on further than a
  // run should read inline (Part VIII, Instruments), paid from this run's
  // budget; it reads and reports and writes nothing to the graph. Offered
  // only when the run has a budget and the researcher is enabled.
  const researchTools = createResearchTools({ requestedBy: "audit" });

  const tools = [
    ...getGovernanceToolDefinitions(),
    // Less the prize tools while the prizes feature is off (src/features.ts).
    // And less the two that check a redaction where the graph has one label
    // and nothing is redacted (services/showing-service.ts).
    ...withoutOffFeatureTools(getAuditToolDefinitions()).filter(
      (t) => !oneLabelOnly() || !REDACTION_CHECK_TOOLS.has(t.name)
    ),
    ...getSpendToolDefinitions(),
    ...getSessionToolDefinitions(),
    getSqlToolDefinition(),
    ...skillLoader.definitions,
    ...skillTools,
    ...reportTools.definitions, ...findingTools.definitions,
    ...researchTools.definitions,
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

${turnBudgetLine(AUDIT_MAX_TURNS, { canSpend: true })}`;

  await withSkills([], () => toolUseLoop({
    initialMessages: sess.initialMessages([{ role: "user", content: userMessage }]),
    ...sess.loop,
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
      const research = await researchTools.execute(name, toolInput);
      if (research !== null) return research;
      const sessionOut = await executeSessionTool(name, toolInput);
      if (sessionOut !== null) return sessionOut;
      const spend = await executeSpendTool(name, toolInput);
      if (spend !== null) return spend;
      const sql = await executeSqlTool(name, toolInput);
      if (sql !== null) return sql;
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
