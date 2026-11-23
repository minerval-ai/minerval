import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Extractor's tier, and what it does when that tier refuses.
 *
 * Tier matters here more than the invocation count suggests: this agent
 * authors the graph's canonical language from an arbitrary, wholly untrusted
 * document whose framing it must not adopt, and everything downstream inherits
 * that wording. It runs once per DOCUMENT rather than once per claim. Through
 * the first live epoch it ran the cheap default because it had no knob at all —
 * no env, no config key, no model passed by its caller — so these tests pin
 * that the configured tier is actually the one used.
 *
 * A refusal (bio-adjacent material is the known case, #78) is shown as a
 * refusal: the ingest fails with it as the reason, and nothing retries the
 * document on another, weaker model (#1044).
 */

const { state } = vi.hoisted(() => ({
  state: {
    calls: [] as Array<string | undefined>,
    // Per-call behaviour: return claims, or throw the given error.
    throwOn: null as null | ((model: string | undefined) => Error | null),
    extractorModel: "claude-opus-5-5",
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    extractorModel: state.extractorModel,
  }),
}));

vi.mock("../../../src/llm/prompts/extractor.js", () => ({
  getExtractorSystemPrompt: () => "system",
  getExtractorSystemPromptBlocks: () => ["system"],
  getExtractionPrompt: () => "prompt:",
}));

const claim = (text: string) => ({
  verbatim_text: text,
  context: null,
  proposed_canonical_form: text,
  claim_type: "empirical_verifiable",
  kind: "claim",
  confidence: 0.9,
  importance: 0.5,
  contestation: 0.5,
  source_location: null,
  domains: [],
});

vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [],
    execute: async () => null,
    raisedCount: 0,
  }),
}));

// The Extractor's loop, standing in for a model that records its two claims
// in one call and then finishes.
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(
    async (opts: {
      model?: string;
      beforeTurn?: (turn: number) => void;
      executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
    }) => {
      state.calls.push(opts.model);
      const err = state.throwOn?.(opts.model);
      if (err) throw err;
      opts.beforeTurn?.(0);
      await opts.executeTool("record_claims", {
        claims: [claim(`from ${opts.model}`), claim("second")],
      });
      await opts.executeTool("finish_extraction", {});
      opts.beforeTurn?.(1);
      return { stopReason: "tool_use", content: "", toolUses: [] };
    }
  ),
}));

import { extractClaims } from "../../../src/llm/agents/extractor.js";
import { LlmRefusalError } from "../../../src/llm/errors.js";

beforeEach(() => {
  state.calls = [];
  state.throwOn = null;
  state.extractorModel = "claude-opus-5-5";
});

describe("extractor tier selection", () => {
  it("runs on the configured tier rather than the client default", async () => {
    await extractClaims({ content: "doc" });
    expect(state.calls).toEqual(["claude-opus-5-5"]);
  });

  it("lets an explicit caller model win over config", async () => {
    await extractClaims({ content: "doc", model: "claude-opus-4-8" });
    expect(state.calls).toEqual(["claude-opus-4-8"]);
  });
});

describe("extractor refusal", () => {
  it("surfaces a refusal as one, without retrying on another model (#1044)", async () => {
    state.throwOn = (m) => (m === "claude-opus-5-5" ? new LlmRefusalError(m, "bio") : null);
    await expect(extractClaims({ content: "a pathogen paper" })).rejects.toBeInstanceOf(
      LlmRefusalError
    );
    expect(state.calls).toEqual(["claude-opus-5-5"]);
  });

  it("does not retry a failure that is not a refusal either", async () => {
    state.throwOn = () => new Error("upstream 500");
    await expect(extractClaims({ content: "doc" })).rejects.toThrow("upstream 500");
    expect(state.calls).toEqual(["claude-opus-5-5"]);
  });
});

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
