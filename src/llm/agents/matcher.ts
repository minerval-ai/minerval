import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { getMatcherSystemPrompt, getMatchingPrompt } from "../prompts/matcher.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { findSimilarClaims } from "../../services/search-service.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

export interface MatchDecision {
  is_match: boolean;
  matched_claim_id: string | null;
  new_canonical_form: string | null;
  /**
   * Whether this source asserts the claim as canonically stated ("affirms") or
   * asserts its negation/contrary ("denies"). Lets a claim and its denial share
   * one canonical node while preserving which side each source takes.
   */
  instance_stance: "affirms" | "denies";
  confidence: number;
  reasoning: string;
  alternative_matches: string[];
  relationship_notes: string | null;
}

const MATCH_DECISION_SCHEMA = {
  type: "object" as const,
  properties: {
    is_match: { type: "boolean", description: "Whether the claim matches an existing claim (including its negation/counterpart)" },
    matched_claim_id: { type: ["string", "null"], description: "ID of the matched claim if is_match is True" },
    new_canonical_form: { type: ["string", "null"], description: "Proposed canonical form if is_match is False" },
    instance_stance: { type: "string", enum: ["affirms", "denies"], description: "Whether this source asserts the canonical claim (affirms) or its negation/contrary (denies)" },
    confidence: { type: "number", description: "Confidence in the matching decision (0.0-1.0)" },
    reasoning: { type: "string", description: "Detailed explanation of the decision" },
    alternative_matches: { type: "array", items: { type: "string" }, description: "IDs of other claims considered" },
    relationship_notes: { type: ["string", "null"], description: "Notes on relationships to other claims" },
  },
  required: ["is_match", "confidence", "reasoning", "instance_stance"],
};

/**
 * The agentic Matcher is the single decider of claim identity (issue #25).
 *
 * It is a tool-use loop armed with `search_similar_claims`. Embedding similarity
 * is *retrieval*, not decision: the search is NOT gated at a high threshold, and
 * the matcher is expected to issue multiple queries — the claim, rewordings, and
 * the negation — before concluding a claim is novel. The final judgment ("same
 * proposition? counterpart? specification?") is the model's, reported via the
 * `submit_match_decision` tool.
 *
 * Every new claim — top-level and subclaim — flows through this one matcher.
 */
// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function matchClaim(
  input: Parameters<typeof matchClaimImpl>[0]
): ReturnType<typeof matchClaimImpl> {
  return withAgent("matcher", () => matchClaimImpl(input));
}

async function matchClaimImpl(input: {
  extractedText: string;
  proposedCanonical: string;
  /**
   * A claim id to exclude from search results (e.g. the parent when matching a
   * subclaim, so a claim can't match itself). Optional.
   */
  excludeClaimId?: string;
  model?: string;
}): Promise<MatchDecision> {
  const config = loadConfig();
  const userPrompt = getMatchingPrompt(input.extractedText, input.proposedCanonical);

  const searchTool: Tool = {
    name: "search_similar_claims",
    description:
      "Search existing claims by semantic similarity. Returns the top matches " +
      "ranked by similarity, above only a low floor that trims noise; results " +
      "are retrieval for your judgment, not a decision. A true counterpart can " +
      "score low or miss the floor under one framing, so call this multiple " +
      "times with different framings of the claim (its wording, paraphrases, " +
      "and especially its NEGATION) before concluding the claim is novel.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "A claim phrasing to search for" },
      },
      required: ["query"],
    },
  };
  const submitTool: Tool = {
    name: "submit_match_decision",
    description: "Submit the final claim-identity decision once you have searched enough.",
    input_schema: MATCH_DECISION_SCHEMA as Tool["input_schema"],
  };

  let finalResult: MatchDecision | null = null;
  const model = input.model ?? config.matcherModel;
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  await toolUseLoop({
    initialMessages: [{ role: "user", content: userPrompt }],
    tools: [searchTool, submitTool, ...reportTools.definitions],
    system: getMatcherSystemPrompt(),
    model,
    maxTokens: 4096,
    maxIterations: 8,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      if (name === "submit_match_decision") {
        finalResult = toolInput as unknown as MatchDecision;
        return JSON.stringify({ success: true });
      }
      if (name === "search_similar_claims") {
        const query = String(toolInput.query ?? "");
        let results: Array<{ id: string; text: string; similarity_score: number }> = [];
        try {
          const embedding = await generateEmbedding(query);
          results = await findSimilarClaims(embedding, {
            limit: config.matchingTopK,
            // Retrieval, not decision: keep a low floor so counterparts and
            // alternate framings that embed far apart still surface (#25).
            minSimilarity: 0.4,
            excludeId: input.excludeClaimId,
          });
        } catch (err) {
          return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
        }
        return JSON.stringify({
          query,
          count: results.length,
          results: results.map((r) => ({
            id: r.id,
            canonical_form: r.text,
            score: Number(r.similarity_score.toFixed(3)),
          })),
        });
      }
      return `Error: Unknown tool: ${name}`;
    },
    onFinalTool: (name, toolInput) => {
      if (name === "submit_match_decision") {
        finalResult = toolInput as unknown as MatchDecision;
        return finalResult;
      }
      return null;
    },
  });

  if (finalResult) return finalResult;

  // The matcher never submitted a decision (e.g. hit the iteration cap). Treat
  // the claim as novel so ingestion proceeds; the steward can re-match later.
  return {
    is_match: false,
    matched_claim_id: null,
    new_canonical_form: input.proposedCanonical,
    instance_stance: "affirms",
    confidence: 0.3,
    reasoning:
      "Matcher did not submit a decision within the search budget; defaulting to a new claim.",
    alternative_matches: [],
    relationship_notes: null,
  };
}
