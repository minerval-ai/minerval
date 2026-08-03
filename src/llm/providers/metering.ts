/**
 * The metering chokepoint every adapter funnels through.
 *
 * Two meters, one call: the in-memory budget tracker (a process-wide circuit
 * breaker) and the durable per-user meter (#70). The durable write is
 * fire-and-forget and swallows its own errors — metering must never fail an LLM
 * call — while attribution (user/key/agent) rides in via the ambient usage
 * context (see ../usage-context.ts).
 */
import { recordUsage } from "../budget-tracker.js";
import { meterLlmUsage } from "../../services/usage-service.js";
import type { ProviderName } from "./types.js";

/**
 * Normalized usage from any provider.
 *
 * IMPORTANT: `inputTokens` is the UNCACHED input count, matching Anthropic's
 * accounting, so the four token components are additive with no double
 * counting. OpenAI-compatible APIs report `prompt_tokens` INCLUSIVE of cached
 * tokens, so those adapters subtract before handing usage here.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Cost in micro-USD as reported BY THE PROVIDER, when it reports one. Present
   * only on OpenRouter (which prices a whole zoo of models we cannot maintain a
   * rate table for) and, when set, it overrides the table-derived cost in
   * pricing.ts. Undefined everywhere else.
   */
  costMicroUsd?: number;
}

/** Record one call against both meters. Never throws. */
export function recordCallUsage(
  provider: ProviderName,
  model: string,
  usage: ProviderUsage
): void {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  recordUsage(usage.inputTokens, usage.outputTokens, {
    readTokens: cacheRead,
    creationTokens: cacheCreation,
  });
  void meterLlmUsage({
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    providerCostMicroUsd: usage.costMicroUsd,
  });
}

/** Print cache hit/miss tokens when LLM_LOG_CACHE is set (verification aid). */
export function logCacheUsage(
  provider: ProviderName,
  usage: ProviderUsage
): void {
  if (!process.env.LLM_LOG_CACHE) return;
  console.error(
    `[cache] provider=${provider} read=${usage.cacheReadTokens ?? 0} ` +
      `created=${usage.cacheCreationTokens ?? 0} ` +
      `input=${usage.inputTokens} output=${usage.outputTokens}`
  );
}
