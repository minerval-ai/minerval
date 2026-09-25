import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  coveredByPrefix,
  diffModels,
  isCandidateId,
  openRouterRates,
  parsePricingPrefixes,
  providerOf,
  renderDiscovery,
  vendorStripped,
  type RegisteredModel,
} from "../../../scripts/models-discover-lib.js";
import { hasExplicitRates, ratesForModel } from "../../../src/llm/pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
const PRICING = join(here, "../../../src/llm/pricing.ts");

// Fixture responses in each provider's shape.
const anthropic = [
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-05-01T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z" },
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-01T00:00:00Z" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-06-01T00:00:00Z" },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-10T00:00:00Z" },
];
const openai = [
  { id: "gpt-5-mini", owned_by: "openai", created: 1_754_000_000 },
  { id: "gpt-5.7", owned_by: "openai", created: 1_758_000_000 },
  { id: "text-embedding-3-small", owned_by: "openai", created: 1_700_000_000 },
  { id: "gpt-4o-audio-preview", owned_by: "openai", created: 1_720_000_000 },
];
const openrouter = [
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", created: 1_755_000_000, pricing: { prompt: "0.00000015", completion: "0.0000005" } },
  { id: "z-ai/glm-5.4-flash", name: "GLM 5.4 Flash", created: 1_758_100_000, pricing: { prompt: "0.0000002", completion: "0.0000006" } },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", created: 1_750_000_000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", created: 1_750_000_000, pricing: { prompt: "0.0000012", completion: "0.000005" } },
  { id: "openai/gpt-5-mini", name: "GPT-5 mini", created: 1_750_000_000, pricing: { prompt: "0.00000025", completion: "0.000002" } },
  { id: "meta-llama/llama-5-70b:free", name: "free", created: 1_758_000_000, pricing: { prompt: "0", completion: "0" } },
  { id: "someone/obscure-model", name: "noise", created: 1_758_000_000, pricing: { prompt: "0.000001", completion: "0.000001" } },
];

const registry: RegisteredModel[] = [
  { id: "claude-fable-5-1", source: "MODELS.fable" },
  { id: "claude-opus-4-8", source: "MODELS.opus" },
  { id: "claude-sonnet-5", source: "MODELS.sonnet" },
  { id: "claude-haiku-4-5-20251001", source: "MODELS.haiku" },
  { id: "z-ai/glm-5.3-flash", source: "OPENROUTER_MODELS.flash" },
  { id: "claude-fable-5-1", source: "pin STEWARD_MODEL" },
  { id: "deepseek/deepseek-v4-flash", source: "pin MATCHER_MODEL (stale)" },
  { id: "claude-opus-4-7", source: "pricing prefix" },
  { id: "gpt-5-mini", source: "pricing prefix" },
  { id: "gpt-5", source: "pricing prefix" },
];

const ratesFor = (id: string) => (hasExplicitRates(id) ? ratesForModel(id) : null);

describe("helpers", () => {
  it("routes ids by shape, converts OpenRouter per-token prices, and strips vendors", () => {
    expect(providerOf("claude-x")).toBe("anthropic");
    expect(providerOf("gpt-5")).toBe("openai");
    expect(providerOf("o3")).toBe("openai");
    expect(providerOf("z-ai/glm")).toBe("openrouter");
    expect(providerOf("us.anthropic.claude")).toBeNull();
    expect(openRouterRates({ id: "x", pricing: { prompt: "0.00000015", completion: "0.0000005" } })).toEqual({ inputPerMtok: 0.15, outputPerMtok: 0.5 });
    expect(openRouterRates({ id: "x" })).toBeNull();
    expect(vendorStripped("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(vendorStripped("z-ai/glm-5.3-flash")).toBeNull();
  });

  it("lets a pricing prefix cover its dated snapshots but not a new family member", () => {
    expect(coveredByPrefix("claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(true);
    expect(coveredByPrefix("gpt-5-nano", "gpt-5-nano-2025-08-07")).toBe(true);
    expect(coveredByPrefix("gpt-5", "gpt-5")).toBe(true);
    expect(coveredByPrefix("gpt-5", "gpt-5.7")).toBe(false);
    expect(coveredByPrefix("gpt-5", "gpt-5-mini")).toBe(false);
  });

  it("keeps chat families and drops embeddings, audio, free tiers and the wider zoo", () => {
    expect(isCandidateId("openai", "gpt-5.7")).toBe(true);
    expect(isCandidateId("openai", "text-embedding-3-small")).toBe(false);
    expect(isCandidateId("openai", "gpt-4o-audio-preview")).toBe(false);
    expect(isCandidateId("openrouter", "z-ai/glm-5.4-flash")).toBe(true);
    expect(isCandidateId("openrouter", "meta-llama/llama-5-70b:free")).toBe(false);
    expect(isCandidateId("openrouter", "someone/obscure-model")).toBe(false);
  });

  it("reads the rate-table prefixes out of the committed pricing.ts", () => {
    const prefixes = parsePricingPrefixes(readFileSync(PRICING, "utf8"));
    expect(prefixes).toContain("claude-sonnet-5");
    expect(prefixes).toContain("gpt-5-mini");
    expect(prefixes.length).toBeGreaterThan(10);
    for (const p of prefixes) expect(hasExplicitRates(p), p).toBe(true);
  });
});

describe("diffModels", () => {
  const diff = diffModels({ registry, providers: { anthropic, openai, openrouter }, ratesFor });

  it("surfaces unregistered chat models as candidates, newest first", () => {
    const ids = diff.candidates.map((c) => c.id);
    expect(ids).toContain("claude-sonnet-5-5");
    expect(ids).toContain("gpt-5.7");
    expect(ids).toContain("z-ai/glm-5.4-flash");
    expect(ids).not.toContain("claude-sonnet-5"); // registered
    expect(ids).not.toContain("gpt-5-mini"); // pricing prefix
    expect(ids).not.toContain("text-embedding-3-small");
    expect(ids).not.toContain("anthropic/claude-sonnet-5"); // resold, not a vendor we adopt through OpenRouter
    expect(ids[0]).toBe("claude-sonnet-5-5");
    expect(diff.candidates.find((c) => c.id === "z-ai/glm-5.4-flash")?.rates).toEqual({ inputPerMtok: 0.2, outputPerMtok: 0.6 });
  });

  it("reports registered ids the provider no longer lists, naming their sources", () => {
    const ids = diff.deprecated.map((d) => d.id);
    expect(ids).toContain("deepseek/deepseek-v4-flash");
    expect(ids).toContain("claude-opus-4-7");
    // "gpt-5" is a pricing PREFIX with no exact or dated listing: gpt-5-mini and gpt-5.7 are other models.
    expect(ids).toContain("gpt-5");
    expect(ids).not.toContain("claude-sonnet-5");
    expect(diff.deprecated.find((d) => d.id === "deepseek/deepseek-v4-flash")?.sources).toEqual(["pin MATCHER_MODEL (stale)"]);
  });

  it("flags pricing drift where OpenRouter's resold rate differs from pricing.ts", () => {
    const ids = diff.pricingDrift.map((p) => p.id);
    expect(ids).toContain("claude-haiku-4-5-20251001"); // $1.2 vs $1 input
    expect(ids).not.toContain("claude-sonnet-5"); // $3/$15 both sides
    expect(ids).not.toContain("gpt-5-mini");
    const h = diff.pricingDrift.find((p) => p.id === "claude-haiku-4-5-20251001")!;
    expect(h.ours.inputPerMtok).toBe(1);
    expect(h.openrouter.inputPerMtok).toBe(1.2);
  });

  it("marks a provider without a list as unavailable instead of deprecating its models", () => {
    const partial = diffModels({ registry, providers: { openrouter }, ratesFor });
    expect(partial.unavailable).toEqual(["anthropic", "openai"]);
    expect(partial.deprecated.map((d) => d.id)).not.toContain("claude-opus-4-7");
    expect(renderDiscovery(partial)).toMatch(/Not checked \(no key or fetch failed\): anthropic, openai/);
  });
});
