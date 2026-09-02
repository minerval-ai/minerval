import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Extractor's tier and its refusal fallback.
 *
 * Tier matters here more than the invocation count suggests: this agent
 * authors the graph's canonical language from an arbitrary, wholly untrusted
 * document whose framing it must not adopt, and everything downstream inherits
 * that wording. It runs once per DOCUMENT rather than once per claim. Through
 * the first live epoch it ran the cheap default because it had no knob at all —
 * no env, no config key, no model passed by its caller — so these tests pin
 * that the configured tier is actually the one used.
 *
 * The fallback exists because Fable declines bio-adjacent material (#78) and
 * this graph's live work includes a virology cluster. Anthropic's server-side
 * fallback already retries Fable on Opus, so an LlmRefusalError reaching us
 * means that chain refused too and the retry has to leave the family.
 * Otherwise a mandate that funded "ingest this pathogen paper" pays for the
 * fetch and gets a cancelled ingest with no claims.
 */

const { state } = vi.hoisted(() => ({
  state: {
    calls: [] as Array<string | undefined>,
    // Per-call behaviour: return claims, or throw the given error.
    throwOn: null as null | ((model: string | undefined) => Error | null),
    extractorModel: "claude-fable-5-1",
    extractorFallbackModel: "claude-sonnet-5",
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    extractorModel: state.extractorModel,
    extractorFallbackModel: state.extractorFallbackModel,
  }),
}));

vi.mock("../../../src/llm/prompts/extractor.js", () => ({
  getExtractorSystemPrompt: () => "system",
  getExtractionPrompt: () => "prompt:",
}));

const claim = (text: string) => ({
  original_text: text,
  context: null,
  proposed_canonical_form: text,
  claim_type: "empirical_verifiable",
  confidence: 0.9,
  importance: 0.5,
  contestation: 0.5,
  source_location: null,
});

vi.mock("../../../src/llm/client.js", () => ({
  completeStructuredList: vi.fn(async (opts: { model?: string }) => {
    state.calls.push(opts.model);
    const err = state.throwOn?.(opts.model);
    if (err) throw err;
    return [claim(`from ${opts.model}`), claim("second")];
  }),
}));

import { extractClaims } from "../../../src/llm/agents/extractor.js";
import { LlmRefusalError } from "../../../src/llm/errors.js";

beforeEach(() => {
  state.calls = [];
  state.throwOn = null;
  state.extractorModel = "claude-fable-5-1";
  state.extractorFallbackModel = "claude-sonnet-5";
});

describe("extractor tier selection", () => {
  it("runs on the configured tier rather than the client default", async () => {
    await extractClaims({ content: "doc" });
    expect(state.calls).toEqual(["claude-fable-5-1"]);
  });

  it("lets an explicit caller model win over config", async () => {
    await extractClaims({ content: "doc", model: "claude-opus-4-8" });
    expect(state.calls).toEqual(["claude-opus-4-8"]);
  });
});

describe("extractor refusal fallback", () => {
  const refuse = (model: string | undefined) =>
    model === "claude-fable-5-1" ? new LlmRefusalError(model, "bio") : null;

  it("retries on the fallback model when the chosen tier refuses", async () => {
    state.throwOn = refuse;
    const claims = await extractClaims({ content: "a pathogen paper" });
    expect(state.calls).toEqual(["claude-fable-5-1", "claude-sonnet-5"]);
    // The document is not lost: the fallback's claims come back.
    expect(claims[0]!.original_text).toBe("from claude-sonnet-5");
  });

  it("still honours maxClaims on the fallback path", async () => {
    state.throwOn = refuse;
    const claims = await extractClaims({ content: "doc", maxClaims: 1 });
    expect(claims).toHaveLength(1);
  });

  it("does NOT retry a failure that is not a refusal", async () => {
    // A 500 or a parse failure is not the model declining the subject matter;
    // retrying it on a weaker model would just spend twice to fail twice.
    state.throwOn = () => new Error("upstream 500");
    await expect(extractClaims({ content: "doc" })).rejects.toThrow("upstream 500");
    expect(state.calls).toEqual(["claude-fable-5-1"]);
  });

  it("does not retry when the fallback is the same model", async () => {
    state.extractorFallbackModel = "claude-fable-5-1";
    state.throwOn = refuse;
    await expect(extractClaims({ content: "doc" })).rejects.toBeInstanceOf(
      LlmRefusalError
    );
    expect(state.calls).toEqual(["claude-fable-5-1"]);
  });

  it("rethrows the refusal when no fallback is configured", async () => {
    state.extractorFallbackModel = "";
    state.throwOn = refuse;
    await expect(extractClaims({ content: "doc" })).rejects.toBeInstanceOf(
      LlmRefusalError
    );
    expect(state.calls).toEqual(["claude-fable-5-1"]);
  });

  it("surfaces the refusal when the fallback refuses too", async () => {
    state.throwOn = (m) => new LlmRefusalError(m ?? "?", "bio");
    await expect(extractClaims({ content: "doc" })).rejects.toBeInstanceOf(
      LlmRefusalError
    );
    // Both were tried, and the caller learns the document is genuinely refused.
    expect(state.calls).toEqual(["claude-fable-5-1", "claude-sonnet-5"]);
  });
});

/**
 * No per-source claim cap.
 *
 * EXTRACTION_MAX_CLAIMS (8 in production) truncated every source to the same
 * number. How many reusable propositions a document turns on is a property of
 * the document: a dense working paper and a blog post do not contain the same
 * amount, and one ceiling either discards real claims from the former or
 * invites padding in the latter. The fan-out cost it stood in for is bounded by
 * the mandate ledger now — extracted claims become actions, and an allocator
 * funds only what clears its daily rate — so the bound is money rather than a
 * count chosen in advance.
 *
 * Callers that genuinely want a limit still pass one (the MCP text tools).
 */
describe("claim count is not capped by default", () => {
  it("extracts everything that passes the bar when no cap is given", async () => {
    const claims = await extractClaims({ content: "a dense paper" });
    expect(claims).toHaveLength(2); // the stub's full output, unsliced
  });

  it("still honours an explicit per-call cap from a caller", async () => {
    const claims = await extractClaims({ content: "doc", maxClaims: 1 });
    expect(claims).toHaveLength(1);
  });

  it("treats 0 as no cap rather than as zero claims", async () => {
    const claims = await extractClaims({ content: "doc", maxClaims: 0 });
    expect(claims).toHaveLength(2);
  });
});
