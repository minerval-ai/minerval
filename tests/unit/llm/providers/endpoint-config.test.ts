/**
 * MODEL_ENDPOINTS (src/llm/providers/endpoint-config.ts): the endpoints a
 * deployment declares for itself, as config loading parses them, and what
 * an installer is told when the declaration is wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseModelEndpoints } from "../../../../src/llm/providers/endpoint-config.js";

const LOCAL = {
  name: "local",
  baseUrl: "http://vllm.internal:8000/v1",
  keyEnv: "LOCAL_LLM_KEY",
  inputUsdPerMtok: 0.5,
  outputUsdPerMtok: 1.5,
};

describe("parseModelEndpoints", () => {
  it("declares none when the setting is empty", () => {
    expect(parseModelEndpoints("")).toEqual({ endpoints: [], problems: [] });
    expect(parseModelEndpoints("  ")).toEqual({ endpoints: [], problems: [] });
    expect(parseModelEndpoints("[]")).toEqual({ endpoints: [], problems: [] });
  });

  it("reads a list of endpoints", () => {
    const other = { name: "ollama-2", baseUrl: "https://ollama.example/v1/", inputUsdPerMtok: 0, outputUsdPerMtok: 0 };
    const { endpoints, problems } = parseModelEndpoints(JSON.stringify([LOCAL, other]));
    expect(problems).toEqual([]);
    expect(endpoints).toEqual([
      LOCAL,
      // The trailing slash is dropped, and an endpoint that takes no key has no keyEnv.
      { name: "ollama-2", baseUrl: "https://ollama.example/v1", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    ]);
  });

  it("says what is wrong with text that is not a JSON list", () => {
    expect(parseModelEndpoints("local=http://x").problems[0]).toMatch(
      /^MODEL_ENDPOINTS is not valid JSON \(.+\)\. It is a JSON list with one object per endpoint, for example \[\{"name":"local"/
    );
    expect(parseModelEndpoints(JSON.stringify(LOCAL)).problems).toEqual([
      'MODEL_ENDPOINTS must be a JSON list with one object per endpoint, for example ' +
        '[{"name":"local","baseUrl":"http://localhost:8000/v1","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}].',
    ]);
  });

  it("names each thing wrong with an entry, and declares nothing from it", () => {
    const { endpoints, problems } = parseModelEndpoints(
      JSON.stringify([
        { name: "Local GPU", baseUrl: "ftp://x", keyEnv: "sk-secret-key", inputUsdPerMtok: "0.5", keyenv: "X" },
      ])
    );
    expect(endpoints).toEqual([]);
    expect(problems).toEqual([
      'MODEL_ENDPOINTS entry 1 ("Local GPU") has "keyenv", which is not a field of an endpoint. ' +
        "The fields are: name, baseUrl, keyEnv, inputUsdPerMtok, outputUsdPerMtok.",
      'MODEL_ENDPOINTS entry 1 needs a "name" of lower-case letters, digits, "-" and "_" (it is what ' +
        'follows "endpoint:" in a model ID).',
      'MODEL_ENDPOINTS entry 1 ("Local GPU") needs a "baseUrl": the http or https address its ' +
        'OpenAI-compatible API is served at, for example "http://localhost:8000/v1".',
      'MODEL_ENDPOINTS entry 1 ("Local GPU") has a "keyEnv" that is not the name of an environment ' +
        "variable. It names the variable that holds the endpoint's key (for example " +
        '"LOCAL_LLM_KEY"), not the key itself.',
      'MODEL_ENDPOINTS entry 1 ("Local GPU") needs "inputUsdPerMtok" and "outputUsdPerMtok": what a ' +
        "call to it costs, in US dollars per million tokens, as numbers of 0 or more. Budgets and " +
        "owls are counted in this cost, so it has no default.",
    ]);
  });

  it("has no default cost: an endpoint that states none is refused", () => {
    const { name, baseUrl } = LOCAL;
    expect(parseModelEndpoints(JSON.stringify([{ name, baseUrl }])).problems[0]).toContain(
      'needs "inputUsdPerMtok" and "outputUsdPerMtok"'
    );
    expect(
      parseModelEndpoints(JSON.stringify([{ name, baseUrl, inputUsdPerMtok: -1, outputUsdPerMtok: 1 }])).problems
    ).toHaveLength(1);
  });

  it("refuses two endpoints with one name", () => {
    expect(parseModelEndpoints(JSON.stringify([LOCAL, LOCAL])).problems).toEqual([
      'MODEL_ENDPOINTS declares "local" more than once. Each endpoint needs its own name.',
    ]);
  });
});

describe("MODEL_ENDPOINTS and PROVIDER_LABELS in loadConfig", () => {
  const ENV = ["MODEL_ENDPOINTS", "PROVIDER_LABELS", "MATCHER_MODEL", "STEWARD_MODEL"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Config is cached per module instance: each case loads its own.
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const load = async () => (await import("../../../../src/config.js")).loadConfig();

  it("declares no endpoint and clears nothing beyond the default when neither is set", async () => {
    const config = await load();
    expect(config.modelEndpoints).toEqual([]);
    expect(config.providerLabels).toEqual({});
  });

  it("reads both, and accepts a model routed to a declared endpoint", async () => {
    process.env.MODEL_ENDPOINTS = JSON.stringify([LOCAL]);
    process.env.PROVIDER_LABELS = JSON.stringify({
      anthropic: ["public", "internal"],
      "endpoint:local": ["public", "internal", "restricted"],
      web_pages: [],
    });
    process.env.STEWARD_MODEL = "endpoint:local/meta-llama/Llama-3.3-70B-Instruct";
    const config = await load();
    expect(config.modelEndpoints).toEqual([LOCAL]);
    expect(config.providerLabels).toEqual({
      anthropic: ["public", "internal"],
      "endpoint:local": ["public", "internal", "restricted"],
      web_pages: [],
    });
    expect(config.stewardModel).toBe("endpoint:local/meta-llama/Llama-3.3-70B-Instruct");
  });

  it("fails the load on a malformed endpoint, with what to write", async () => {
    process.env.MODEL_ENDPOINTS = JSON.stringify([{ name: "local", baseUrl: "http://localhost:8000/v1" }]);
    await expect(load()).rejects.toThrow(/needs \\?"inputUsdPerMtok\\?" and \\?"outputUsdPerMtok\\?"/);
  });

  it("fails the load on a model that names an endpoint nobody declared", async () => {
    process.env.MATCHER_MODEL = "endpoint:gpu/qwen3";
    await expect(load()).rejects.toThrow(
      'MATCHER_MODEL is "endpoint:gpu/qwen3", which names the endpoint "gpu", but this deployment ' +
        "declares no endpoint of that name. MODEL_ENDPOINTS declares none."
    );
  });

  it("fails the load on an incomplete endpoint model id", async () => {
    process.env.MATCHER_MODEL = "endpoint:local";
    await expect(load()).rejects.toThrow(/not a complete endpoint model ID/);
  });

  it("fails the load on a name in PROVIDER_LABELS that is no provider here", async () => {
    process.env.MODEL_ENDPOINTS = JSON.stringify([LOCAL]);
    process.env.PROVIDER_LABELS = JSON.stringify({ anthropc: ["internal"], "endpoint:gpu": ["internal"] });
    await expect(load()).rejects.toThrow(
      'PROVIDER_LABELS names "anthropc", which is not a provider or an outside service. They are: ' +
        "anthropic, openai, openrouter, endpoint:local, embeddings, web_search, web_pages, elicit, pangram."
    );
    await expect(load()).rejects.toThrow(
      'PROVIDER_LABELS names "endpoint:gpu", which is not an endpoint this deployment declares. ' +
        "MODEL_ENDPOINTS declares: local."
    );
  });

  it("fails the load on a PROVIDER_LABELS value that is not lists of names", async () => {
    process.env.PROVIDER_LABELS = JSON.stringify({ anthropic: "internal" });
    await expect(load()).rejects.toThrow(/gives \\?"anthropic\\?" something that is not a list of label names/);
  });
});
