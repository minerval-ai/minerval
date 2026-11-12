/**
 * Thrown when the model declines a request (stop_reason "refusal" — an HTTP
 * 200, not an API error). For fallback-gated models (Opus 5.5, Fable/Mythos)
 * the request already retried on the server-side Opus fallback (see
 * client.ts), so seeing this means the whole chain refused. Callers that previously read empty content or got a
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
 * lapses, rejected credentials, rate limits, overloads, 5xx, and network drops — are exactly as
 * transient as the internal budget tracker's `LlmBudgetExceededError` and must be
 * requeued, not parked.
 *
 * We match on the Anthropic SDK's `status` when present, and otherwise on the
 * message/name so this still works for wrapped or re-thrown errors (the tool loop
 * stringifies some failures) and for raw network errors that carry no status.
 */
export function isTransientApiError(err: unknown): boolean {
  if (err instanceof LlmRefusalError) return false;

  // A deployment fault, however the provider said it (a status, a code in
  // the error body, or its words): the account behind the key cannot pay,
  // or the key was rejected. Never the work's fault (#846, #971).
  if (isProviderBillingError(err) || isProviderCredentialsError(err)) return true;

  // HTTP status carried by Anthropic.APIError (and most fetch-layer errors).
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    // 401 credentials, 402/403 credit & billing, 408 timeout, 409 conflict,
    // 429 rate limit, 5xx server errors, 529 overloaded — all retryable.
    // 400/404/422 are genuine request errors and are NOT retried here.
    //
    // 401 (#846): a rejected API key is the deployment's fault, never the
    // work's. One 30-second credential outage parked 103 claims as 'error'
    // while this read 401 as genuine. Nothing here can loop on it: a 401 is
    // answered before any tokens are billed, and the ledger row whose run
    // it stops waits, with the funded rows of its kind and tier, before it
    // is tried again (action-service.ts, releaseAction: 30 s doubling to
    // 10 minutes). So bad credentials cost one free call per kind of work
    // per wait, and no claim is parked for them. The same holds for 402,
    // a provider account out of credits (#971, isProviderBillingError).
    //
    // What the pacing must not be is a pause of everything: until #971 the
    // first such failure ended the whole drain and the runner backed off,
    // so one row on a dead provider, picked first every time, starved the
    // lanes behind it for thirteen hours while their provider was healthy.
    if (
      status === 401 ||
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
      name === "AuthenticationError" ||
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
    // A provider account out of credits, as each provider words it (#967);
    // the one list is BILLING_TEXT below.
    BILLING_TEXT.some((p) => message.includes(p)) ||
    // A rejected credential (#846), as the provider words it in the error
    // body; the stored text of a park carries no status to read.
    message.includes("authentication_error") ||
    message.includes("invalid x-api-key") ||
    message.includes("api key is invalid") ||
    message.includes("invalid api key") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("overloaded") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    // undici's wording for a connection or body stream closed under it, and
    // Node's for a fetch that never connected — both hit the Steward mid-run.
    message === "terminated" ||
    message.includes("terminated") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("connection error") ||
    message.includes("service unavailable") ||
    message.includes("internal server error") ||
    message.includes("bad gateway")
  );
}

/**
 * How each provider this system calls words "the account behind this key
 * cannot pay for the request" (#967, #971). Lower-case substrings of the
 * error text, for an error that reaches us with no status or code to read
 * (a tool loop stringifies some failures).
 *
 *  - Anthropic: 400 invalid_request_error "Your credit balance is too low to
 *    access the Anthropic API", and 402 billing_error.
 *  - OpenAI (the LLM provider and the embedder): 429 with code
 *    insufficient_quota ("You exceeded your current quota, please check your
 *    plan and billing details"), billing_not_active, billing_hard_limit_reached.
 *  - OpenRouter: 402, worded by what ran short ("Insufficient credits",
 *    "This request requires more credits, or fewer max_tokens", "This
 *    request's maximum cost exceeds your available credits"). The last two
 *    are a pre-flight check on the request's worst case, so a nearly empty
 *    account refuses large requests while small ones still pass.
 *  - A declared endpoint (endpoint.ts) restates the server's message and
 *    keeps its status, so an OpenAI-compatible server's 402 reads the same.
 */
const BILLING_TEXT = [
  "credit balance is too low",
  "billing_error",
  "insufficient_quota",
  "exceeded your current quota",
  "billing_not_active",
  "billing_hard_limit",
  "insufficient credits",
  "available credits",
  "requires more credits",
  "payment required",
] as const;

/** The error's own machine-readable code or type, wherever the SDK put it. */
function providerErrorCodes(err: unknown): string[] {
  const e = (err ?? {}) as {
    code?: unknown;
    type?: unknown;
    error?: { type?: unknown; code?: unknown; error?: { type?: unknown; code?: unknown } };
  };
  return [e.code, e.type, e.error?.type, e.error?.code, e.error?.error?.type, e.error?.error?.code]
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).toLowerCase());
}

/**
 * Did the provider refuse this call because the deployment's account with it
 * cannot pay: out of credits, over its quota, billing inactive?
 *
 * That is the deployment's fault and the operator's to fix, exactly as a
 * rejected key is (#846): it says nothing about the work, it clears when the
 * account is topped up, and nothing an agent or a payer does changes it. So
 * it is transient (isTransientApiError agrees on every case here), it never
 * counts toward parking a node or cancelling a ledger row, and the work it
 * blocks waits and says so (services/deployment-fault.ts).
 *
 * Not this: the platform's own 402 to a caller short of owls (a reply the
 * API sends, never an error a worker catches), and LlmBudgetExceededError
 * (the run's or the process's own budget).
 */
export function isProviderBillingError(err: unknown): boolean {
  if (err instanceof LlmRefusalError || err instanceof LlmBudgetExceededError) return false;
  const status = (err as { status?: unknown })?.status;
  if (status === 402) return true;
  const codes = providerErrorCodes(err);
  if (
    codes.some(
      (c) =>
        c === "402" ||
        c === "billing_error" ||
        c === "insufficient_quota" ||
        c === "billing_not_active" ||
        c === "billing_hard_limit_reached"
    )
  ) {
    return true;
  }
  const message = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!message) return false;
  // The SDKs open the message with the status.
  if (/^402\b/.test(message)) return true;
  return BILLING_TEXT.some((p) => message.includes(p));
}

/** Did the provider reject the deployment's credential (#846)? */
export function isProviderCredentialsError(err: unknown): boolean {
  if (err instanceof LlmRefusalError || err instanceof LlmBudgetExceededError) return false;
  const e = (err ?? {}) as { status?: unknown; name?: unknown };
  if (e.status === 401 || e.name === "AuthenticationError") return true;
  if (providerErrorCodes(err).some((c) => c === "authentication_error" || c === "invalid_api_key")) return true;
  const message = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return (
    /^401\b/.test(message) ||
    message.includes("authentication_error") ||
    message.includes("invalid x-api-key") ||
    message.includes("api key is invalid") ||
    message.includes("invalid api key")
  );
}

/**
 * Which provider answered with this error, when the client's seam stamped it
 * (client.ts, providerCall); null for an error from anywhere else.
 */
export function errorProvider(err: unknown): string | null {
  const p = (err as { llmProvider?: unknown } | null | undefined)?.llmProvider;
  return typeof p === "string" && p ? p : null;
}

/** Stamp the provider on an error on its way out of the client. Never throws. */
export function stampErrorProvider(err: unknown, provider: string): void {
  if (err && typeof err === "object" && !("llmProvider" in err)) {
    try {
      Object.defineProperty(err, "llmProvider", { value: provider, enumerable: false });
    } catch {
      // A frozen error keeps its message; the fault is recorded without a provider.
    }
  }
}
