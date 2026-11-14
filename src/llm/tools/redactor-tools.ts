/**
 * The Redactor's tools (prompts/redactor.ts; services/showing-service.ts).
 *
 * A Redactor's run is given one page and works on that page alone: the
 * tools take no page id from the model. They remove and mark, and nothing
 * else: no tool here writes a word onto the page.
 */
import type { ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";
import { refusalForCaller } from "../../db/clearance.js";
import { HOLD_REASONS } from "../../services/gate-kinds.js";
import { redactorActs } from "../../services/release-gate-service.js";
import { policyById } from "../../services/redaction-policy.js";
import {
  ShowingError,
  finishRedaction,
  pageToRedact,
  redactPassage,
  restorePassage,
  showingPage,
  sourceBehindPage,
  whatTheDestinationHolds,
} from "../../services/showing-service.js";

export const REDACTOR_TOOL_NAMES = [
  "get_redaction_policy",
  "get_page_to_redact",
  "look_at_destination",
  "redact",
  "restore",
  "hold_part",
  "delay_part",
  "lift_hold",
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
        "The item as written, and how this gate is set for it (gate): what is always shown with it (always_shown), each part with its number, its kind and its text, the removals made so far, and the sources the page rests on with their labels. These are the sources the release gate counts for the page, so a reading or an analysis a judgment rests on, and a source cited through an argument or a subclaim, are among them. With source_id, returns that source's stored text instead, 20,000 characters at a time from offset, so that you can tell what a passage gives away.",
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
      name: "look_at_destination",
      description:
        "What the readers on the other side of this boundary can already read: the labels they read, the file sets held there by name with their paths, "
        + "and the connections held there by name. Given text (a phrase, a figure, a file name), also the sources there whose title, stored text or "
        + "quoted passages contain it and the nodes there whose wording or definition does. It returns names and ids, not text.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string", description: "Words or a figure to look for where the readers on the other side read." } },
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
      name: "hold_part",
      description:
        "Hold one part, or the whole item when you give no part, so that it does not go to the readers on the other side. A person at the gate may lift it. Those readers see that it is held by the Redactor, with the reason in its fixed words, and nothing else. Hold what a removal cannot protect: a part that gives away what a category covers however it is cut, or one of the things that are always shown.",
      input_schema: {
        type: "object",
        properties: {
          part: { type: "integer", description: "The part's number. Leave out to hold the whole item." },
          reason: { type: "string", enum: Object.keys(HOLD_REASONS), description: "One of the fixed reasons: " + Object.entries(HOLD_REASONS).map(([k, v]) => `${k} (${v})`).join("; ") + "." },
          note: { type: "string", description: "Why you are holding it. Audit and the people at the gate who read this label read it. It stays at this label." },
        },
        required: ["reason", "note"],
      },
    },
    {
      name: "delay_part",
      description:
        "Keep one part, or the whole item when you give no part, back until a time. It goes on by itself when the time comes, unless someone holds it. Parts delayed to the same time go together.",
      input_schema: {
        type: "object",
        properties: {
          part: { type: "integer", description: "The part's number. Leave out to delay the whole item." },
          until: { type: "string", description: "The date and time it is kept back until, as ISO 8601 (2026-12-01T09:00:00Z)." },
        },
        required: ["until"],
      },
    },
    {
      name: "lift_hold",
      description: "Take back a hold or a delay of yours on one part, or on the whole item when you give no part.",
      input_schema: {
        type: "object",
        properties: { part: { type: "integer", description: "The part's number. Leave out for the whole item." } },
        required: [],
      },
    },
    {
      name: "finish_redaction",
      description:
        "End the redaction. Each part as you left it is hashed, the hashes are recorded where the readers on the other side can read them, and Audit's check is asked for. After this the parts do not change. What you did not hold or delay then goes on under the gate's setting.",
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
      case "look_at_destination":
        return answer({ success: true, ...(await whatTheDestinationHolds(ctx.pageId, typeof input.text === "string" ? input.text : undefined)) });
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
      case "hold_part":
      case "delay_part":
      case "lift_hold": {
        const act = name === "hold_part" ? "hold" : name === "delay_part" ? "delay" : "lift";
        const { getUsageContext } = await import("../usage-context.js");
        const part = input.part === undefined || input.part === null ? null : Number(input.part);
        const result = await redactorActs({
          pageId: ctx.pageId,
          act,
          part,
          reason: typeof input.reason === "string" ? input.reason : undefined,
          until: typeof input.until === "string" ? input.until : undefined,
          note: typeof input.note === "string" ? input.note : undefined,
          runId: (getUsageContext() as { runId?: string }).runId ?? null,
        });
        const what = part === null ? "The whole item" : `Part ${part}`;
        return answer({
          success: true,
          ...result,
          message: !result.recorded
            ? "Nothing changed: that already stands."
            : act === "hold"
              ? `${what} is held. The readers on the other side will see that it is held by the Redactor, with the reason. Go on with the rest and end with finish_redaction.`
              : act === "delay"
                ? `${what} is kept back until then.`
                : `${what} is no longer held or delayed by you.`,
        });
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
