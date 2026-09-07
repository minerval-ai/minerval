/**
 * The Matcher exposed as a synchronous tool.
 *
 * The agentic Matcher is the single decider of claim identity (#25). Agents that
 * are about to introduce a claim into the graph — the Claim Steward when it adds
 * a subclaim, the Curator when it reconciles — call `match_claim` to ask "does
 * this proposition already exist (as itself, a rewording, or its negation)?"
 * before creating a duplicate. It is a nested synchronous sub-agent call: the
 * caller blocks on the Matcher's decision, because it needs the answer to decide
 * whether to link or create.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { matchClaim } from "../agents/matcher.js";

export function getMatcherToolDefinition(): Tool {
  return {
    name: "match_claim",
    description:
      "Check whether a proposition already exists in the graph before creating " +
      "it as a new claim. The Matcher searches the graph itself (multiple " +
      "framings, including the negation) and decides identity: a claim and its " +
      "denial/counterpart are the SAME node. Always call this before adding a " +
      "subclaim; if it returns a match, link that existing claim instead of " +
      "minting a duplicate.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The proposition (claim text) to check for existence",
        },
        exclude_claim_id: {
          type: "string",
          description:
            "A claim id to exclude from the search (e.g. the parent claim, so a " +
            "subclaim can't match itself). Optional.",
        },
      },
      required: ["text"],
    },
  };
}

export async function executeMatcherTool(
  toolName: string,
  input: Record<string, unknown>,
  // The domains the caller knows (its own claim's tags): the Matcher
  // receives the matching skills' view of identity in that domain.
  opts: { domains?: readonly string[] } = {}
): Promise<string> {
  if (toolName !== "match_claim") {
    return `Error: Unknown matcher tool: ${toolName}`;
  }
  try {
    const text = String(input.text ?? "");
    if (!text.trim()) {
      return JSON.stringify({ error: "match_claim requires non-empty `text`" });
    }
    const decision = await matchClaim({
      extractedText: text,
      proposedCanonical: text,
      excludeClaimId: input.exclude_claim_id
        ? String(input.exclude_claim_id)
        : undefined,
      ...(opts.domains && opts.domains.length > 0
        ? { domains: [...opts.domains] }
        : {}),
    });
    return JSON.stringify({
      is_match: decision.is_match,
      matched_claim_id: decision.matched_claim_id,
      // For a counterpart/negation match the stance is "denies": the matched
      // node is the same claim stated in the opposite direction.
      instance_stance: decision.instance_stance,
      new_canonical_form: decision.new_canonical_form,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      // The near-misses the Matcher weighed and its notes on how they relate —
      // exactly the signal the caller needs to decide link-vs-escalate, so
      // don't strip them (#100). Inspect candidates with get_claim_details.
      alternative_matches: decision.alternative_matches ?? [],
      relationship_notes: decision.relationship_notes ?? null,
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
