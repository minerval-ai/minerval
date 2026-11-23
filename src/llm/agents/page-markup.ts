/**
 * The page markup (#72, #1132): the Assistant's verdicts on how a page
 * words the claims the graph holds, which the browser extension draws.
 *
 * This was a separate agent, the Extension Agent, with a prompt of its own;
 * a different agent, the Assistant, then talked to the reader about marks
 * it had not made and could not explain. Now one agent does both. The
 * verdict scale is part of the Assistant's prompt (prompts/assistant.ts,
 * PAGE_VERDICTS), given to it here and in the extension's chat.
 *
 * It is still not an Assistant turn. Markup runs on every analyzed page,
 * with nobody in a conversation, and a reader waits on it: so it stays one
 * structured call with no tools, on a model set for it
 * (ASSISTANT_MARKUP_MODEL), paid from the page analysis's own charge
 * (extension_analysis) and not from a conversation's bill. The prompt's
 * markup section says what of the Assistant's role is absent in the call.
 *
 * The call reads a page its reader has open. Its one caller, the page
 * analysis (services/extension-service.ts), runs the whole pipeline
 * untraced(), which keeps it off a best-effort log; in record mode it is
 * logged like any run, private to the reader. The Extension Agent was kept
 * off the log by its name, whoever called it. That rule went with the name:
 * the Assistant's runs are logged, so a new caller of this function decides
 * for itself whether what it passes is a reader's own page.
 */
import { completeStructuredList } from "../client.js";
import {
  getAssistantSystemPrompt,
  getPageMarkupPrompt,
  PAGE_MARKUP_SECTION,
} from "../prompts/assistant.js";
import { withAgent } from "../usage-context.js";
import type { MatchedInstanceStance } from "../../schemas/common.js";
import type { NodeKind, QuantityEstimate, QuantityUnit, QuestionStanding } from "../../schemas/kinds.js";

// "contested" here is a page verdict (the page states an unsettled claim as
// settled), not a claim status; the graph's statuses are the evidential
// ladder in assessmentStatusEnum (#524). The token is kept for wire
// compatibility with installed extensions.
export type PageVerdict =
  | "egregious"
  | "contested"
  | "oversimplified"
  | "noteworthy"
  | "fine";

export const PAGE_VERDICTS: readonly PageVerdict[] = [
  "egregious",
  "contested",
  "oversimplified",
  "noteworthy",
  "fine",
];

/**
 * A node's state in the graph, as a verdict on a page's wording is judged
 * from it. The markup call is given this for each matched claim, and
 * get_page_claims (mcp/server.ts) returns the same shape to a conversation.
 */
export interface PageClaimGraphState {
  /**
   * claim, quantity or question. Only a claim carries a status; a
   * quantity's assessment is its estimate and a question's its standing
   * (#680).
   */
  kind: NodeKind;
  /** A claim's status; "unknown" when no verdict is recorded, or for another kind. */
  status: string;
  /** Null when the node has not been assessed: there is no confidence to give. */
  confidence: number | null;
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
}

/** One page claim as presented for a verdict. */
export interface ClaimForAssessment {
  /** Position in the input array; the model echoes it back. */
  index: number;
  on_page_text: string;
  canonical_form: string;
  /** Whether the page affirms, denies, or merely poses the canonical claim. */
  stance: MatchedInstanceStance;
  match_confidence: number;
  graph: PageClaimGraphState;
}

export interface ClaimVerdict {
  index: number;
  verdict: PageVerdict;
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
      enum: PAGE_VERDICTS as unknown as string[],
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

/** The Assistant's whole setup for the call: its prompt, then the markup section. */
export function getPageMarkupSystemPrompt(): string {
  return getAssistantSystemPrompt() + PAGE_MARKUP_SECTION;
}

// The call is the Assistant's: it is metered and logged under that agent.
export function assessPageClaims(
  input: Parameters<typeof assessPageClaimsImpl>[0]
): ReturnType<typeof assessPageClaimsImpl> {
  return withAgent("assistant", () => assessPageClaimsImpl(input));
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
        content: getPageMarkupPrompt({
          pageUrl: input.pageUrl,
          pageTitle: input.pageTitle,
          claims: input.claims as unknown as Array<Record<string, unknown>>,
        }),
      },
    ],
    itemSchema: CLAIM_VERDICT_SCHEMA,
    schemaName: "ClaimVerdict",
    system: getPageMarkupSystemPrompt(),
    model: input.model,
    maxTokens: 8192,
  });

  // Keep only well-formed verdicts for known indices; anything the model
  // dropped or mangled falls back to no markup at the service layer.
  const valid = new Set(input.claims.map((c) => c.index));
  return verdicts.filter(
    (v) =>
      valid.has(v.index) &&
      PAGE_VERDICTS.includes(v.verdict as PageVerdict)
  );
}
