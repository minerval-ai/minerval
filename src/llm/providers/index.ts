/**
 * The provider registry: model id → live adapter.
 *
 * Read routing.ts first — it owns the ID-shape rules. This module is only the
 * (tiny) map from a resolved provider name to the object that implements it, so
 * adding a fourth backend is: one adapter file, one shape rule, one line here.
 */
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";
import { assertModelPriced } from "../pricing.js";
import { providerForModel } from "./routing.js";
import type { ProviderAdapter, ProviderName } from "./types.js";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
};

/**
 * The adapter serving `modelId`. Throws if the id matches no known shape,
 * or, in a deployment that creates its own owls, if the model has no price
 * there (pricing.ts, assertModelPriced): every call takes its adapter from
 * here, so an unpriced model is refused before anything is sent.
 */
export function getAdapter(modelId: string): ProviderAdapter {
  const adapter = ADAPTERS[providerForModel(modelId)];
  assertModelPriced(modelId);
  return adapter;
}

export { anthropicAdapter, openaiAdapter, openrouterAdapter };
export * from "./routing.js";
export type * from "./types.js";
