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
import { providerForModel } from "./routing.js";
import { requireLoggedRun } from "../logged-run.js";
import type { ProviderAdapter, ProviderName } from "./types.js";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
};

/**
 * The adapter serving `modelId`. Throws if the id matches no known shape,
 * and, in record mode, if no agent run is open to log the call in
 * (../logged-run.ts): this is the one door to a provider, so it is where a
 * model call made outside a logged run is caught.
 */
export function getAdapter(modelId: string): ProviderAdapter {
  requireLoggedRun(`A model call (${modelId})`);
  return ADAPTERS[providerForModel(modelId)];
}

export { anthropicAdapter, openaiAdapter, openrouterAdapter };
export * from "./routing.js";
export type * from "./types.js";
