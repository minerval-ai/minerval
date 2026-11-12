/**
 * The Redactor: one run on one page that is to be shown below its label
 * (prompts/redactor.ts; services/showing-service.ts).
 *
 * The run works at the page's label, which is the label of its ledger row
 * (workers/engine-executor.ts). It is told its budget and its turn guard in
 * its task message, like every agent, and works under no other limit: how
 * many passages it removes and how many times a page comes back from Audit
 * are bounded by what the work is paid.
 */
import { toolUseLoop } from "../client.js";
import { loadConfig } from "../../config.js";
import { getRedactorSystemPromptBlocks } from "../prompts/redactor.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import { createReportTools } from "../tools/report-tools.js";
import { executeRedactorTool, getRedactorToolDefinitions } from "../tools/redactor-tools.js";
import { withAgent, withSkills } from "../usage-context.js";

/** What the Redactor is told at the start of a run. */
export function redactorTaskMessage(input: { round: number }): string {
  return (
    `A page is to be shown to readers who may not read the label it was written at. Redact it under the policy ` +
    `for that boundary.\n\n` +
    (input.round > 1
      ? `This is round ${input.round}: Audit returned your earlier redaction. Its reasons are in get_page_to_redact ` +
        `under returned_by_audit, and your earlier removals are still in place.\n\n`
      : "") +
    `Read the policy (get_redaction_policy) and the page (get_page_to_redact), remove what a category covers ` +
    `(redact), and end with finish_redaction, or with cannot_cross if the page cannot be shown under this policy. ` +
    `A run that ends without one of those two leaves the page waiting to be redacted again.\n\n` +
    turnBudgetLine(RUN_TURN_GUARD)
  );
}

export function runRedactor(input: { pageId: string; model?: string }): Promise<void> {
  return withAgent("redactor", async () => {
    const config = loadConfig();
    // The Redactor reads closely against a written standard, as Audit does,
    // and runs on the model configured for that work until it has a setting
    // of its own.
    const model = input.model ?? config.auditModel;
    const { showingPage } = await import("../../services/showing-service.js");
    const page = await showingPage(input.pageId);
    if (!page) throw new Error(`No page ${input.pageId} is read at this run's label.`);
    const reportTools = createReportTools({ model });
    let finished = false;
    await withSkills([], () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: redactorTaskMessage({ round: page.round }) }],
        tools: [...getRedactorToolDefinitions(), ...reportTools.definitions],
        system: getRedactorSystemPromptBlocks(),
        model,
        maxTokens: 16384,
        maxIterations: RUN_TURN_GUARD,
        // The run's work is over once the page is fingerprinted or found unable to cross.
        onFinalTool: () => (finished ? { note: "The redaction is recorded." } : null),
        executeTool: async (name, toolInput) => {
          const report = await reportTools.execute(name, toolInput);
          if (report !== null) return report;
          return executeRedactorTool(name, toolInput, { pageId: input.pageId, model, onFinished: () => (finished = true) });
        },
      })
    );
  });
}
