/**
 * Thrown when the model declines a request (stop_reason "refusal" — an HTTP
 * 200, not an API error). For Fable models the request already retried on the
 * server-side Opus fallback (see client.ts), so seeing this means the whole
 * chain refused. Callers that previously read empty content or got a
 * misleading structured-output parse failure now fail loudly with the
 * policy category instead.
 */
export class LlmRefusalError extends Error {
  constructor(
    public readonly model: string,
    public readonly category: string | null
  ) {
    super(
      `Model ${model} refused the request` +
        (category ? ` (category: ${category})` : "")
    );
    this.name = "LlmRefusalError";
  }
}

export class LlmBudgetExceededError extends Error {
  public readonly limitType: string;
  public readonly currentValue: number;
  public readonly limitValue: number;

  constructor(limitType: string, currentValue: number, limitValue: number) {
    super(
      `LLM budget exceeded: ${limitType} = ${currentValue} (limit: ${limitValue})`
    );
    this.name = "LlmBudgetExceededError";
    this.limitType = limitType;
    this.currentValue = currentValue;
    this.limitValue = limitValue;
  }
}

/**
 * Is this error a *transient* API/infrastructure failure — one that says nothing
 * about the request itself and should be retried later — rather than a genuine
 * logic error in how we called the model?
 *
 * Motivation (#97): a late-June credit-balance outage threw
 * `400 ... "Your credit balance is too low to access the Anthropic API"` on
 * every Steward call. The pipeline treated that transient billing outage as a
 * permanent poison-claim failure and parked 81 of 142 claims as `error`, and
 * nothing re-drove them once credit was restored. These failures — billing/credit
 * lapses, rate limits, overloads, 5xx, and network drops — are exactly as
 * transient as the internal budget tracker's `LlmBudgetExceededError` and must be
 * requeued, not parked.
 *
 * We match on the Anthropic SDK's `status` when present, and otherwise on the
 * message/name so this still works for wrapped or re-thrown errors (the tool loop
 * stringifies some failures) and for raw network errors that carry no status.
 */
export function isTransientApiError(err: unknown): boolean {
  if (err instanceof LlmRefusalError) return false;

  // HTTP status carried by Anthropic.APIError (and most fetch-layer errors).
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    // 402/403 credit & billing, 408 timeout, 409 conflict, 429 rate limit,
    // 5xx server errors, 529 overloaded — all retryable. 400/401/404/422 are
    // genuine request errors and are NOT retried here.
    if (
      status === 402 ||
      status === 403 ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status === 529 ||
      (status >= 500 && status <= 599)
    ) {
      return true;
    }
  }

  const name = (err as { name?: unknown })?.name;
  if (typeof name === "string") {
    // SDK connection/timeout error classes carry no numeric status.
    if (
      name === "APIConnectionError" ||
      name === "APIConnectionTimeoutError" ||
      name === "InternalServerError" ||
      name === "RateLimitError"
    ) {
      return true;
    }
  }

  const message = (
    err instanceof Error ? err.message : String(err ?? "")
  ).toLowerCase();
  if (!message) return false;
  return (
    // The exact string from the June outage, plus the general family.
    message.includes("credit balance is too low") ||
    message.includes("credit balance") ||
    message.includes("billing") ||
    message.includes("insufficient_quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("overloaded") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("network error") ||
    message.includes("connection error") ||
    message.includes("service unavailable") ||
    message.includes("internal server error") ||
    message.includes("bad gateway")
  );
}
