/**
 * The production model pins, read from the CDK task definition
 * (infra/lib/api-stack.ts) — the one place production's per-agent models are
 * declared, so nothing here can drift from what production actually runs.
 *
 * Two consumers:
 *   - the model guard (tests/unit/llm/model-guard.test.ts) checks that every
 *     pin resolves to a provider and prices correctly, per PR;
 *   - the corpus harness's `--profile=production` (lib.ts) applies the pins
 *     as env before config loads, so a baseline measures the configuration
 *     production runs rather than the config.ts defaults. The first epoch
 *     baseline (#349) was cut on the Sonnet default Steward while production
 *     ran Fable, which is exactly the gap this closes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const API_STACK_PATH = join(here, "..", "..", "infra", "lib", "api-stack.ts");

export interface ModelPin {
  /** The env var as the task definition sets it, e.g. STEWARD_MODEL. */
  envVar: string;
  model: string;
}

/**
 * Every `SOMETHING_MODEL: "…"` literal in the stack source. Comments that
 * mention an env var without a quoted value do not match, so prose about a
 * pin never becomes one. If the pin format in api-stack.ts changes, fix this
 * rather than losing guard coverage of production models.
 */
export function parseModelPins(stackSource: string): ModelPin[] {
  const pins: ModelPin[] = [];
  for (const m of stackSource.matchAll(/([A-Z][A-Z_]*_MODEL):\s*"([^"]+)"/g)) {
    pins.push({ envVar: m[1]!, model: m[2]! });
  }
  return pins;
}

export function productionPins(): ModelPin[] {
  return parseModelPins(readFileSync(API_STACK_PATH, "utf8"));
}

/**
 * Apply the production pins to `env`, overriding anything already there —
 * a profile means "as production", and a stray MATCHER_MODEL in .env must
 * not quietly turn a production baseline into something else. Returns what
 * was set so the caller can print it. Must run before loadConfig() caches.
 */
export function applyProductionProfile(
  env: NodeJS.ProcessEnv = process.env
): ModelPin[] {
  const pins = productionPins();
  if (pins.length === 0) {
    throw new Error(
      `No *_MODEL pins found in ${API_STACK_PATH}; cannot apply the production profile.`
    );
  }
  for (const pin of pins) env[pin.envVar] = pin.model;
  return pins;
}
