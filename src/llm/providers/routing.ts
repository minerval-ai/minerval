/**
 * Provider routing — THE single source of truth for "which backend serves this
 * model id".
 *
 * Routing is by ID SHAPE, so adding a model never means editing a list:
 *
 *   ^endpoint:<name>/ → an endpoint the deployment declares in MODEL_ENDPOINTS
 *                       (providers/endpoint-config.ts); what follows the
 *                       first slash is the model as that endpoint knows it,
 *                       e.g. "endpoint:local/meta-llama/Llama-3.3-70B-Instruct"
 *   ^claude-          → anthropic   (Anthropic direct, e.g. "claude-sonnet-5-5")
 *   ^gpt- | ^o\d      → openai      (OpenAI direct, e.g. "gpt-5-nano", "o3")
 *   contains "/"      → openrouter  (their vendor/model convention,
 *                                    e.g. "qwen/qwen3-235b-a22b")
 *   anything else     → unresolvable, and both config validation and the call
 *                       path fail with a message naming these shapes.
 *
 * The endpoint shape carries a literal prefix because open-weight model
 * names contain slashes themselves, and so read as OpenRouter ids without
 * one. No hosted id can begin with "endpoint:": an Anthropic or OpenAI id
 * has its own prefix, and an OpenRouter id has no colon before its slash.
 * An id that begins with "endpoint:" and is not well formed resolves to
 * nothing; it never falls through to OpenRouter.
 *
 * This module is deliberately DEPENDENCY-FREE (no adapters, no config) so that
 * src/config.ts can validate model-id fields at load time without dragging in
 * SDK clients. It therefore knows the shape of an endpoint id and not which
 * endpoints exist: config loading checks that each one a model field names
 * is declared (src/provider-labels.ts, providerSettingProblems), and
 * providers/index.ts, where a resolved provider becomes a live adapter,
 * checks again at call time.
 */
import { isAnthropicModelId } from "../models.js";
import type { ProviderName } from "./types.js";

/** What an endpoint model id begins with, before the endpoint's name. */
export const ENDPOINT_ID_PREFIX = "endpoint:";

/** An endpoint's name: lower-case letters, digits, "-" and "_", starting with a letter or digit. */
export const ENDPOINT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Human-facing description of the hosted ID shapes, used in the error for an
 * id that matches none. It does not name the endpoint shape: the same
 * sentence is what an agent or an account reads when it gives a lookout or a
 * correspondent a model id that does not resolve, in deployments that
 * declare no endpoint, and an id that begins "endpoint:" gets a message of
 * its own below.
 */
export const ACCEPTED_MODEL_ID_SHAPES =
  'an Anthropic ID ("claude-…"), an OpenAI ID ("gpt-…" or "o3"), or an ' +
  'OpenRouter "vendor/model" ID (e.g. "qwen/qwen3-235b-a22b")';

/** Bedrock/Vertex-prefixed Anthropic IDs — a recurring foot-gun (issue #11). */
function isBedrockStyleId(id: string): boolean {
  return /^([a-z]{2,4}\.)?anthropic\./.test(id);
}

/**
 * The two halves of an endpoint model id ("endpoint:local/org/model" is the
 * endpoint "local" and the model "org/model"), or null when `modelId` is not
 * a well-formed one.
 */
export function parseEndpointModelId(
  modelId: string
): { endpoint: string; model: string } | null {
  const id = modelId.trim();
  if (!id.startsWith(ENDPOINT_ID_PREFIX)) return null;
  const rest = id.slice(ENDPOINT_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const endpoint = rest.slice(0, slash);
  const model = rest.slice(slash + 1);
  if (!ENDPOINT_NAME_PATTERN.test(endpoint) || model.length === 0) return null;
  return { endpoint, model };
}

/** The provider name of a declared endpoint, as usage rows and PROVIDER_LABELS spell it. */
export function endpointProviderName(endpoint: string): `endpoint:${string}` {
  return `${ENDPOINT_ID_PREFIX}${endpoint}`;
}

/**
 * Resolve a model id to its provider, or null when the id matches none of the
 * accepted shapes.
 */
export function resolveProvider(modelId: string): ProviderName | null {
  const id = modelId.trim();
  if (!id) return null;
  // The endpoint prefix first, and conclusively: a malformed endpoint id
  // contains a slash, and must not be sent to OpenRouter as a vendor/model.
  if (id.startsWith(ENDPOINT_ID_PREFIX)) {
    const parsed = parseEndpointModelId(id);
    return parsed ? endpointProviderName(parsed.endpoint) : null;
  }
  // Anthropic next: a Bedrock-style "us.anthropic.claude-…" id contains no
  // slash and does not start with "claude-", so it falls through to null.
  if (isAnthropicModelId(id)) return "anthropic";
  if (/^gpt-/.test(id) || /^o\d/.test(id)) return "openai";
  // OpenRouter's convention is vendor/model — checked last so that a bare
  // "gpt-…" never lands here and "openai/gpt-5" correctly does.
  if (id.includes("/")) return "openrouter";
  return null;
}

/** True when `id` has one of the accepted shapes. */
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
  if (id.trim().startsWith(ENDPOINT_ID_PREFIX)) {
    return (
      `"${id}" is not a complete endpoint model ID. Write ` +
      `"endpoint:<name>/<model>": the name of an endpoint declared in ` +
      `MODEL_ENDPOINTS (lower-case letters, digits, "-" and "_"), a slash, ` +
      `then the model as that endpoint knows it, for example ` +
      `"endpoint:local/meta-llama/Llama-3.3-70B-Instruct".`
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
