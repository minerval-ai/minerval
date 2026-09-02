import type Anthropic from "@anthropic-ai/sdk";
type MessageParam = Anthropic.MessageParam;
import { completeStructuredList, toolUseLoop } from "../client.js";
import {
  getAssessorSystemPrompt,
  getAssessmentPrompt,
  getChatSystemPrompt,
  getChatContextPrompt,
} from "../prompts/extension-agent.js";
import {
  getGraphToolDefinitions,
  executeGraphTool,
} from "../tools/graph-tools.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

/**
 * The Extension Agent (issue #72) — lives with the browser extension, never
 * edits the graph. Two entry points: a batched page-claim assessor that
 * decides what markup (if any) each on-page claim gets, and a chat loop
 * grounded in the graph via read-only tools.
 */

export type ExtensionVerdict =
  | "egregious"
  | "contested"
  | "oversimplified"
  | "noteworthy"
  | "fine";

export const EXTENSION_VERDICTS: readonly ExtensionVerdict[] = [
  "egregious",
  "contested",
  "oversimplified",
  "noteworthy",
  "fine",
];

/** One page claim as presented to the assessor. */
export interface ClaimForAssessment {
  /** Position in the input array; the model echoes it back. */
  index: number;
  on_page_text: string;
  canonical_form: string;
  /** Whether the page affirms or denies the canonical claim. */
  stance: "affirms" | "denies";
  match_confidence: number;
  graph: {
    status: string;
    confidence: number;
    reasoning_excerpt: string | null;
    subclaim_count: number;
  };
}

export interface ClaimVerdict {
  index: number;
  verdict: ExtensionVerdict;
  /** One-line reader-facing explanation, shown on hover. */
  why: string;
  confidence: number;
}

const CLAIM_VERDICT_SCHEMA = {
  type: "object" as const,
  properties: {
    index: { type: "integer", description: "The claim's index from the input" },
    verdict: {
      type: "string",
      enum: EXTENSION_VERDICTS as unknown as string[],
      description: "How the on-page phrasing relates to what the graph knows",
    },
    why: {
      type: "string",
      description:
        "One plain-language line shown to the reader on hover; name the graph's status",
    },
    confidence: {
      type: "number",
      description: "Confidence in this verdict (0.0-1.0)",
    },
  },
  required: ["index", "verdict", "why", "confidence"],
  // Required by native structured outputs' strict schema subset.
  additionalProperties: false,
};

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function assessPageClaims(
  input: Parameters<typeof assessPageClaimsImpl>[0]
): ReturnType<typeof assessPageClaimsImpl> {
  return withAgent("extension", () => assessPageClaimsImpl(input));
}

async function assessPageClaimsImpl(input: {
  pageUrl: string;
  pageTitle: string | null;
  claims: ClaimForAssessment[];
  model?: string;
}): Promise<ClaimVerdict[]> {
  if (input.claims.length === 0) return [];

  const verdicts = await completeStructuredList<ClaimVerdict>({
    messages: [
      {
        role: "user",
        content: getAssessmentPrompt({
          pageUrl: input.pageUrl,
          pageTitle: input.pageTitle,
          claims: input.claims as unknown as Array<Record<string, unknown>>,
        }),
      },
    ],
    itemSchema: CLAIM_VERDICT_SCHEMA,
    schemaName: "ClaimVerdict",
    system: getAssessorSystemPrompt(),
    model: input.model,
    maxTokens: 8192,
  });

  // Keep only well-formed verdicts for known indices; anything the model
  // dropped or mangled falls back to no markup at the service layer.
  const valid = new Set(input.claims.map((c) => c.index));
  return verdicts.filter(
    (v) =>
      valid.has(v.index) &&
      EXTENSION_VERDICTS.includes(v.verdict as ExtensionVerdict)
  );
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ExtensionChatResult {
  reply: string;
}

// Tag every LLM call in this agent for the per-token meter (#70).
export function extensionChat(
  input: Parameters<typeof extensionChatImpl>[0]
): ReturnType<typeof extensionChatImpl> {
  return withAgent("extension", () => extensionChatImpl(input));
}

async function extensionChatImpl(input: {
  messages: ChatTurn[];
  pageUrl: string | null;
  pageTitle: string | null;
  pageClaims: Array<{
    original_text: string;
    verdict: string;
    claim_id: string | null;
    canonical_form: string | null;
    status: string | null;
  }>;
  model?: string;
}): Promise<ExtensionChatResult> {
  const contextBlock = getChatContextPrompt({
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    pageClaims: input.pageClaims,
  });

  // Prepend the page context to the first user turn so the conversation
  // history stays a clean alternation of roles.
  const history = input.messages.slice();
  const first = history.findIndex((m) => m.role === "user");
  const initialMessages: MessageParam[] = history.map((m, i) => ({
    role: m.role,
    content:
      i === first ? `${contextBlock}\n\n---\n\n${m.content}` : m.content,
  }));

  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model: input.model });

  const result = await toolUseLoop({
    initialMessages,
    tools: [...getGraphToolDefinitions(), ...reportTools.definitions],
    system: getChatSystemPrompt(),
    maxTokens: 4096,
    maxIterations: 8,
    model: input.model,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      return executeGraphTool(name, toolInput);
    },
  });

  return { reply: result.content };
}
