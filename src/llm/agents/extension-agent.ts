import { completeStructuredList } from "../client.js";
import {
  getAssessorSystemPrompt,
  getAssessmentPrompt,
} from "../prompts/extension-agent.js";
import { withAgent } from "../usage-context.js";
import type { InstanceStance } from "../../schemas/common.js";

/**
 * The Extension Agent (issue #72) — lives with the browser extension, never
 * edits the graph. A batched page-claim assessor that decides what markup
 * (if any) each on-page claim gets. Its chat half became the graph chat
 * (src/llm/agents/graph-chat.ts, #312), which still serves the extension's
 * popup in page mode alongside the website's ask surfaces.
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
  /** Whether the page affirms, denies, or merely poses the canonical claim. */
  stance: InstanceStance;
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
