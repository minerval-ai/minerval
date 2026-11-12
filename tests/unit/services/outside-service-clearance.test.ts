/**
 * Each place text leaves the process for an outside service that is not a
 * model provider holds itself to the label of the run sending it
 * (src/provider-labels.ts, src/llm/provider-clearance.ts): embeddings, the
 * fetch of an address on the open web, the web search the agent's loop
 * runs, Elicit and Pangram. Not cleared, nothing is sent; at `public`,
 * which is all the public graph has, each sends as it always did.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../../src/services/usage-service.js", () => ({
  meterLlmUsage: vi.fn(async () => undefined),
  meterExternalUsage: vi.fn(async () => undefined),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../../../src/services/label-service.js", () => ({ undefinedLabels: async () => [] }));

import { loadConfig, type Config } from "../../../src/config.js";
import { generateEmbedding, generateEmbeddings } from "../../../src/services/embedding-service.js";
import { fetchPublicBytes, fetchPublicUrl } from "../../../src/services/url-guard.js";
import { openrouterWebSearch, resetOpenRouterClient } from "../../../src/llm/providers/openrouter.js";
import { createWebSearch } from "../../../src/llm/tools/web-search-tool.js";
import { createPangramTools } from "../../../src/llm/tools/pangram-tools.js";
import {
  executeElicitTool,
  getElicitToolDefinitions,
} from "../../../src/llm/tools/elicit-tools.js";
import { resetProviderClearanceForTests } from "../../../src/llm/provider-clearance.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";
import { ProviderNotClearedError } from "../../../src/provider-labels.js";
import { OPENROUTER_MODELS } from "../../../src/llm/models.js";

const deployment = loadConfig() as unknown as Record<string, unknown>;
const loaded = { ...deployment };
afterAll(() => {
  Object.assign(deployment, loaded);
});

const atInternal = <T>(fn: () => T): T => runWithUsageContext({ label: "internal" }, fn);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const notCleared = (service: string) =>
  new RegExp(`^${service} is not cleared for the label "internal", so nothing was sent to it\\. PROVIDER_LABELS `);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetProviderClearanceForTests();
  resetOpenRouterClient();
  Object.assign(deployment, {
    providerLabels: {},
    openaiApiKey: "test-openai-key",
    openrouterApiKey: "test-openrouter-key",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embeddings", () => {
  const embedding = { object: "list", data: [{ index: 0, embedding: [0.1, 0.2] }], model: "e", usage: { prompt_tokens: 1, total_tokens: 1 } };

  it("embeds at public as before", async () => {
    fetchMock.mockImplementation(async () => json(embedding));
    expect(await generateEmbedding("a claim")).toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.openai.com/v1/embeddings");
  });

  it("refuses at a label the service is not cleared for, and sends nothing", async () => {
    await expect(atInternal(() => generateEmbedding("a private claim"))).rejects.toBeInstanceOf(ProviderNotClearedError);
    await expect(atInternal(() => generateEmbedding("a private claim"))).rejects.toThrow(
      'embeddings is not cleared for the label "internal", so nothing was sent to it. PROVIDER_LABELS ' +
        "lists the labels each model provider and outside service may receive text at, and one it " +
        'does not list is cleared for "public" alone. To clear this one, set its entry to ' +
        '"embeddings":["public","internal"].'
    );
    await expect(atInternal(() => generateEmbeddings(["one", "two"]))).rejects.toThrow(notCleared("embeddings"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not cleared by the model provider that shares its key being cleared", async () => {
    deployment.providerLabels = { openai: ["public", "internal"] };
    await expect(atInternal(() => generateEmbedding("a private claim"))).rejects.toThrow(notCleared("embeddings"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("embeds at that label once the service is cleared for it", async () => {
    deployment.providerLabels = { embeddings: ["public", "internal"] };
    fetchMock.mockImplementation(async () => json(embedding));
    expect(await atInternal(() => generateEmbedding("a private claim"))).toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetching an address on the open web", () => {
  // An IP literal, so the guard resolves nothing.
  const URL_ = "http://93.184.216.34/paper?q=what+the+run+asked";

  it("fetches at public as before", async () => {
    fetchMock.mockImplementation(async () => new Response("the page", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(await fetchPublicUrl(URL_)).toBe("the page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses at a label the open web is not cleared for, before the address is sent anywhere", async () => {
    await expect(atInternal(() => fetchPublicBytes(URL_))).rejects.toThrow(notCleared("web_pages"));
    await expect(atInternal(() => fetchPublicUrl(URL_))).rejects.toBeInstanceOf(ProviderNotClearedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can be switched off for every label with an empty list", async () => {
    deployment.providerLabels = { web_pages: [] };
    await expect(fetchPublicUrl(URL_)).rejects.toThrow(
      /^web_pages is not cleared for the label "public".* set its entry to "web_pages":\["public"\]\.$/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches at that label once cleared", async () => {
    deployment.providerLabels = { web_pages: ["internal"] };
    fetchMock.mockImplementation(async () => new Response("the page", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(await atInternal(() => fetchPublicUrl(URL_))).toBe("the page");
  });
});

describe("the web search the agent's loop runs", () => {
  const hits = {
    id: "gen_1",
    model: OPENROUTER_MODELS.flash,
    choices: [
      {
        index: 0,
        finish_reason: "length",
        message: {
          role: "assistant",
          content: "",
          annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/a", title: "A", content: "text" } }],
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.01 },
  };

  it("searches at public as before", async () => {
    fetchMock.mockImplementation(async () => json(hits));
    expect(await openrouterWebSearch("owls", 3)).toEqual([{ url: "https://example.org/a", title: "A", excerpt: "text" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses at a label it is not cleared for, whatever OpenRouter itself is cleared for", async () => {
    deployment.providerLabels = { openrouter: ["public", "internal"] };
    await expect(atInternal(() => openrouterWebSearch("a private question", 3))).rejects.toThrow(notCleared("web_search"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a search the model makes anyway with an error, and sends nothing", async () => {
    const search = createWebSearch(OPENROUTER_MODELS.flash);
    const result = JSON.parse(await atInternal(() => search.execute!({ query: "a private question" })));
    expect(result.error_code).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Pangram", () => {
  const config = {
    ...(deployment as unknown as Config),
    pangramApiKey: "test-key",
    pangramApiUrl: "https://pangram.example",
    pangramPlagiarismApiUrl: "https://plagiarism.pangram.example",
    pangramMaxWords: 50,
    pangramAiUsdPerWord: 0.0005,
    pangramPlagiarismUsdPerWord: 0.001,
  } as Config;

  it("offers its tools at public as before", () => {
    expect(createPangramTools({ config }).definitions.map((t) => t.name)).toEqual([
      "pangram_check_ai",
      "pangram_find_sources",
    ]);
  });

  it("offers none at a label it is not cleared for, and sends nothing if one is called", async () => {
    const tools = atInternal(() => createPangramTools({ config }));
    expect(tools.definitions).toEqual([]);
    const result = JSON.parse((await atInternal(() => tools.execute("pangram_check_ai", { text: "private words" })))!);
    expect(result).toEqual({ success: false, message: "pangram_check_ai is not in this run's toolset." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses at the request itself too, for a toolset built where it was cleared", async () => {
    const tools = createPangramTools({ config });
    const result = JSON.parse((await atInternal(() => tools.execute("pangram_find_sources", { text: "private words" })))!);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Pangram is unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers its tools at that label once cleared", () => {
    const cleared = { ...config, providerLabels: { pangram: ["internal"] } } as Config;
    expect(atInternal(() => createPangramTools({ config: cleared })).definitions).toHaveLength(2);
  });
});

describe("Elicit", () => {
  const config = { ...(deployment as unknown as Config), elicitApiKey: "test-key", elicitUsdPerCall: 0.05 } as Config;

  it("offers no tools at a label it is not cleared for, without connecting", async () => {
    expect(await atInternal(() => getElicitToolDefinitions(config))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a call the model makes anyway", async () => {
    const result = JSON.parse(await atInternal(() => executeElicitTool("elicit_search_papers", { query: "private" }, config)));
    expect(result).toEqual({ success: false, message: "elicit_search_papers is not in this run's toolset." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
