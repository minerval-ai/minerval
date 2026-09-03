import { completeStructuredList } from "../client.js";
import {
  getExtractorSystemPromptBlocks,
  getExtractionPrompt,
} from "../prompts/extractor.js";
import { knownDomains, listSkills } from "../prompts/skills.js";
import { withAgent, withSkills } from "../usage-context.js";
import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";

export interface ExtractedClaim {
  original_text: string;
  context: string | null;
  proposed_canonical_form: string;
  claim_type: string;
  confidence: number;
  /** Provisional importance prior (0-1); the Steward later overrides it. */
  importance: number;
  /** Provisional contestation prior (0-1); the Steward later overrides it (#172). */
  contestation: number;
  source_location: string | null;
  /**
   * Domain tags from the closed list of domains that have a skill (a prior;
   * the Steward's set_claim_domains supersedes it). Selects which domain
   * skills the claim's administrators carry.
   */
  domains: string[];
}

/**
 * The structured-output schema for one extracted claim. Built per call so the
 * `domains` enum is the closed list of domains the skills define at run time.
 */
export function getExtractedClaimSchema(): Record<string, unknown> {
  const domains = knownDomains();
  return {
    ...EXTRACTED_CLAIM_SCHEMA,
    properties: {
      ...EXTRACTED_CLAIM_SCHEMA.properties,
      domains: {
        type: "array",
        // An empty enum is not a valid schema; with no skills the list is
        // open, and the ingest path drops anything outside the known set.
        items: domains.length > 0 ? { type: "string", enum: domains } : { type: "string" },
        description:
          "Domain tags from the closed list of domains that have a skill" +
          (domains.length > 0 ? ` (${domains.join(", ")})` : "") +
          "; an empty array when none applies. A prior the Steward confirms or corrects.",
      },
    },
    required: [...EXTRACTED_CLAIM_SCHEMA.required, "domains"],
  };
}

const EXTRACTED_CLAIM_SCHEMA = {
  type: "object" as const,
  properties: {
    original_text: { type: "string", description: "The exact text from the document" },
    context: { type: ["string", "null"], description: "Surrounding text for disambiguation" },
    proposed_canonical_form: { type: "string", description: "The shortest neutral statement of the proposition as it is actually debated, about fifteen words, stated at the precision the discourse debates it" },
    claim_type: { type: "string", description: "One of: empirical_verifiable, empirical_derived, definitional, evaluative, causal, normative" },
    confidence: { type: "number", description: "Confidence this is a valid claim (0.0-1.0)" },
    importance: { type: "number", description: "Provisional importance (0.0-1.0): how much it is worth getting this claim right (roughly consequence-if-wrong × liveness), from document salience, contestedness, and discourse reach. Settled/uncontested facts score LOW even if load-bearing. A prior the Steward will revise; distinct from confidence." },
    contestation: { type: "number", description: "Provisional contestation (0.0-1.0): how live this proposition is in the discourse at large, disputed or actively consulted, on its own — ~0 for a settled fact stated in passing, ~1 for an actively argued crux with credible parties on both sides. The liveness half of the importance formula recorded separately; a prior the Steward will revise." },
    source_location: { type: ["string", "null"], description: "Where in the document this was found" },
  },
  // Native structured outputs require additionalProperties: false and a
  // complete required array on every object; the nullable fields (context,
  // source_location) are now required but may be null.
  required: ["original_text", "context", "proposed_canonical_form", "claim_type", "confidence", "importance", "contestation", "source_location"],
  additionalProperties: false,
};

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function extractClaims(
  input: Parameters<typeof extractClaimsImpl>[0]
): ReturnType<typeof extractClaimsImpl> {
  return withAgent("extractor", () => extractClaimsImpl(input));
}

async function extractClaimsImpl(input: {
  content: string;
  sourceType?: string;
  additionalContext?: string;
  model?: string;
  /** Cap the number of claims extracted (0 = unlimited). Bounds graph fan-out. */
  maxClaims?: number;
}): Promise<ExtractedClaim[]> {
  const config = loadConfig();
  const userPrompt =
    getExtractionPrompt(input.sourceType, input.additionalContext, input.maxClaims) +
    input.content;
  // The Extractor always carries every skill's "For the Extractor" view and
  // the closed list of domain names (docs/mathematics.md §3.4): it cannot see
  // the graph, so the domain prior it emits is what selects the skills the
  // claim's administrators later carry. Funding never selects this prompt.
  const skills = listSkills();
  // One cached block for the constitution and role, plus one per skill.
  const system = getExtractorSystemPromptBlocks({ skills });
  const run = (model: string | undefined) =>
    completeStructuredList<ExtractedClaim>({
      messages: [{ role: "user", content: userPrompt }],
      itemSchema: getExtractedClaimSchema(),
      schemaName: "ExtractedClaim",
      system,
      ...(model ? { model } : {}),
      maxTokens: 16384,
    });

  // The chosen tier decides which propositions become claims and how they are
  // worded, so it is worth the strongest model available. But a REFUSAL is not
  // a judgment about the document's claims — it is the model declining the
  // subject matter, and this graph's live work includes a virology cluster
  // Fable has refused before (#78). LlmRefusalError means the server-side
  // Opus fallback refused too, so the retry must leave the family.
  //
  // Without this, a mandate that funds "ingest this pathogen paper" pays for
  // the fetch and gets a cancelled ingest with no claims and no explanation.
  const primary = input.model ?? config.extractorModel;
  const claims = await withSkills(
    skills.map((s) => s.name),
    async (): Promise<ExtractedClaim[]> => {
      try {
        return await run(primary);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        const fallback = config.extractorFallbackModel;
        if (!fallback || fallback === primary) throw err;
        console.warn(
          `[extractor] ${primary} refused the document` +
            (err.category ? ` (category: ${err.category})` : "") +
            `; retrying extraction on ${fallback}.`
        );
        return await run(fallback);
      }
    }
  );

  // Hard cap as a safety net in case the model exceeds the requested limit.
  return input.maxClaims && input.maxClaims > 0
    ? claims.slice(0, input.maxClaims)
    : claims;
}
