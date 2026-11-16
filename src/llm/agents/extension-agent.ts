import { completeStructuredList } from "../client.js";
import {
  getAssessorSystemPrompt,
  getAssessmentPrompt,
} from "../prompts/extension-agent.js";
import { withAgent } from "../usage-context.js";
import type { MatchedInstanceStance } from "../../schemas/common.js";
import type { NodeKind, QuantityEstimate, QuantityUnit, QuestionStanding } from "../../schemas/kinds.js";

/**
 * The Extension Agent (issue #72) — lives with the browser extension, never
 * edits the graph: a batched page-claim assessor that decides what markup
 * (if any) each on-page claim gets. The extension's chat is the Assistant
 * (agents/assistant.ts).
 */

// "contested" here is a page verdict (the page states an unsettled claim as
// settled), not a claim status; the graph's statuses are the evidential
// ladder in assessmentStatusEnum (#524). The token is kept for wire
// compatibility with installed extensions.
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
  stance: MatchedInstanceStance;
  match_confidence: number;
  graph: {
    /**
     * claim, quantity or question. Only a claim carries a status; a
     * quantity's assessment is its estimate and a question's its standing
     * (#680).
     */
    kind: NodeKind;
    /** A claim's status; "unknown" when no verdict is recorded, or for another kind. */
    status: string;
    confidence: number;
    /** The reader-facing summary of the current assessment, estimate or standing. */
    summary: string | null;
    /** What a quantity measures, of what population, in what unit. */
    definition?: {
      measures: string;
      population: string | null;
      conditions: string | null;
      unit: QuantityUnit;
    } | null;
    /** A quantity's current estimate; null when none is recorded. */
    estimate?: QuantityEstimate | null;
    /** A question's current standing. */
    standing?: QuestionStanding | null;
    /**
     * Set only where more than one judgment of the node is in force for the
     * asker: one sentence saying how many, and that what is given above is
     * the most recently made (judgment-version-service.ts).
     */
    several_judgments?: string;
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
