/**
 * Provider routing — THE single source of truth for "which backend serves this
 * model id".
 *
 * Routing is by ID SHAPE, so adding a model never means editing a list:
 *
 *   ^claude-        → anthropic   (Anthropic direct, e.g. "claude-sonnet-5")
 *   ^gpt- | ^o\d    → openai      (OpenAI direct, e.g. "gpt-5-nano", "o3")
 *   contains "/"    → openrouter  (their vendor/model convention,
 *                                  e.g. "qwen/qwen3-235b-a22b")
 *   anything else   → unresolvable, and both config validation and the call
 *                     path fail with a message naming these three shapes.
 *
 * This module is deliberately DEPENDENCY-FREE (no adapters, no config) so that
 * src/config.ts can validate model-id fields at load time without dragging in
 * SDK clients. providers/index.ts is where a resolved provider becomes a live
 * adapter.
 */
import { isAnthropicModelId } from "../models.js";
import type { ProviderName } from "./types.js";

/** Human-facing description of the accepted ID shapes, used in every error. */
export const ACCEPTED_MODEL_ID_SHAPES =
  'an Anthropic ID ("claude-…"), an OpenAI ID ("gpt-…" or "o3"), or an ' +
  'OpenRouter "vendor/model" ID (e.g. "qwen/qwen3-235b-a22b")';

/** Bedrock/Vertex-prefixed Anthropic IDs — a recurring foot-gun (issue #11). */
function isBedrockStyleId(id: string): boolean {
  return /^([a-z]{2,4}\.)?anthropic\./.test(id);
}

/**
 * Resolve a model id to its provider, or null when the id matches none of the
 * three accepted shapes.
 */
export function resolveProvider(modelId: string): ProviderName | null {
  const id = modelId.trim();
  if (!id) return null;
  // Anthropic first: a Bedrock-style "us.anthropic.claude-…" id contains no
  // slash and does not start with "claude-", so it falls through to null.
  if (isAnthropicModelId(id)) return "anthropic";
  if (/^gpt-/.test(id) || /^o\d/.test(id)) return "openai";
  // OpenRouter's convention is vendor/model — checked last so that a bare
  // "gpt-…" never lands here and "openai/gpt-5" correctly does.
  if (id.includes("/")) return "openrouter";
  return null;
}

/** True when `id` routes to one of the three backends. */
export function isSupportedModelId(id: string): boolean {
  return resolveProvider(id) !== null;
}

/**
 * The message shown when an id resolves to nothing — at config load time and
 * again at call time. Keeps the historically helpful Bedrock hint (issue #11).
 */
export function unresolvableModelIdMessage(id: string): string {
  if (isBedrockStyleId(id)) {
    return (
      `"${id}" is a Bedrock/Vertex-style model ID, which 404s against the ` +
      `Anthropic API. Use ${ACCEPTED_MODEL_ID_SHAPES}.`
    );
  }
  return `"${id}" does not resolve to a known provider. Use ${ACCEPTED_MODEL_ID_SHAPES}.`;
}

/** Resolve a model id to its provider, throwing the standard message if it can't. */
export function providerForModel(modelId: string): ProviderName {
  const provider = resolveProvider(modelId);
  if (!provider) throw new Error(unresolvableModelIdMessage(modelId));
  return provider;
}
