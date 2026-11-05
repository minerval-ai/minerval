/**
 * The researcher's reads beyond the claim graph (#746): what the graph
 * already holds about a document and, on a run that works a request, about
 * requests. The prompt tells the researcher not to spend budget
 * re-establishing what the graph records; these are how it finds out. All
 * read-only and free beyond their tokens, the same reads outside callers
 * have over MCP (get_source, get_source_examinations, get_request,
 * list_requests).
 *
 * Who funded a request is left out, as list_requests leaves it out for the
 * agents that judge requests: the researcher works a request without being
 * told the mandate or person behind it (prompts/researcher.ts, When You
 * Take Up a Request).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getSourceFacts } from "../../services/source-facts-service.js";
import { listExaminations } from "../../services/examination-service.js";
import { getRequest } from "../../services/request-service.js";
import { executeKindTool, getRequestToolDefinitions } from "./kind-tools.js";

type Tool = Anthropic.Tool;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_TOOLS: Tool[] = [
  {
    name: "get_source",
    description:
      "The facts about a document the graph holds that need no judgment: its identity (authors, " +
      "publisher, date, kind, DOI, an archived copy), its other versions and republished copies, and " +
      "any correction or retraction recorded against it. source_id is the id a provenance map, an " +
      "instance or an examination names.",
    input_schema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_source_examinations",
    description:
      "The examinations already done on a document: each one's brief, the facets it checked, what it " +
      "covered part by part, and its findings anchored to passages, with any audit notes. Read it " +
      "before examining or relying on a document, so you build on what was checked rather than redo it.",
    input_schema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
];

const GET_REQUEST_TOOL: Tool = {
  name: "get_request",
  description:
    "Read one request: what it asks, why, what would satisfy it, the nodes and sources it bears on, " +
    "its keeper, its state, its budget, and the work already done on it with each outcome and summary.",
  input_schema: {
    type: "object",
    properties: { request_id: { type: "string" } },
    required: ["request_id"],
    additionalProperties: false,
  },
};

const LIST_REQUESTS_TOOL: Tool = getRequestToolDefinitions("researcher").find((t) => t.name === "list_requests")!;

export interface ResearcherReadTools {
  definitions: Tool[];
  /** Returns null for a name this bundle does not own. */
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

/**
 * The reads for one run: the document reads on every run, and the request
 * reads on a run that takes up or scopes a request.
 */
export function createResearcherReadTools(options: { requests: boolean }): ResearcherReadTools {
  const definitions = [...SOURCE_TOOLS, ...(options.requests ? [GET_REQUEST_TOOL, LIST_REQUESTS_TOOL] : [])];
  const names = new Set(definitions.map((t) => t.name));

  const execute = async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    if (!names.has(name)) return null;
    if (name === "get_source" || name === "get_source_examinations") {
      const id = typeof input.source_id === "string" ? input.source_id.trim() : "";
      if (!UUID_RE.test(id)) return refuse(`source_id "${id}" is not a source id.`);
      if (name === "get_source") {
        const facts = await getSourceFacts(id);
        return facts ? JSON.stringify({ success: true, source: facts }) : refuse(`No source ${id} exists.`);
      }
      return JSON.stringify({ success: true, examinations: await listExaminations([id]) });
    }
    if (name === "get_request") {
      const id = typeof input.request_id === "string" ? input.request_id.trim() : "";
      if (!UUID_RE.test(id)) return refuse(`request_id "${id}" is not a request id.`);
      const request = await getRequest(id);
      if (!request) return refuse(`No request ${id} exists.`);
      // Without the ledger's backing or who funded each piece of work.
      const { ledger: _ledger, work, ...rest } = request;
      return JSON.stringify({
        success: true,
        request: { ...rest, work: work.map(({ funded_by: _funded, ...w }) => w) },
      });
    }
    // list_requests: the kind tools' executor, which already leaves funders out.
    return (await executeKindTool(name, input, { role: "researcher" }))!;
  };

  return { definitions, execute };
}
