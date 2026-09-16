/**
 * The Extractor's domain prior over a bare proposition (#469).
 *
 * At ingestion the Extractor tags each claim it pulls from a source with a
 * domain prior, and that prior is what activates the domain skills the
 * claim's administrators, the Matcher first among them, carry. Three paths
 * hand the Matcher a proposition that never passed through extraction: a
 * `propose_claim` contribution being materialized, the MCP `match_claim`
 * tool, and any caller with only text. Without a prior those runs carried
 * no domain skill however plainly mathematical the claim, while the role
 * prompt's catalog told the Matcher the skill existed.
 *
 * This is that prior, made on its own: one structured call under the
 * Extractor's system prompt (constitution, role, every skill's "For the
 * Extractor" view, which says what belongs in each domain), returning only
 * tags from the closed list. Metered as the Extractor, since it is the
 * Extractor's judgment on a one-claim document. It degrades, never fails:
 * an error yields no tags and a warning, and the run proceeds unskilled as
 * it did before, with the Steward's `set_claim_domains` still authoritative.
 */
import { completeStructured } from "../client.js";
import { getExtractorSystemPromptBlocks } from "../prompts/extractor.js";
import { knownDomains, listSkills } from "../prompts/skills.js";
import { sanitizeDomains } from "./skill-selection.js";
import { withAgent } from "../usage-context.js";
import { loadConfig } from "../../config.js";

const MAX_TOKENS = 256;

export function inferDomainPrior(input: {
  text: string;
  context?: string | null;
  model?: string;
}): Promise<string[]> {
  return withAgent("extractor", () => inferDomainPriorImpl(input));
}

async function inferDomainPriorImpl(input: {
  text: string;
  context?: string | null;
  model?: string;
}): Promise<string[]> {
  const domains = knownDomains();
  if (domains.length === 0) return [];
  const text = input.text.trim();
  if (!text) return [];

  const config = loadConfig();
  const system = getExtractorSystemPromptBlocks({ skills: listSkills() });
  const userPrompt =
    `Tag one proposition with its domains, from the closed list of domains ` +
    `that have a skill (${domains.join(", ")}). This is the domain prior ` +
    `you would attach to the claim at extraction; emit an empty list when ` +
    `none applies. Judge the subject of the proposition, not its merit.\n\n` +
    `Proposition: "${text}"` +
    (input.context?.trim() ? `\n\nContext: ${input.context.trim()}` : "");

  try {
    const result = await completeStructured<{ domains: unknown }>({
      messages: [{ role: "user", content: userPrompt }],
      schema: {
        type: "object",
        properties: {
          domains: {
            type: "array",
            items: { type: "string", enum: domains },
            description:
              "Domain tags from the closed list; an empty array when none applies.",
          },
        },
        required: ["domains"],
        additionalProperties: false,
      },
      schemaName: "DomainPrior",
      system,
      // The judgment is "what subject is this?", the Matcher's tier suffices.
      model: input.model ?? config.matcherModel,
      maxTokens: MAX_TOKENS,
    });
    return sanitizeDomains(result.domains);
  } catch (err) {
    console.warn(
      `[skills] domain prior failed; the run proceeds without domain skills: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
