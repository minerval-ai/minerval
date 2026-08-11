import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { MODELS, isAnthropicModelId, DEFAULT_MODEL } from "../../src/llm/models.js";

describe("model IDs", () => {
  it("DEFAULT_MODEL is the shared Sonnet ID", () => {
    expect(DEFAULT_MODEL).toBe(MODELS.sonnet);
  });

  it("accepts Anthropic API IDs", () => {
    expect(isAnthropicModelId("claude-sonnet-5")).toBe(true);
    expect(isAnthropicModelId("claude-fable-5")).toBe(true);
    expect(isAnthropicModelId("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("rejects Bedrock-style IDs", () => {
    expect(isAnthropicModelId("us.anthropic.claude-sonnet-4-20250514")).toBe(false);
    expect(isAnthropicModelId("anthropic.claude-3-haiku")).toBe(false);
  });
});

describe("loadConfig model defaults", () => {
  const MODEL_ENV = ["GOVERNANCE_MODEL", "ARBITRATION_MODEL", "AUDIT_MODEL", "CURATOR_MODEL"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of MODEL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of MODEL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to Anthropic API model IDs", async () => {
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.governanceModel).toBe(MODELS.sonnet);
    expect(config.arbitrationModel).toBe(MODELS.sonnet);
    expect(config.auditModel).toBe(MODELS.sonnet);
    expect(config.curatorModel).toBe(MODELS.sonnet);
  });

  it("rejects a Bedrock-style override", async () => {
    process.env.GOVERNANCE_MODEL = "us.anthropic.claude-sonnet-4-20250514";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/Bedrock/);
  });

  it("accepts an OpenAI model override", async () => {
    process.env.GOVERNANCE_MODEL = "gpt-5-nano";
    const { loadConfig } = await import("../../src/config.js");
    expect(loadConfig().governanceModel).toBe("gpt-5-nano");
  });

  it("accepts an OpenRouter vendor/model override", async () => {
    process.env.GOVERNANCE_MODEL = "qwen/qwen3-235b-a22b";
    const { loadConfig } = await import("../../src/config.js");
    expect(loadConfig().governanceModel).toBe("qwen/qwen3-235b-a22b");
  });

  it("rejects an ID that resolves to no provider", async () => {
    process.env.GOVERNANCE_MODEL = "llama-3-70b";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/does not resolve to a known provider/);
  });
});

describe("loadConfig load-bearing model env guard (#100)", () => {
  // EXTRACTOR_MODEL is load-bearing too: it authors the graph's canonical
  // language, and its absence from this list is what let it run the cheap
  // default through the first live epoch unnoticed.
  const MODEL_ENV = [
    "STEWARD_MODEL",
    "CURATOR_MODEL",
    "AUDIT_MODEL",
    "ARBITRATION_MODEL",
    "EXTRACTOR_MODEL",
  ];
  const saved: Record<string, string | undefined> = {};
  let savedEnvironment: string | undefined;

  beforeEach(() => {
    for (const k of MODEL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    savedEnvironment = process.env.ENVIRONMENT;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of MODEL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    vi.restoreAllMocks();
  });

  it("throws in production when a load-bearing model env is unset", async () => {
    process.env.ENVIRONMENT = "production";
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).toThrow(/STEWARD_MODEL/);
  });

  it("names only the missing envs", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.STEWARD_MODEL = "claude-fable-5";
    process.env.CURATOR_MODEL = "claude-fable-5";
    process.env.AUDIT_MODEL = "claude-fable-5";
    const { loadConfig } = await import("../../src/config.js");
    let message = "";
    try {
      loadConfig();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ARBITRATION_MODEL");
    // The Extractor is named too: it went a whole live epoch on the cheap
    // default because this guard did not cover it.
    expect(message).toContain("EXTRACTOR_MODEL");
    expect(message).not.toContain("STEWARD_MODEL");
  });

  it("loads in production when all load-bearing model envs are set", async () => {
    process.env.ENVIRONMENT = "production";
    for (const k of MODEL_ENV) process.env[k] = "claude-fable-5";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.stewardModel).toBe("claude-fable-5");
  });

  it("only warns outside production (and stays quiet under vitest)", async () => {
    process.env.ENVIRONMENT = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadConfig } = await import("../../src/config.js");
    expect(() => loadConfig()).not.toThrow();
    // VITEST is set in this process, so the dev warning is suppressed too.
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns in a non-vitest dev process running on the cheap defaults", async () => {
    process.env.ENVIRONMENT = "development";
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { loadConfig } = await import("../../src/config.js");
      loadConfig();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain("STEWARD_MODEL");
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
    }
  });
});

describe("loadConfig API key contributor bindings (issue #10)", () => {
  let savedApiKeys: string | undefined;

  beforeEach(() => {
    savedApiKeys = process.env.API_KEYS;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = savedApiKeys;
  });

  it("parses bound and unbound keys", async () => {
    process.env.API_KEYS = "k1:alice, k2";
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.apiKeys).toEqual(["k1", "k2"]);
    expect(config.apiKeyContributors).toEqual({ k1: "alice" });
  });

  it("defaults to no keys and no bindings", async () => {
    delete process.env.API_KEYS;
    const { loadConfig } = await import("../../src/config.js");
    const config = loadConfig();
    expect(config.apiKeys).toEqual([""]);
    expect(config.apiKeyContributors).toEqual({});
  });
});
