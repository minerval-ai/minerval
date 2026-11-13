import { describe, it, expect } from "vitest";
import {
  isProviderBillingError,
  isProviderCredentialsError,
  isTransientApiError,
  errorProvider,
  stampErrorProvider,
  LlmBudgetExceededError,
  LlmRefusalError,
} from "../../../src/llm/errors.js";
import {
  FAULT_RETRY_BASE_SECONDS,
  FAULT_RETRY_MAX_SECONDS,
  FAULT_WAIT_DESCRIPTION,
  PLATFORM_FAULT_LABELS,
  PLATFORM_FAULT_REASONS,
  deploymentFaultOf,
  faultRetrySeconds,
  faultToolNote,
  faultWait,
  faultWaitSentence,
  platformFaultOf,
} from "../../../src/services/deployment-fault.js";
import { classifyStewardFailure } from "../../../src/services/steward-park-reason.js";
import { parksAtOnce, StewardBusyError } from "../../../src/services/steward-lease.js";

const withFields = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

// What each provider this system calls sends when the deployment's account
// with it cannot pay (#967, #969, #971). Each is one failure a lane catches.
const BILLING_FAILURES: Array<[string, unknown]> = [
  // The text the agents reported on 2026-11-12, as the OpenAI SDK throws it
  // for OpenRouter: the status, then the provider's message.
  [
    "OpenRouter 402, the request's worst case against the balance",
    withFields(
      "402 This request's maximum cost exceeds your available credits. Add credits, or lower max_tokens or prompt size.",
      { status: 402, name: "APIError" }
    ),
  ],
  [
    "OpenRouter 402, fewer max_tokens",
    withFields("402 This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens.", {
      status: 402,
    }),
  ],
  ["OpenRouter 402, no credits at all", withFields("402 Insufficient credits", { status: 402, code: 402 })],
  // A mid-stream failure reaches us as a body with a code and no HTTP status.
  ["OpenRouter error body with code 402", withFields("Provider returned error", { error: { code: 402 } })],
  [
    "Anthropic 400 credit balance",
    withFields(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
      { status: 400, name: "BadRequestError" }
    ),
  ],
  [
    "Anthropic billing_error",
    withFields("402 billing error", { status: 402, error: { type: "error", error: { type: "billing_error" } } }),
  ],
  [
    "OpenAI 429 insufficient_quota",
    withFields("429 You exceeded your current quota, please check your plan and billing details.", {
      status: 429,
      code: "insufficient_quota",
      type: "insufficient_quota",
      name: "RateLimitError",
    }),
  ],
  ["OpenAI billing_not_active", withFields("Your account is not active", { status: 429, code: "billing_not_active" })],
  // A declared endpoint restates the server's message and keeps its status.
  [
    "a declared endpoint's 402",
    withFields('Endpoint "lab" (https://models.lab.example/v1) answered 402 for model "m": Payment Required', {
      status: 402,
    }),
  ],
  // The stored or stringified text alone, with nothing else to read.
  ["text only, as a tool loop stringifies it", "402 This request's maximum cost exceeds your available credits."],
];

describe("a provider billing failure", () => {
  it.each(BILLING_FAILURES)("%s is a credits fault: transient, the deployment's, never a park", (_name, err) => {
    expect(isProviderBillingError(err)).toBe(true);
    expect(isTransientApiError(err)).toBe(true);
    expect(deploymentFaultOf(err)).toBe("credits_fault");
    expect(platformFaultOf(err)).toBe("credits_fault");
    expect(parksAtOnce(err)).toBe(false);
  });

  it("is not read into the platform's own money or an ordinary failure", () => {
    for (const err of [
      new LlmBudgetExceededError("hourly_token_count", 2, 1),
      new LlmRefusalError("claude-x", "policy"),
      new Error("invalid input syntax for type uuid"),
      withFields("400 max_tokens is too large", { status: 400 }),
      withFields("404 model not found", { status: 404 }),
      withFields("429 rate limit exceeded", { status: 429, name: "RateLimitError" }),
      withFields("529 overloaded", { status: 529 }),
      null,
      undefined,
    ]) {
      expect(isProviderBillingError(err)).toBe(false);
      expect(deploymentFaultOf(err)).not.toBe("credits_fault");
    }
  });
});

describe("a rejected credential", () => {
  it("is a credentials fault by status, class, code or text (#846)", () => {
    for (const err of [
      withFields("x", { status: 401 }),
      withFields("x", { name: "AuthenticationError" }),
      withFields("bad key", { error: { type: "error", error: { type: "authentication_error" } } }),
      withFields("Incorrect API key provided", { code: "invalid_api_key" }),
      new Error("401 authentication_error: API key is invalid"),
    ]) {
      expect(isProviderCredentialsError(err)).toBe(true);
      expect(deploymentFaultOf(err)).toBe("credentials_fault");
      expect(isTransientApiError(err)).toBe(true);
    }
    expect(isProviderCredentialsError(withFields("402 Insufficient credits", { status: 402 }))).toBe(false);
  });
});

describe("platformFaultOf", () => {
  it("calls any other transient failure provider_unavailable, and a genuine one nothing", () => {
    expect(platformFaultOf(withFields("x", { status: 503 }))).toBe("provider_unavailable");
    expect(platformFaultOf(withFields("x", { status: 429 }))).toBe("provider_unavailable");
    expect(platformFaultOf(new Error("fetch failed"))).toBe("provider_unavailable");
    expect(platformFaultOf(new Error("tool failed: no such claim"))).toBeNull();
    expect(platformFaultOf(new LlmRefusalError("m", null))).toBeNull();
  });

  it("is not a budget stop or a claim another Steward holds", () => {
    expect(platformFaultOf(new LlmBudgetExceededError("hourly_token_count", 2, 1))).toBeNull();
    // Retryable (409) but nobody's fault: the row is simply open again.
    const busy = new StewardBusyError("c1", 300_000);
    expect(isTransientApiError(busy)).toBe(true);
    expect(platformFaultOf(busy)).toBeNull();
  });
});

describe("the public class and what it keeps out", () => {
  it("has a label for every class, none carrying provider text", () => {
    for (const reason of PLATFORM_FAULT_REASONS) {
      expect(PLATFORM_FAULT_LABELS[reason]).toBeTruthy();
      expect(PLATFORM_FAULT_LABELS[reason]).not.toMatch(/402|401|max_tokens|openrouter|anthropic|openai/i);
    }
    expect(FAULT_WAIT_DESCRIPTION).toContain("credits_fault");
    expect(FAULT_WAIT_DESCRIPTION).toContain("next_attempt_at");
  });

  it("does not turn a billing failure into a park class of its own: it never parks", () => {
    // A park's public classes are untouched (the backfill in migration 0113
    // is pinned to them); a credits fault is told from them before any
    // attempt is counted.
    expect(classifyStewardFailure(BILLING_FAILURES[0]![1])).toBe("provider_error");
    expect(isTransientApiError(BILLING_FAILURES[0]![1])).toBe(true);
  });

  it("tells an agent what happened without the provider's words", () => {
    const note = faultToolNote("credits_fault", "The Matcher");
    expect(note).toContain("The Matcher could not run");
    expect(note).toContain("do not raise_issue");
    expect(note).not.toMatch(/402|max_tokens/);
    expect(faultToolNote("provider_unavailable", "The Matcher")).toContain("One retry is reasonable");
  });
});

describe("the wait", () => {
  it("doubles from the base to the cap", () => {
    expect(faultRetrySeconds(1)).toBe(FAULT_RETRY_BASE_SECONDS);
    expect(faultRetrySeconds(2)).toBe(FAULT_RETRY_BASE_SECONDS * 2);
    expect(faultRetrySeconds(3)).toBe(FAULT_RETRY_BASE_SECONDS * 4);
    expect(faultRetrySeconds(50)).toBe(FAULT_RETRY_MAX_SECONDS);
    expect(faultRetrySeconds(0)).toBe(FAULT_RETRY_BASE_SECONDS);
  });

  it("reads a row's columns, and nothing from a row that is not waiting", () => {
    expect(faultWait({ fault_reason: null })).toBeNull();
    expect(faultWait({ fault_reason: "something_else" })).toBeNull();
    const w = faultWait({
      fault_reason: "credits_fault",
      fault_since: new Date("2026-11-12T01:12:00Z"),
      fault_attempts: 4,
      retry_after: "2026-11-12T01:20:00Z",
    })!;
    expect(w).toMatchObject({
      reason: "credits_fault",
      since: "2026-11-12T01:12:00.000Z",
      next_attempt_at: "2026-11-12T01:20:00.000Z",
      attempts: 4,
    });
    const sentence = faultWaitSentence(w);
    expect(sentence).toContain("waiting on a deployment fault");
    expect(sentence).toContain("since 2026-11-12 01:12 UTC");
    expect(sentence).toContain("next attempt about 2026-11-12 01:20 UTC");
    // What happens to the money is said, since that is the payer's question.
    expect(sentence).toContain("budget stays held");
    expect(sentence).toContain("no attempt is charged");
  });
});

describe("the provider stamp", () => {
  it("names the provider on an error once, without changing it", () => {
    const err = withFields("402 Insufficient credits", { status: 402 });
    expect(errorProvider(err)).toBeNull();
    stampErrorProvider(err, "openrouter");
    stampErrorProvider(err, "anthropic");
    expect(errorProvider(err)).toBe("openrouter");
    expect(err.message).toBe("402 Insufficient credits");
    expect(Object.keys(err)).not.toContain("llmProvider");
    expect(() => stampErrorProvider("a string", "openrouter")).not.toThrow();
    expect(() => stampErrorProvider(Object.freeze(new Error("frozen")), "openrouter")).not.toThrow();
  });
});
