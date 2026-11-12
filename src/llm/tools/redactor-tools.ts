/**
 * The Redactor's tools (prompts/redactor.ts; services/showing-service.ts).
 *
 * A Redactor's run is given one page and works on that page alone: the
 * tools take no page id from the model. They remove and mark, and nothing
 * else: no tool here writes a word onto the page.
 */
import type { ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";
import { refusalForCaller } from "../../db/clearance.js";
import { policyById } from "../../services/redaction-policy.js";
import {
  ShowingError,
  finishRedaction,
  pageCannotCross,
  pageToRedact,
  redactPassage,
  restorePassage,
  showingPage,
  sourceBehindPage,
} from "../../services/showing-service.js";

export const REDACTOR_TOOL_NAMES = [
  "get_redaction_policy",
  "get_page_to_redact",
  "redact",
  "restore",
  "cannot_cross",
  "finish_redaction",
] as const;

export function getRedactorToolDefinitions(): ToolUnion[] {
  return [
    {
      name: "get_redaction_policy",
      description:
        "The policy for the boundary this page is to be shown across, in full, with its version: how removal works, what is shown whenever a page is shown, and the categories. A passage is removed only under one of these categories.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_page_to_redact",
      description:
        "The page as written: what is always shown with it (always_shown), each part with its number, its kind and its text, the removals made so far, and the sources the page drew on with their labels. With source_id, returns that source's stored text instead, 20,000 characters at a time from offset, so that you can tell what a passage gives away.",
      input_schema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "One of the listed sources, to read its stored text." },
          offset: { type: "integer", description: "Where in the source's text to start. 0 if omitted." },
        },
        required: [],
      },
    },
    {
      name: "redact",
      description:
        "Remove one passage from one part and leave the category's mark in its place. Give the passage exactly as it appears in the part. Nothing else in the part changes. Returns the part as it now reads.",
      input_schema: {
        type: "object",
        properties: {
          part: { type: "integer", description: "The part's number, from get_page_to_redact." },
          passage: { type: "string", description: "The passage to remove, character for character as it appears in the part." },
          occurrence: { type: "integer", description: "Which occurrence, where the passage appears more than once in the part. 1 is the first." },
          category: { type: "string", description: "The name of the policy category that covers the passage, as the policy gives it." },
          note: {
            type: "string",
            description:
              "Why the category covers this passage. Audit and the people who decide what is released read it. It stays at the label the page was written at.",
          },
        },
        required: ["part", "passage", "category", "note"],
      },
    },
    {
      name: "restore",
      description: "Take back one removal: the passage is in its part again, as written.",
      input_schema: {
        type: "object",
        properties: { removal_id: { type: "string", description: "The removal's id, from redact or get_page_to_redact." } },
        required: ["removal_id"],
      },
    },
    {
      name: "cannot_cross",
      description:
        "Say that this page cannot be shown under this policy: one of the things that are always shown with a page could not be shown without giving away what a category protects. The readers on the other side see that the page is held, and nothing else. This ends your work on the page.",
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string", description: "The policy category that covers it." },
          note: { type: "string", description: "Which of the things that are always shown the category covers here, and why. It stays at the label the page was written at." },
        },
        required: ["category", "note"],
      },
    },
    {
      name: "finish_redaction",
      description:
        "End the redaction. Each part as you left it is hashed, the hashes are recorded where the readers on the other side can read them, and Audit's check is asked for. After this the parts do not change.",
      input_schema: {
        type: "object",
        properties: {
          least_sure: {
            type: "array",
            description:
              "The decisions you were least sure of, in either direction: a removal you might have left (give removal_id), or a passage you left and might have removed (give part). Empty if there were none.",
            items: {
              type: "object",
              properties: {
                removal_id: { type: "string" },
                part: { type: "integer" },
                why: { type: "string", description: "What made it a close call." },
              },
              required: ["why"],
            },
          },
        },
        required: ["least_sure"],
      },
    },
  ];
}

export function isRedactorTool(name: string): boolean {
  return (REDACTOR_TOOL_NAMES as readonly string[]).includes(name);
}

const answer = (body: Record<string, unknown>) => JSON.stringify(body);

/** Run one Redactor tool on the run's page. `finished` is told when the run's work on the page is over. */
export async function executeRedactorTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { pageId: string; model?: string | null; onFinished?: () => void }
): Promise<string> {
  try {
    switch (name) {
      case "get_redaction_policy": {
        const page = await showingPage(ctx.pageId);
        const policy = page ? await policyById(page.policy_id) : null;
        if (!policy) return answer({ success: false, message: "This page's policy could not be read." });
        return answer({ success: true, version: policy.version, policy: policy.body, category_names: policy.categories.map((c) => c.name) });
      }
      case "get_page_to_redact": {
        if (typeof input.source_id === "string" && input.source_id) {
          return answer({ success: true, ...(await sourceBehindPage(ctx.pageId, input.source_id, Number(input.offset ?? 0) || 0)) });
        }
        return answer({ success: true, ...(await pageToRedact(ctx.pageId)) });
      }
      case "redact": {
        const result = await redactPassage({
          pageId: ctx.pageId,
          part: Number(input.part),
          passage: String(input.passage ?? ""),
          occurrence: input.occurrence === undefined || input.occurrence === null ? undefined : Number(input.occurrence),
          category: String(input.category ?? ""),
          note: String(input.note ?? ""),
        });
        return answer({ success: true, ...result });
      }
      case "restore":
        return answer({ success: true, ...(await restorePassage({ pageId: ctx.pageId, removalId: String(input.removal_id ?? "") })) });
      case "cannot_cross": {
        await pageCannotCross({ pageId: ctx.pageId, category: String(input.category ?? ""), note: String(input.note ?? "") });
        ctx.onFinished?.();
        return answer({ success: true, message: "Recorded. The readers on the other side see that this page is held. Your work on it is done." });
      }
      case "finish_redaction": {
        const leastSure = Array.isArray(input.least_sure) ? (input.least_sure as Array<{ removal_id?: string; part?: number; why: string }>) : [];
        const { getUsageContext } = await import("../usage-context.js");
        const result = await finishRedaction({
          pageId: ctx.pageId,
          leastSure: leastSure.filter((l) => l && typeof l.why === "string"),
          model: ctx.model ?? null,
          runId: (getUsageContext() as { runId?: string }).runId ?? null,
        });
        ctx.onFinished?.();
        return answer({
          success: true,
          ...result,
          message: "The page is fingerprinted as you left it and Audit's check has been asked for. Your work on it is done.",
        });
      }
      default:
        return answer({ success: false, message: `Unknown tool: ${name}` });
    }
  } catch (err) {
    if (err instanceof ShowingError) return answer({ success: false, code: err.code, message: err.message });
    const refusal = refusalForCaller(err);
    if (refusal) return answer({ success: false, message: refusal });
    throw err;
  }
}
