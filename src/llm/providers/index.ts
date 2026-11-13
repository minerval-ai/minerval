/**
 * The provider registry: model id → live adapter.
 *
 * Read routing.ts first — it owns the ID-shape rules. This module is only the
 * (tiny) map from a resolved provider name to the object that implements it, so
 * adding another hosted backend is: one adapter file, one shape rule, one line
 * here. An endpoint a deployment declares for itself (endpoint-config.ts) has
 * no line: its adapter is built from the declaration (endpoint.ts).
 */
import { anthropicAdapter } from "./anthropic.js";
import { endpointAdapterFor } from "./endpoint.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";
import { assertModelPriced } from "../pricing.js";
import { ENDPOINT_ID_PREFIX, providerForModel } from "./routing.js";
import type { HostedProviderName, ProviderAdapter } from "./types.js";

const ADAPTERS: Record<HostedProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
};

/**
 * The adapter serving `modelId`. Throws if the id matches no known shape,
 * or names an endpoint this deployment does not declare, or, in a
 * deployment that creates its own owls, if the model has no price there
 * (pricing.ts, assertModelPriced): every call takes its adapter from here,
 * so an unpriced model is refused before anything is sent.
 */
export function getAdapter(modelId: string): ProviderAdapter {
  const provider = providerForModel(modelId);
  assertModelPriced(modelId);
  // An endpoint's adapter is made for the endpoint the id names: which ones
  // exist is the deployment's configuration, not a list here.
  if (provider.startsWith(ENDPOINT_ID_PREFIX)) return endpointAdapterFor(modelId);
  return ADAPTERS[provider as HostedProviderName];
}

export { anthropicAdapter, openaiAdapter, openrouterAdapter };
export * from "./routing.js";
export type * from "./types.js";
