/**
 * models:discover (#334 S7 / #324 "discover"): poll the providers' model
 * lists and diff them against what this codebase registers.
 *
 *   npx tsx scripts/models-discover.ts            # table
 *   npx tsx scripts/models-discover.ts --json     # machine-readable diff
 *
 * Three findings:
 *   - candidates: ids a provider lists that nothing here registers (MODELS,
 *     OPENROUTER_MODELS, the production pins in infra/lib/api-stack.ts, the
 *     pricing prefixes) — the models an adopt run (corpus:adopt) could try;
 *   - deprecated: ids we register that the provider no longer lists — the
 *     drift the per-PR guard (tests/unit/scripts/production-pins.test.ts,
 *     tests/unit/llm/model-guard.test.ts) cannot see because it checks our
 *     tables against themselves;
 *   - pricing drift: a model priced in src/llm/pricing.ts that OpenRouter
 *     also lists at a different rate (a reseller's rate — a hint to check
 *     the vendor's page, not a verdict).
 *
 * Network: GET api.anthropic.com/v1/models (needs ANTHROPIC_API_KEY),
 * api.openai.com/v1/models (needs OPENAI_API_KEY), openrouter.ai/api/v1/models
 * (public). A provider without a key is reported as not checked rather than
 * failing the run. No LLM call is made.
 *
 * This opens no issues. The operator's next step for a candidate worth
 * trying is `npm run corpus:adopt -- --agent=<agent> --model=<id>`; for a
 * deprecation, edit the source the row names; for pricing drift, check the
 * vendor's list price and update pricing.ts. An automated version would run
 * this weekly in a workflow and `gh issue create` one issue per new
 * candidate titled "model candidate: <id>", deduplicated by title.
 */
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, OPENROUTER_MODELS } from "../src/llm/models.js";
import { hasExplicitRates, ratesForModel } from "../src/llm/pricing.js";
import { productionPins } from "./corpus/production-pins.js";
import {
  diffModels,
  parsePricingPrefixes,
  renderDiscovery,
  type AnthropicModelEntry,
  type OpenAiModelEntry,
  type OpenRouterModelEntry,
  type ProviderLists,
  type RegisteredModel,
} from "./models-discover-lib.js";

loadDotenv();

const here = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(here, "..", "src", "llm", "pricing.ts");

/** Everything this codebase declares a model id for, with where. */
export function registeredModels(): RegisteredModel[] {
  const out: RegisteredModel[] = [];
  for (const [key, id] of Object.entries(MODELS)) out.push({ id, source: `MODELS.${key}` });
  for (const [key, id] of Object.entries(OPENROUTER_MODELS)) out.push({ id, source: `OPENROUTER_MODELS.${key}` });
  for (const pin of productionPins()) out.push({ id: pin.model, source: `pin ${pin.envVar}` });
  for (const prefix of parsePricingPrefixes(readFileSync(PRICING_PATH, "utf8"))) out.push({ id: prefix, source: "pricing prefix" });
  return out;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function fetchLists(): Promise<{ lists: ProviderLists; notes: string[] }> {
  const notes: string[] = [];
  const lists: ProviderLists = {};
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const all: AnthropicModelEntry[] = [];
      let after: string | null = null;
      // Paginated: has_more / last_id.
      for (let page = 0; page < 20; page++) {
        const url: string = `https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${after}` : ""}`;
        const body: { data: AnthropicModelEntry[]; has_more?: boolean; last_id?: string | null } = await getJson(url, {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        });
        all.push(...body.data);
        if (!body.has_more || !body.last_id) break;
        after = body.last_id;
      }
      lists.anthropic = all;
    } catch (err) {
      notes.push(`anthropic: ${err instanceof Error ? err.message : err}`);
    }
  } else notes.push("anthropic: ANTHROPIC_API_KEY not set — not checked");

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const body = await getJson<{ data: OpenAiModelEntry[] }>("https://api.openai.com/v1/models", { Authorization: `Bearer ${openaiKey}` });
      lists.openai = body.data;
    } catch (err) {
      notes.push(`openai: ${err instanceof Error ? err.message : err}`);
    }
  } else notes.push("openai: OPENAI_API_KEY not set — not checked");

  try {
    const body = await getJson<{ data: OpenRouterModelEntry[] }>("https://openrouter.ai/api/v1/models", {});
    lists.openrouter = body.data;
  } catch (err) {
    notes.push(`openrouter: ${err instanceof Error ? err.message : err}`);
  }
  return { lists, notes };
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const { lists, notes } = await fetchLists();
  const diff = diffModels({
    registry: registeredModels(),
    providers: lists,
    ratesFor: (id) => (hasExplicitRates(id) ? ratesForModel(id) : null),
  });
  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), notes, ...diff }, null, 2));
    return;
  }
  console.log(`\n=== model discovery — ${new Date().toISOString().slice(0, 10)} ===\n`);
  console.log(renderDiscovery(diff));
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(
    "\n  next: a candidate worth trying → npm run corpus:adopt -- --agent=<agent> --model=<id>;" +
      "\n        a deprecation → edit the source named; pricing drift → check the vendor's list price, then src/llm/pricing.ts.\n"
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
