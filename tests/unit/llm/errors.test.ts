import { describe, it, expect } from "vitest";
import {
  isTransientApiError,
  LlmBudgetExceededError,
  LlmRefusalError,
} from "../../../src/llm/errors.js";

// #97: the pipeline must distinguish transient API/infra failures (requeue) from
// genuine logic errors (park after N attempts). The June outage that parked 81
// claims threw the "credit balance is too low" 400 — the canonical case below.
describe("isTransientApiError", () => {
  it("classifies the credit-balance outage message as transient", () => {
    expect(
      isTransientApiError(
        new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error",' +
            '"message":"Your credit balance is too low to access the Anthropic API"}}'
        )
      )
    ).toBe(true);
  });

  it("treats retryable HTTP statuses as transient", () => {
    for (const status of [402, 408, 409, 429, 500, 502, 503, 529]) {
      expect(isTransientApiError(Object.assign(new Error("x"), { status }))).toBe(true);
    }
  });

  it("treats client request errors as NOT transient", () => {
    for (const status of [400, 401, 404, 422]) {
      expect(
        isTransientApiError(Object.assign(new Error("bad request"), { status }))
      ).toBe(false);
    }
  });

  it("recognizes SDK connection/rate-limit error classes by name", () => {
    for (const name of [
      "APIConnectionError",
      "APIConnectionTimeoutError",
      "InternalServerError",
      "RateLimitError",
    ]) {
      expect(isTransientApiError(Object.assign(new Error("x"), { name }))).toBe(true);
    }
  });

  it("recognizes network/overload phrasing in the message", () => {
    for (const msg of [
      "Overloaded",
      "request timed out",
      "socket hang up",
      "ECONNRESET",
      "service unavailable",
    ]) {
      expect(isTransientApiError(new Error(msg))).toBe(true);
    }
  });

  it("does NOT classify a genuine logic error as transient", () => {
    expect(
      isTransientApiError(new Error("Cannot read properties of undefined (reading 'id')"))
    ).toBe(false);
    expect(
      isTransientApiError(
        new Error(
          'Structured response "ExtractedClaim" was truncated at max_tokens (8192) and cannot be parsed.'
        )
      )
    ).toBe(false);
  });

  it("does not treat a refusal as transient (it is a real, non-retryable stop)", () => {
    expect(isTransientApiError(new LlmRefusalError("claude-fable-5", "some_policy"))).toBe(
      false
    );
  });

  it("the budget-tracker error is handled separately, not by this classifier", () => {
    // The pipeline checks LlmBudgetExceededError explicitly; this helper need not
    // claim it. Documenting that it is a distinct, also-retryable path.
    const err = new LlmBudgetExceededError("daily_token_count", 10, 10);
    expect(err).toBeInstanceOf(LlmBudgetExceededError);
  });
});
