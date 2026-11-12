/**
 * Prices a deployment states for itself: MODEL_PRICES.
 *
 * Cost is metered in dollars, and a call is priced from the rate table in
 * pricing.ts unless its provider reports the cost itself. A deployment can
 * state a price here for a model the table does not know, or its own price
 * for one the table does (a negotiated rate, for instance). A stated price
 * wins over the table.
 *
 * MODEL_PRICES is a JSON list, one object per model:
 *
 *   [{ "model": "gpt-oss-120b",
 *      "inputUsdPerMtok": 0.5,
 *      "outputUsdPerMtok": 1.5 }]
 *
 *  - model: a model ID, or the start of one, matched the way the rate table
 *    matches: a dated snapshot resolves to its family, and the longest
 *    match wins.
 *  - inputUsdPerMtok, outputUsdPerMtok: what a call costs, in US dollars
 *    per million tokens. Both are required; a deployment that counts a
 *    model as free writes 0 and says so.
 *  - cacheReadMultiplier, cacheWriteMultiplier: optional. What a cached
 *    read and a cache write cost, as a multiple of the input price. Left
 *    out, they are the table's for a model the table knows, and 0.1 and
 *    1.25 otherwise.
 *
 * The field names are the ones MODEL_ENDPOINTS uses for an endpoint's
 * prices, so the two settings read alike.
 *
 * This module imports nothing, so src/config.ts can parse the setting at
 * load time.
 */

export interface StatedModelPrice {
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadMultiplier?: number;
  cacheWriteMultiplier?: number;
}

const EXAMPLE = '[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';

const FIELDS = [
  "model",
  "inputUsdPerMtok",
  "outputUsdPerMtok",
  "cacheReadMultiplier",
  "cacheWriteMultiplier",
];

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** What a MODEL_PRICES entry for one model looks like, for a message that says how to set one. */
export function modelPriceExample(model: string): string {
  return JSON.stringify([{ model, inputUsdPerMtok: 0.5, outputUsdPerMtok: 1.5 }]);
}

/**
 * A MODEL_PRICES value as the prices it states, with everything wrong with
 * it in words an installer can act on. Empty in, nothing out.
 */
export function parseModelPrices(raw: string): {
  prices: StatedModelPrice[];
  problems: string[];
} {
  const text = raw.trim();
  if (!text) return { prices: [], problems: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      prices: [],
      problems: [
        `MODEL_PRICES is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
          `It is a JSON list with one object per model, for example ${EXAMPLE}.`,
      ],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      prices: [],
      problems: [`MODEL_PRICES must be a JSON list with one object per model, for example ${EXAMPLE}.`],
    };
  }

  const prices: StatedModelPrice[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  parsed.forEach((entry, i) => {
    const at = `MODEL_PRICES entry ${i + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} is not an object. Each entry looks like ${EXAMPLE.slice(1, -1)}.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const model = typeof e.model === "string" ? e.model.trim() : "";
    const who = model ? `${at} ("${model}")` : at;
    const before = problems.length;

    const unknown = Object.keys(e).filter((k) => !FIELDS.includes(k));
    if (unknown.length > 0) {
      problems.push(
        `${who} has ${unknown.map((k) => `"${k}"`).join(", ")}, which ` +
          `${unknown.length === 1 ? "is not a field" : "are not fields"} of a price. ` +
          `The fields are: ${FIELDS.join(", ")}.`
      );
    }
    if (!model) {
      problems.push(`${at} needs a "model": the model ID the price is for, or the start of one.`);
    } else if (seen.has(model)) {
      problems.push(`MODEL_PRICES states a price for "${model}" more than once. Each model needs one entry.`);
    }
    if (!isPrice(e.inputUsdPerMtok) || !isPrice(e.outputUsdPerMtok)) {
      problems.push(
        `${who} needs "inputUsdPerMtok" and "outputUsdPerMtok": what a call to the model costs, ` +
          `in US dollars per million tokens, as numbers of 0 or more.`
      );
    }
    for (const field of ["cacheReadMultiplier", "cacheWriteMultiplier"] as const) {
      if (e[field] !== undefined && !isPrice(e[field])) {
        problems.push(
          `${who} has a "${field}" that is not a number of 0 or more. It is what a cached ` +
            `${field === "cacheReadMultiplier" ? "read" : "write"} costs as a multiple of the input price.`
        );
      }
    }

    if (problems.length > before) return;
    seen.add(model);
    prices.push({
      model,
      inputUsdPerMtok: e.inputUsdPerMtok as number,
      outputUsdPerMtok: e.outputUsdPerMtok as number,
      ...(e.cacheReadMultiplier !== undefined ? { cacheReadMultiplier: e.cacheReadMultiplier as number } : {}),
      ...(e.cacheWriteMultiplier !== undefined ? { cacheWriteMultiplier: e.cacheWriteMultiplier as number } : {}),
    });
  });

  return { prices, problems };
}
