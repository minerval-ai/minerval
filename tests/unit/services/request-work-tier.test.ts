/**
 * The tier the full work on a request runs at (engine-executor.ts,
 * runRequestAction). It was fixed at the strong tier, whose model the
 * long-run loop drives only on Anthropic's strong models, so a deployment
 * that uses OpenRouter alone could not have work asked of a label above it
 * done at all (first run with real models: "anthropic is not cleared for the
 * label room, so nothing was sent to it").
 */
import { describe, expect, it } from "vitest";
import { requestWorkTier } from "../../../src/services/research-run-service.js";

const base = {
  researcherStrongModel: "claude-fable-5-2",
  researcherStandardModel: "openai/gpt-6-luna",
  anthropicApiKey: "",
  openaiApiKey: "",
  openrouterApiKey: "set",
  providerLabels: { openrouter: ["public", "room"] } as Record<string, string[]> | null,
};

describe("the tier a request's full work runs at", () => {
  it("is the strong tier where its provider has a key and is cleared for the label the work runs at", () => {
    expect(requestWorkTier("room", { ...base, anthropicApiKey: "set", providerLabels: { anthropic: ["room"], openrouter: ["room"] } })).toBe("strong");
    expect(requestWorkTier("public", { ...base, anthropicApiKey: "set", providerLabels: null })).toBe("strong");
  });

  it("is the standard tier where the strong tier's provider is not cleared for that label", () => {
    expect(requestWorkTier("room", { ...base, anthropicApiKey: "set" })).toBe("standard");
  });

  it("is the standard tier where the deployment has no key for the strong tier's provider", () => {
    expect(requestWorkTier("public", { ...base, providerLabels: null })).toBe("standard");
    expect(requestWorkTier("room", { ...base, providerLabels: { anthropic: ["room"], openrouter: ["room"] } })).toBe("standard");
  });
});
