/**
 * Who built the model behind a verdict, and whether the claim is about them
 * (#534).
 *
 * The graph's administrators are models, and a model's developer can be the
 * subject of the claims it assesses: Anthropic's safety practices assessed by
 * a Claude Steward, say. Constitution §17 asks an admin to correct for biases
 * inherited from training; this module does the part that needs no trust in
 * the admin at all, which is saying so. When a claim names the developer of
 * the model that assessed it, the claim page and the API disclose it, with
 * the names that matched, so a reader can weigh the verdict knowing that.
 *
 * Disclosure only. Nothing here changes how a claim is assessed or by whom,
 * and a match is not a finding that the verdict is biased.
 *
 * The match is deliberately mechanical: computed from the recorded model id
 * and the claim's own words (and its tags), never declared by the agent
 * whose conflict it is, in the same spirit as the funding stamp (§19). It
 * leans inclusive: a claim that merely mentions the developer is flagged as
 * well as one about it, because a disclosure a reader can discount costs less
 * than a conflict nobody mentioned. It misses claims that describe a
 * developer without naming it; the canonical form is meant to stand alone
 * (§3), which keeps those rare.
 *
 * Dependency-free so routes, services and scripts can all import it.
 */

export interface ModelDeveloper {
  /** Stable key, e.g. "anthropic". */
  key: string;
  /** Reader-facing name, e.g. "Anthropic". */
  name: string;
}

interface DeveloperEntry extends ModelDeveloper {
  /**
   * Prefixes of the vendor segment in an OpenRouter "vendor/model" id, and
   * of bare ids served direct.
   */
  vendors: readonly string[];
  idPattern?: RegExp;
  /**
   * Names that, appearing in a claim, make the developer its subject. Case
   * sensitive where the lowercase word is ordinary English ("grok", "meta",
   * "llama"); each pattern excludes the obvious non-developer uses it can.
   */
  names: readonly RegExp[];
}

// Claude followed by a capitalised word is usually a person (Claude Shannon,
// Claude Monet), unless the word is one of the model families.
const CLAUDE =
  /\bClaude\b(?!\s+(?!(?:Opus|Sonnet|Haiku|Fable|Code|Instant)\b)[A-Z][a-z])/;

const DEVELOPERS: readonly DeveloperEntry[] = [
  {
    key: "anthropic",
    name: "Anthropic",
    vendors: ["anthropic"],
    // Direct ids and Bedrock/Vertex-style ones ("us.anthropic.claude-…").
    idPattern: /^(claude-|([a-z]{2,4}\.)?anthropic\.)/,
    names: [/\banthropic\b/i, CLAUDE],
  },
  {
    key: "openai",
    name: "OpenAI",
    vendors: ["openai"],
    idPattern: /^(gpt-|o\d|chatgpt)/,
    names: [/\bopen ?ai\b/i, /\bchatgpt\b/i, /\bgpt-?\d/i],
  },
  {
    key: "google",
    name: "Google",
    vendors: ["google"],
    idPattern: /^(gemini-|gemma-)/,
    names: [/\bgoogle\b/i, /\bdeepmind\b/i, /\bGemini\b/, /\bGemma\b/],
  },
  {
    key: "zhipu",
    name: "Zhipu AI",
    vendors: ["z-ai", "zhipu", "thudm"],
    names: [/\bzhipu\b/i, /\bz\.ai\b/i, /\bGLM-?\d/],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    vendors: ["deepseek"],
    names: [/\bdeepseek\b/i],
  },
  {
    key: "alibaba",
    name: "Alibaba",
    vendors: ["qwen", "alibaba"],
    names: [/\balibaba\b/i, /\bqwen\b/i],
  },
  {
    key: "meta",
    name: "Meta",
    vendors: ["meta-llama", "meta"],
    names: [/\bMeta\b(?!-)/, /\bLlama ?\d/, /\bfacebook ai\b/i],
  },
  {
    key: "xai",
    name: "xAI",
    vendors: ["x-ai", "xai"],
    names: [/\bxAI\b/, /\bGrok\b/],
  },
  {
    key: "mistral",
    name: "Mistral AI",
    vendors: ["mistralai", "mistral"],
    names: [/\bmistral ai\b/i, /\bMistral (?:Large|Medium|Small)\b/, /\bMistral ?\d/],
  },
  {
    key: "moonshot",
    name: "Moonshot AI",
    vendors: ["moonshotai", "moonshot"],
    names: [/\bmoonshot ai\b/i, /\bKimi\b/],
  },
];

/**
 * The developer of a recorded model id, or null when the id is unknown. An
 * OpenRouter "vendor/model" id resolves by its vendor; a bare id by its shape.
 */
export function modelDeveloper(modelId: string | null | undefined): ModelDeveloper | null {
  const id = modelId?.trim().toLowerCase();
  if (!id) return null;
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? id.slice(0, slash).replace(/^~/, "") : null;
  for (const d of DEVELOPERS) {
    if (vendor !== null ? d.vendors.includes(vendor) : d.idPattern?.test(id)) {
      return { key: d.key, name: d.name };
    }
  }
  return null;
}

/** The developer's names found in `texts`, as they appear (first of each). */
function namesFound(entry: DeveloperEntry, texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of entry.names) {
    for (const text of texts) {
      const m = pattern.exec(text);
      if (m) {
        if (!found.some((f) => f.toLowerCase() === m[0].toLowerCase())) found.push(m[0]);
        break;
      }
    }
  }
  return found;
}

export interface DeveloperDisclosure {
  /** The developer of the assessing model, which the claim names. */
  developer: string;
  /** The raw id of the assessing model. */
  model: string;
  /** The words in the claim (or its tags) that name the developer. */
  matched: string[];
}

/**
 * The disclosure owed on a verdict, or null when none is: the assessing
 * model's developer is named in the claim's canonical form or in one of its
 * tags. Unknown or missing model ids disclose nothing (there is no developer
 * to name), which is also how legacy assessments without a model degrade.
 */
export function developerDisclosure(
  model: string | null | undefined,
  claimText: string,
  tagNames: readonly string[] = []
): DeveloperDisclosure | null {
  const developer = modelDeveloper(model);
  if (!developer || !model) return null;
  const entry = DEVELOPERS.find((d) => d.key === developer.key)!;
  const matched = namesFound(entry, [claimText, ...tagNames]);
  if (matched.length === 0) return null;
  return { developer: developer.name, model, matched };
}
