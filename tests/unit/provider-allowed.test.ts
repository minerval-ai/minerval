import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowedProviderProblems,
  assertProviderAllowed,
  providerAllowed,
  ProviderNotAllowedError,
} from "../../src/provider-labels.js";

/**
 * MODEL_PROVIDERS_ALLOWED: the model providers a deployment may call at all
 * (src/provider-labels.ts). An evaluator that runs every agent on its own
 * cloud account names that one, and nothing else is called.
 */
describe("which model providers may be called", () => {
  it("allows every provider where the setting is empty", () => {
    expect(providerAllowed("anthropic", { modelProvidersAllowed: [] })).toBe(true);
    expect(providerAllowed("openrouter", {})).toBe(true);
  });

  it("allows only the providers it names", () => {
    const config = { modelProvidersAllowed: ["bedrock"] };
    expect(providerAllowed("bedrock", config)).toBe(true);
    expect(providerAllowed("anthropic", config)).toBe(false);
    expect(() => assertProviderAllowed("openrouter", config)).toThrow(ProviderNotAllowedError);
    expect(() => assertProviderAllowed("openrouter", config)).toThrow(
      /MODEL_PROVIDERS_ALLOWED names \(bedrock\), and openrouter is not one of them, so nothing was sent/
    );
  });

  it("finds a name that is no model provider, and a role on a provider left out", () => {
    const problems = allowedProviderProblems({
      modelProvidersAllowed: ["bedrock", "bedrok", "endpoint:local"],
      modelEndpoints: [{ name: "local", baseUrl: "http://x.test/v1", inputUsdPerMtok: 0, outputUsdPerMtok: 0 }],
      stewardModel: "bedrock:us.anthropic.claude-opus-5-5-v1:0",
      matcherModel: "endpoint:local/qwen/qwen3",
      taggerModel: "openai/gpt-6-luna",
      redactorModel: "",
    });
    expect(problems).toEqual([
      'MODEL_PROVIDERS_ALLOWED names "bedrok", which is not a model provider here. They are: ' +
        "anthropic, openai, openrouter, bedrock, vertex, endpoint:local.",
      'TAGGER_MODEL is "openai/gpt-6-luna", on openrouter. This deployment calls only the model providers ' +
        "MODEL_PROVIDERS_ALLOWED names (bedrock, bedrok, endpoint:local), and openrouter is not one of them: " +
        "point TAGGER_MODEL at a model on an allowed provider, or add openrouter to the list.",
    ]);
  });

  it("has nothing to say where the setting is empty", () => {
    expect(allowedProviderProblems({ taggerModel: "openai/gpt-6-luna" })).toEqual([]);
  });
});

describe("in loadConfig and at the door to a provider", () => {
  const ENV = ["MODEL_PROVIDERS_ALLOWED", "STEWARD_MODEL", "BEDROCK_REGION"];
  afterEach(() => {
    for (const name of ENV) delete process.env[name];
    vi.resetModules();
  });

  it("stops the load when a role's model is on a provider the deployment does not allow", async () => {
    process.env.MODEL_PROVIDERS_ALLOWED = "bedrock";
    vi.resetModules();
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/MODEL_PROVIDERS_ALLOWED names \(bedrock\)/);
  });

  it("refuses a call to a provider left out before anything is sent", async () => {
    process.env.MODEL_PROVIDERS_ALLOWED = "anthropic,openrouter";
    vi.resetModules();
    const { getAdapter } = await import("../../src/llm/providers/index.js");
    expect(() => getAdapter("bedrock:us.anthropic.claude-opus-5-5-v1:0")).toThrow(/bedrock is not one of them/);
    expect(getAdapter("claude-opus-5-5").name).toBe("anthropic");
  });
});
