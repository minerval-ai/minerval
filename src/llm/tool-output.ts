/**
 * What a client tool hands back to the loop (#912).
 *
 * Almost every tool returns a string, and the loops send it as the
 * tool_result's content. A tool that shows the model something it must see
 * rather than read (a figure from a paper, a PDF page) returns a ToolOutput:
 * the text of the result, and the bytes to show beside it. The loops turn it
 * into a tool_result whose content is a text block followed by image or
 * document blocks, in the seam's Anthropic dialect; each provider adapter
 * translates that to its own wire form (providers/openai-dialect.ts and
 * providers/responses-dialect.ts say how).
 *
 * The trace records the text and a line naming each attachment (type, size,
 * SHA-256), never the bytes: a run's steps are read by people and hashed
 * into its seal, and megabytes of base64 serve neither.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

/** The image types the model APIs take. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export type ToolAttachment =
  | { kind: "image"; mediaType: ImageMediaType; data: Buffer }
  /** A PDF shown whole as a document; only the Anthropic adapter takes one (models.ts, modelReadsPdfDocuments). */
  | { kind: "pdf"; data: Buffer };

export interface ToolOutput {
  /** The result as the model reads it. */
  text: string;
  /** What is shown beside it, in order. */
  attachments: ToolAttachment[];
}

/** What a loop's executeTool may return. */
export type ToolExecution = string | ToolOutput;

type ToolResultContent = NonNullable<Anthropic.ToolResultBlockParam["content"]>;

/** The text of a tool's result, attachments aside. */
export function toolOutputText(output: ToolExecution): string {
  return typeof output === "string" ? output : output.text;
}

/** A tool_result's content: the string as it is, or the text block and then what is shown. */
export function toolResultContent(output: ToolExecution): ToolResultContent {
  if (typeof output === "string") return output;
  if (output.attachments.length === 0) return output.text;
  return [
    { type: "text", text: output.text },
    ...output.attachments.map((a) =>
      a.kind === "image"
        ? {
            type: "image" as const,
            source: { type: "base64" as const, media_type: a.mediaType, data: a.data.toString("base64") },
          }
        : {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: a.data.toString("base64"),
            },
          }
    ),
  ];
}

/**
 * The result as the trace records it: the text, and one line per attachment
 * in place of its bytes.
 */
export function toolOutputForTrace(output: ToolExecution): string {
  if (typeof output === "string") return output;
  if (output.attachments.length === 0) return output.text;
  const lines = output.attachments.map((a) => {
    const type = a.kind === "image" ? a.mediaType : "application/pdf";
    const digest = createHash("sha256").update(a.data).digest("hex");
    return `[shown to the model: ${type}, ${a.data.byteLength} bytes, sha256 ${digest}]`;
  });
  return `${output.text}\n${lines.join("\n")}`;
}
