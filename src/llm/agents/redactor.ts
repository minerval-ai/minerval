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
    `Something written at this label is going to readers who may not read it. You are at the gate, under the policy ` +
    `for that boundary.\n\n` +
    (input.round > 1
      ? `This is round ${input.round}: Audit returned your earlier redaction. Its reasons are in get_page_to_redact ` +
        `under returned_by_audit, and your earlier removals are still in place.\n\n`
      : "") +
    `Read the policy (get_redaction_policy) and the item (get_page_to_redact), remove what a category covers ` +
    `(redact), hold or delay what a removal cannot protect (hold, delay), and end with finish_redaction. ` +
    `A run that ends without finish_redaction leaves the item waiting to be redacted again.\n\n` +
    turnBudgetLine(RUN_TURN_GUARD)
  );
}

export function runRedactor(input: { pageId: string; model?: string }): Promise<void> {
  return withAgent("redactor", async () => {
    const config = loadConfig();
    // Its own setting (REDACTOR_MODEL), and the Steward's model where that
    // is unset: it reads a Steward's page and has to see what a passage
    // gives away as well as the writer could have. Audit, which checks its
    // work, has a setting of its own, so the two need not share a model.
    const model = input.model ?? (config.redactorModel || config.stewardModel);
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
