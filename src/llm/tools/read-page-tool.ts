/**
 * read_page — one public web page, read as text, for any agent that has
 * web_search. A search hit is a snippet; whether a source matters (an
 * abstract, a retraction notice, a results table, a listing of further
 * sources) is often only visible on the page. The lookout had this alone;
 * the Steward, the review pass, and the planner all had web search and no
 * way to open what it found (#333).
 *
 * It reads in windows with the same contract as provenance_read_source
 * (offset, total_chars, truncated, next_offset), but stores nothing. It used
 * to stop at 12,000 characters with no way on and no sign it had cut, which
 * for a paper is the abstract and introduction; for the Grantmaker and the
 * Lookout it is the only reader they have (#769).
 *
 * Null-delegate convention: `executeReadPage` returns null for any other
 * tool name, so an agent wires it with one spread and one early return.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { readPage } from "../../services/source-watch-service.js";
import { SOURCE_READ_DEFAULT_CHARS, SOURCE_READ_MAX_CHARS } from "../../services/document-text.js";

export const READ_PAGE_TOOL_NAME = "read_page";

export function getReadPageToolDefinition(): Tool {
  return {
    name: READ_PAGE_TOOL_NAME,
    description:
      "Fetch one public web page (HTML, PDF or text; a data or TeX file in a repository is read as " +
      "written) and read it as text, one window at a time " +
      `(${SOURCE_READ_DEFAULT_CHARS.toLocaleString("en-US")} characters unless max_chars says ` +
      `otherwise, at most ${SOURCE_READ_MAX_CHARS.toLocaleString("en-US")}). When truncated is ` +
      "true, call again with offset: next_offset to read on, to the end if the page matters. " +
      "No count limits the windows; your budget does. Stores nothing in the graph.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        offset: {
          type: "number",
          description: "Character offset to start from: 0 (the default) or next_offset from the previous window.",
        },
        max_chars: {
          type: "number",
          description: `Window size in characters (default ${SOURCE_READ_DEFAULT_CHARS}, at most ${SOURCE_READ_MAX_CHARS}).`,
        },
      },
      required: ["url"],
    },
  };
}

export async function executeReadPage(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (name !== READ_PAGE_TOOL_NAME) return null;
  const offset = Number(input.offset);
  const maxChars = Number(input.max_chars);
  return JSON.stringify(
    await readPage(String(input.url ?? ""), {
      offset: Number.isFinite(offset) ? offset : undefined,
      maxChars: Number.isFinite(maxChars) ? maxChars : undefined,
    })
  );
}
