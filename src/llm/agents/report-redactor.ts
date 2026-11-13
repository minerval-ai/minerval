/**
 * The Redactor's pass over an agent's report that is offered for sending
 * to Minerval's maintainers (services/report-sending-service.ts).
 *
 * The same role and prompt as the Redactor of a page (prompts/redactor.ts),
 * under the policy for what leaves the report's label, on the report's two
 * pieces of text: its title and its body. Its tools remove and mark and do
 * nothing else. The run works at the report's label, and is told its
 * budget and its turn guard like every agent.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { toolUseLoop } from "../client.js";
import { loadConfig } from "../../config.js";
import { refusalForCaller } from "../../db/clearance.js";
import { getRedactorSystemPromptBlocks } from "../prompts/redactor.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import { policyById } from "../../services/redaction-policy.js";
import {
  ReportSendingError,
  finishReportRedaction,
  redactReportPassage,
  reportToRedact,
  restoreReportPassage,
} from "../../services/report-sending-service.js";
import { rawQuery } from "../../db/client.js";
import { withAgent, withSkills } from "../usage-context.js";

export function reportRedactorTaskMessage(): string {
  return (
    `One of this deployment's agents reported a problem with Minerval's own machinery, and the report is offered for sending to Minerval's ` +
    `maintainers, outside this deployment. What would go is the report's title and body, and a few facts in fixed words that you cannot ` +
    `change (get_report_to_redact shows them). The report was written by a run that was reading this organization's material, so its words ` +
    `may carry some of it.\n\n` +
    `Redact the title and the body under the policy for what leaves this label (get_redaction_policy): remove what a category covers ` +
    `(redact_report), and end with finish_report_redaction. A person then reads the words as you left them and decides whether to send ` +
    `them, unless the organization has chosen to send redacted reports without asking, in which case nobody reads them first. A run that ` +
    `ends without finish_report_redaction leaves the report waiting to be redacted again.\n\n` +
    turnBudgetLine(RUN_TURN_GUARD)
  );
}

export const REPORT_REDACTOR_TOOL_NAMES = ["get_redaction_policy", "get_report_to_redact", "redact_report", "restore_report", "finish_report_redaction"] as const;

export function getReportRedactorToolDefinitions(): Tool[] {
  return [
    {
      name: "get_redaction_policy",
      description:
        "The policy for what leaves the label this report was written at, in full, with its version. A passage is removed only under one of its categories. Its section on what is always shown is about pages and does not apply to a report.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "get_report_to_redact",
      description:
        "The report's title and body as written and as they would go, the removals made so far, and the facts that go with the words in fixed vocabulary, which no tool changes.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "redact_report",
      description:
        "Remove one passage from the title or the body and leave the category's mark in its place. Give the passage exactly as it appears. Nothing else changes. Returns the text as it now reads.",
      input_schema: {
        type: "object" as const,
        properties: {
          field: { type: "string", enum: ["title", "body"] },
          passage: { type: "string", description: "The passage to remove, character for character as it appears." },
          occurrence: { type: "integer", description: "Which occurrence, where the passage appears more than once. 1 is the first." },
          category: { type: "string", description: "The name of the policy category that covers the passage, as the policy gives it." },
          note: { type: "string", description: "Why the category covers this passage. The person who sends the report reads it. It stays at the report's label." },
        },
        required: ["field", "passage", "category", "note"],
      },
    },
    {
      name: "restore_report",
      description: "Take back one removal: the passage is in the report again, as written.",
      input_schema: { type: "object" as const, properties: { removal_id: { type: "string" } }, required: ["removal_id"] },
    },
    {
      name: "finish_report_redaction",
      description: "End the redaction. After this the words do not change, and the report waits to be sent.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
  ];
}

const answer = (body: Record<string, unknown>) => JSON.stringify(body);

export async function executeReportRedactorTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { sendingId: string; model?: string | null; onFinished?: () => void }
): Promise<string> {
  try {
    switch (name) {
      case "get_redaction_policy": {
        const [row] = await rawQuery<{ policy_id: string | null }>(`SELECT policy_id FROM report_sendings WHERE id = $1`, [ctx.sendingId]);
        const policy = row?.policy_id ? await policyById(row.policy_id) : null;
        if (!policy) return answer({ success: false, message: "This report's policy could not be read." });
        return answer({ success: true, version: policy.version, policy: policy.body, category_names: policy.categories.map((c) => c.name) });
      }
      case "get_report_to_redact":
        return answer({ success: true, ...(await reportToRedact(ctx.sendingId)) });
      case "redact_report":
        return answer({
          success: true,
          ...(await redactReportPassage({
            sendingId: ctx.sendingId,
            field: String(input.field ?? ""),
            passage: String(input.passage ?? ""),
            occurrence: input.occurrence === undefined ? undefined : Number(input.occurrence),
            category: String(input.category ?? ""),
            note: String(input.note ?? ""),
          })),
        });
      case "restore_report":
        return answer({ success: true, ...(await restoreReportPassage({ sendingId: ctx.sendingId, removalId: String(input.removal_id ?? "") })) });
      case "finish_report_redaction": {
        const done = await finishReportRedaction({ sendingId: ctx.sendingId, model: ctx.model ?? null });
        ctx.onFinished?.();
        return answer({ success: true, ...done, message: "The redaction is recorded. The report waits to be sent." });
      }
      default:
        return answer({ success: false, message: `Unknown tool ${name}.` });
    }
  } catch (err) {
    if (err instanceof ReportSendingError) return answer({ success: false, code: err.code, message: err.message });
    const refusal = refusalForCaller(err);
    if (refusal) return answer({ success: false, message: refusal });
    throw err;
  }
}

export function runReportRedactor(input: { sendingId: string; model?: string }): Promise<void> {
  return withAgent("redactor", async () => {
    const config = loadConfig();
    const model = input.model ?? (config.redactorModel || config.stewardModel);
    let finished = false;
    await withSkills([], () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: reportRedactorTaskMessage() }],
        tools: getReportRedactorToolDefinitions(),
        system: getRedactorSystemPromptBlocks(),
        model,
        maxTokens: 8192,
        maxIterations: RUN_TURN_GUARD,
        onFinalTool: () => (finished ? { note: "The redaction is recorded." } : null),
        executeTool: (name, toolInput) => executeReportRedactorTool(name, toolInput, { sendingId: input.sendingId, model, onFinished: () => (finished = true) }),
      })
    );
  });
}
