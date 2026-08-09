/**
 * Model guard (#334 suite S7, the "guard" stage of the model lifecycle).
 *
 * The failure modes this catches are silent: a model reachable by config that
 * resolves to no provider fails every run of the agent routed to it, and an
 * Anthropic/OpenAI model without a pricing entry meters at the conservative
 * top-tier fallback — a real misbill against user credit grants until someone
 * notices the usage rows. This suite makes both loud, per PR, for every model
 * the system is actually configured to reach:
 *
 *   - the model registry defaults (src/llm/models.ts — every per-agent
 *     *_MODEL default in src/config.ts resolves to one of these), and
 *   - the production pins in infra/lib/api-stack.ts (read from the source, so
 *     a new pin is guarded the moment it lands in the task definition).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MODELS,
  isAnthropicModelId,
  modelAcceptsTemperature,
  modelNeedsRefusalFallback,
} from "../../../src/llm/models.js";
import { resolveProvider } from "../../../src/llm/providers/routing.js";
import { DEFAULT_JUDGE_PANEL } from "../../../src/config.js";
import {
  costMicroUsd,
  hasExplicitRates,
  ratesForModel,
} from "../../../src/llm/pricing.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Model IDs pinned as *_MODEL env vars on the ECS task definition. */
function productionPins(): Array<{ envVar: string; model: string }> {
  const stack = readFileSync(
    join(here, "../../../infra/lib/api-stack.ts"),
    "utf8"
  );
  const pins: Array<{ envVar: string; model: string }> = [];
  for (const m of stack.matchAll(/([A-Z][A-Z_]*_MODEL):\s*"([^"]+)"/g)) {
    pins.push({ envVar: m[1]!, model: m[2]! });
  }
  return pins;
}

/** Every model the system is configured to reach, with where it's configured. */
function reachableModels(): Array<{ source: string; model: string }> {
  return [
    ...Object.entries(MODELS).map(([tier, model]) => ({
      source: `MODELS.${tier}`,
      model,
    })),
    ...productionPins().map((p) => ({
      source: `infra ${p.envVar}`,
      model: p.model,
    })),
    // The default scorecard judge panel (JUDGE_MODELS) — configured-reachable
    // even with no env set, so it gets the same resolve/price coverage.
    ...DEFAULT_JUDGE_PANEL.split(",").map((model) => ({
      source: "config DEFAULT_JUDGE_PANEL",
      model,
    })),
  ];
}

describe("model guard: every reachable model resolves, prices, and behaves", () => {
  it("finds the production model pins in the ECS task definition", () => {
    // If the pin format in api-stack.ts changes, fix productionPins() rather
    // than losing guard coverage of production models.
    const pins = productionPins();
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.map((p) => p.envVar)).toContain("STEWARD_MODEL");
  });

  for (const { source, model } of reachableModels()) {
    describe(`${model} (${source})`, () => {
      const provider = resolveProvider(model);

      it("resolves to a known provider", () => {
        expect(provider).not.toBeNull();
      });

      it("has an explicit price, or reports provider cost per call", () => {
        // OpenRouter models are priced from the provider-reported cost on
        // every call; everything else must be in the rate table or it meters
        // at the top-tier fallback (see hasExplicitRates).
        if (provider !== "openrouter") {
          expect(hasExplicitRates(model)).toBe(true);
        }
      });

      it("has consistent Anthropic-only quirk predicates", () => {
        // The temperature and refusal-fallback quirks are Anthropic-family
        // behaviors; a model that isn't an Anthropic ID must never match them
        // (they gate request parameters the other providers would reject).
        if (!isAnthropicModelId(model)) {
          expect(modelAcceptsTemperature(model)).toBe(false);
          expect(modelNeedsRefusalFallback(model)).toBe(false);
        }
      });
    });
  }

  it("prices dated snapshot IDs through their family prefix", () => {
    // The registry's dated Haiku snapshot must resolve to Haiku rates, not the
    // fallback — prefix matching is what makes new snapshots price correctly.
    expect(hasExplicitRates(MODELS.haiku)).toBe(true);
    expect(ratesForModel(MODELS.haiku).inputPerMtok).toBe(1);
  });

  it("meters unknown models at the top-tier fallback, never free", () => {
    const unknown = "claude-somethingnew-9";
    expect(hasExplicitRates(unknown)).toBe(false);
    const micro = costMicroUsd(unknown, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Fallback = Fable-tier rates ($10 in + $50 out per Mtok).
    expect(micro).toBe(60_000_000);
  });
});
