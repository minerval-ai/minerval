/**
 * PROVIDER_LABELS (src/provider-labels.ts): which labels each model
 * provider and outside service may receive text at, as the setting is
 * parsed and read. The check a call makes before it sends anything is in
 * tests/unit/llm/client-provider-clearance.test.ts, and the outside
 * services' own seams in tests/unit/services/outside-service-clearance.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  clearedLabels,
  HOSTED_PROVIDERS,
  knownProviderNames,
  OUTSIDE_SERVICES,
  parseProviderLabels,
  providerClearedFor,
  ProviderNotClearedError,
  providerSettingProblems,
  UndefinedProviderLabelError,
} from "../../src/provider-labels.js";
import { MODELS, OPENROUTER_MODELS } from "../../src/llm/models.js";

const LOCAL = { name: "local", baseUrl: "http://localhost:8000/v1", inputUsdPerMtok: 1, outputUsdPerMtok: 2 };

describe("the default", () => {
  it("clears every provider and service for public, and for nothing else", () => {
    for (const config of [{}, { providerLabels: {} }, undefined as never]) {
      for (const provider of [...HOSTED_PROVIDERS, "endpoint:local", ...OUTSIDE_SERVICES.map((s) => s.name)]) {
        expect(clearedLabels(provider, config)).toEqual(["public"]);
        expect(providerClearedFor(provider, "public", config)).toBe(true);
        expect(providerClearedFor(provider, "internal", config)).toBe(false);
      }
    }
  });
});

describe("a provider the setting names", () => {
  const config = {
    providerLabels: {
      anthropic: ["public", "internal"],
      "endpoint:local": ["restricted"],
      web_pages: [],
    },
  };

  it("is cleared for exactly the labels listed", () => {
    expect(providerClearedFor("anthropic", "public", config)).toBe(true);
    expect(providerClearedFor("anthropic", "internal", config)).toBe(true);
    expect(providerClearedFor("anthropic", "restricted", config)).toBe(false);
    // Naming a label does not bring public with it, and an empty list clears nothing.
    expect(providerClearedFor("endpoint:local", "public", config)).toBe(false);
    expect(providerClearedFor("web_pages", "public", config)).toBe(false);
  });

  it("is not cleared for a label because it is cleared for another", () => {
    // Cleared for restricted says nothing about internal, which restricted
    // may read, and cleared for internal says nothing about restricted.
    expect(providerClearedFor("endpoint:local", "internal", config)).toBe(false);
    expect(providerClearedFor("anthropic", "restricted", config)).toBe(false);
  });

  it("leaves a provider it does not name on the default", () => {
    expect(clearedLabels("openai", config)).toEqual(["public"]);
    expect(clearedLabels("embeddings", config)).toEqual(["public"]);
  });
});

describe("parseProviderLabels", () => {
  it("gives every provider the default when the setting is empty", () => {
    expect(parseProviderLabels("")).toEqual({ labels: {}, problems: [] });
    expect(parseProviderLabels("{}")).toEqual({ labels: {}, problems: [] });
  });

  it("reads each provider's list, each label once", () => {
    expect(
      parseProviderLabels('{"anthropic":["public"," internal ","internal"],"embeddings":[]}')
    ).toEqual({ labels: { anthropic: ["public", "internal"], embeddings: [] }, problems: [] });
  });

  it("says what is wrong with a value of the wrong form", () => {
    expect(parseProviderLabels("anthropic=internal").problems[0]).toMatch(
      /^PROVIDER_LABELS is not valid JSON \(.+\)\. It is a JSON object from a provider's name to the labels it may receive, for example \{"anthropic":\["public","internal"\],"embeddings":\["public","internal"\]\}\.$/
    );
    expect(parseProviderLabels('["anthropic"]').problems).toEqual([
      "PROVIDER_LABELS must be a JSON object from a provider's name to the labels it may receive, " +
        'for example {"anthropic":["public","internal"],"embeddings":["public","internal"]}.',
    ]);
    expect(parseProviderLabels('{"anthropic":"internal","openai":["public"]}')).toEqual({
      labels: { openai: ["public"] },
      problems: [
        'PROVIDER_LABELS gives "anthropic" something that is not a list of label names. Write the ' +
          'labels it may receive as a list, for example "anthropic":["public"], or [] to clear it for none.',
      ],
    });
  });
});

describe("providerSettingProblems", () => {
  it("finds nothing wrong with the defaults, or with names that exist", () => {
    expect(providerSettingProblems({ stewardModel: MODELS.sonnet, taggerModel: OPENROUTER_MODELS.flash })).toEqual([]);
    expect(
      providerSettingProblems({
        modelEndpoints: [LOCAL],
        providerLabels: { anthropic: ["internal"], "endpoint:local": ["internal"], pangram: [] },
        stewardModel: "endpoint:local/meta-llama/Llama-3.3-70B-Instruct",
      })
    ).toEqual([]);
  });

  it("names every provider and service the setting may use", () => {
    expect(knownProviderNames({ modelEndpoints: [LOCAL] })).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "endpoint:local",
      "embeddings",
      "web_search",
      "web_pages",
      "elicit",
      "pangram",
    ]);
  });

  it("reports a name that is no provider, and a model on an endpoint nobody declared", () => {
    expect(
      providerSettingProblems({
        modelEndpoints: [LOCAL],
        providerLabels: { embedding: ["internal"], "endpoint:gpu": ["internal"] },
        researcherStandardModel: "endpoint:gpu/qwen3",
      })
    ).toEqual([
      'PROVIDER_LABELS names "embedding", which is not a provider or an outside service. They are: ' +
        "anthropic, openai, openrouter, endpoint:local, embeddings, web_search, web_pages, elicit, pangram.",
      'PROVIDER_LABELS names "endpoint:gpu", which is not an endpoint this deployment declares. ' +
        "MODEL_ENDPOINTS declares: local.",
      'RESEARCHER_STANDARD_MODEL is "endpoint:gpu/qwen3", which names the endpoint "gpu", but this ' +
        "deployment declares no endpoint of that name. MODEL_ENDPOINTS declares: local.",
    ]);
  });
});

describe("what an installer reads", () => {
  it("names the label, the provider and the setting to change, with the entry to write", () => {
    expect(new ProviderNotClearedError("anthropic", "internal", ["public"]).message).toBe(
      'anthropic is not cleared for the label "internal", so nothing was sent to it. PROVIDER_LABELS ' +
        "lists the labels each model provider and outside service may receive text at, and one it " +
        'does not list is cleared for "public" alone. To clear this one, set its entry to ' +
        '"anthropic":["public","internal"].'
    );
    expect(new ProviderNotClearedError("endpoint:local", "restricted", []).message).toContain(
      'set its entry to "endpoint:local":["restricted"].'
    );
  });

  it("names a label the setting uses and the deployment does not define", () => {
    expect(
      new UndefinedProviderLabelError([{ label: "restrcted", providers: ["anthropic", "embeddings"] }]).message
    ).toBe(
      'PROVIDER_LABELS names "restrcted" (for anthropic, embeddings), which this deployment does not ' +
        "define as a label, so nothing was sent. A label is a row in labels and is never created " +
        "from configuration: define it first, or correct the name in PROVIDER_LABELS."
    );
  });
});
