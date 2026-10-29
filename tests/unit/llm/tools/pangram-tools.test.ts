import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No network: fetch is stubbed per test, the page reader and the meter are
// mocked. What we verify is the gating, the budget check, the word cap and
// metering, the result shaping, and the graceful-degradation contract (§20).
const { mockMeterExternal, mockReadPage } = vi.hoisted(() => ({
  mockMeterExternal: vi.fn(async () => undefined),
  mockReadPage: vi.fn(),
}));
vi.mock("../../../../src/services/usage-service.js", () => ({
  meterExternalUsage: mockMeterExternal,
}));
vi.mock("../../../../src/services/source-watch-service.js", () => ({
  readPage: mockReadPage,
}));

import {
  countWords,
  createPangramTools,
  isPangramTool,
  pangramConfigured,
  truncateToWords,
  PANGRAM_CHECK_AI_TOOL_NAME,
  PANGRAM_FIND_SOURCES_TOOL_NAME,
} from "../../../../src/llm/tools/pangram-tools.js";
import type { Config } from "../../../../src/config.js";
import { withCostMeter, withPassBudget } from "../../../../src/llm/usage-context.js";

const baseConfig = {
  pangramApiKey: "test-key",
  pangramApiUrl: "https://pangram.example",
  pangramPlagiarismApiUrl: "https://plagiarism.pangram.example",
  pangramModel: "pangram-4",
  pangramAiUsdPerWord: 0.0005,
  pangramPlagiarismUsdPerWord: 0.001,
  pangramMaxWords: 5,
} as Config;
const disabledConfig = { ...baseConfig, pangramApiKey: "" } as Config;

const noWait = async () => undefined;
const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const aiResult = {
  stage: "STAGE_SUCCESS",
  version: "4.0",
  headline: "AI Detected",
  prediction: "We are confident this document is AI-generated.",
  prediction_short: "AI",
  fraction_ai: 0.9,
  fraction_ai_assisted: 0.1,
  fraction_human: 0,
  num_ai_segments: 2,
  num_ai_assisted_segments: 1,
  num_human_segments: 0,
  windows: [
    { text: "low", label: "AI-Assisted", ai_assistance_score: 0.4, confidence: "Low" },
    { text: "high", label: "AI-Generated", ai_assistance_score: 0.99, confidence: "High", is_humanized: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pangram gating", () => {
  it("is off entirely without an API key", () => {
    expect(pangramConfigured(disabledConfig)).toBe(false);
    expect(createPangramTools({ config: disabledConfig }).definitions).toEqual([]);
  });

  it("offers both tools when configured and enabled, none when disabled", () => {
    const names = createPangramTools({ config: baseConfig }).definitions.map((t) => t.name);
    expect(names).toEqual([PANGRAM_CHECK_AI_TOOL_NAME, PANGRAM_FIND_SOURCES_TOOL_NAME]);
    const [ai, sources] = createPangramTools({ config: baseConfig }).definitions;
    // The price comes from config: $0.0005/word is 5¢ per 100 words.
    expect(ai!.description).toContain("Billed 5¢ per 100 words. Only the first 5 words are sent.");
    expect(sources!.description).toContain("Billed 10¢ per 100 words.");
    expect(createPangramTools({ enabled: false, config: baseConfig }).definitions).toEqual([]);
  });

  it("delegates other names with null, refuses its own names when disabled", async () => {
    expect(isPangramTool("pangram_check_ai")).toBe(true);
    expect(isPangramTool("web_search")).toBe(false);
    const tools = createPangramTools({ enabled: false, config: baseConfig });
    expect(await tools.execute("web_search", {})).toBeNull();
    const out = JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { text: "x" }))!);
    expect(out.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("word counting", () => {
  it("counts and truncates on whitespace", () => {
    expect(countWords("  one two\nthree  ")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(truncateToWords("a b  c d", 3)).toBe("a b  c");
    expect(truncateToWords("a b", 5)).toBe("a b");
  });
});

describe("pangram_check_ai", () => {
  it("submits the capped text, polls to completion, meters the words sent, and summarizes", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ task_id: "t-1" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_PROCESSING" }))
      .mockResolvedValueOnce(json(aiResult));
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    const out = JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { text: "one two three four five six seven" }))!);

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!;
    expect(submitUrl).toBe("https://pangram.example/task");
    expect(submitInit.headers["x-api-key"]).toBe("test-key");
    expect(JSON.parse(submitInit.body)).toEqual({
      text: "one two three four five",
      model: "pangram-4",
      public_dashboard_link: false,
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://pangram.example/task/t-1");

    expect(mockMeterExternal).toHaveBeenCalledWith({
      provider: "pangram",
      model: "pangram/check_ai",
      units: 5,
      unitKind: "words",
      costMicroUsd: 2500,
    });
    expect(out).toMatchObject({ success: true, verdict: "AI", fraction_ai: 0.9, words_analyzed: 5 });
    // Most AI-like passage first, with the humanizer flag where Pangram 4 gave one.
    expect(out.most_ai_like_passages[0]).toMatchObject({ excerpt: "high", ai_assistance_score: 0.99, is_humanized: false });
    expect(out.most_ai_like_passages[1]).not.toHaveProperty("is_humanized");
  });

  it("reads a url instead of pasted text", async () => {
    mockReadPage.mockResolvedValue({ ok: true, text: "page words here", chars: 15 });
    fetchMock.mockResolvedValueOnce(json({ task_id: "t-2" })).mockResolvedValueOnce(json(aiResult));
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    const out = JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { url: "https://x.org/a" }))!);
    expect(mockReadPage).toHaveBeenCalledWith("https://x.org/a");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toBe("page words here");
    expect(out.url).toBe("https://x.org/a");
  });

  it("refuses bad input without spending a call", async () => {
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    expect(JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, {}))!).success).toBe(false);
    expect(JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { text: "a", url: "https://x.org" }))!).success).toBe(false);
    mockReadPage.mockResolvedValue({ ok: false, problem: "404" });
    expect(JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { url: "https://x.org" }))!).message).toContain("404");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMeterExternal).not.toHaveBeenCalled();
  });

  it("degrades a provider error to a tool result and meters nothing it did not accept", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    const out = JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { text: "some text" }))!);
    expect(out.success).toBe(false);
    expect(out.message).toContain("401");
    expect(mockMeterExternal).not.toHaveBeenCalled();
  });

  it("reports a failed task, still metered once accepted", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ task_id: "t-3" }))
      .mockResolvedValueOnce(json({ stage: "STAGE_FAILED", headline: "Text too short" }));
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    const out = JSON.parse((await tools.execute(PANGRAM_CHECK_AI_TOOL_NAME, { text: "hi" }))!);
    expect(out.success).toBe(false);
    expect(out.message).toContain("Text too short");
    expect(mockMeterExternal).toHaveBeenCalledTimes(1);
  });

  it("prices a call by its words and declines one the run's budget cannot cover", async () => {
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    // Five words at $0.001 a word is half a cent; the run has a tenth of one.
    const { value } = await withPassBudget({ microUsd: 1_000, source: "the test" }, () => tools.execute(PANGRAM_FIND_SOURCES_TOOL_NAME, { text: "one two three four five" }));
    const out = JSON.parse(value!);
    expect(out.success).toBe(false);
    expect(out.message).toContain("$0.01");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMeterExternal).not.toHaveBeenCalled();
  });
});

describe("pangram_find_sources", () => {
  it("posts to the plagiarism endpoint, meters at its rate, and bounds the sources returned", async () => {
    const long = "x".repeat(1000);
    fetchMock.mockResolvedValueOnce(
      json({
        text: "…",
        plagiarism_detected: true,
        percent_plagiarized: 60,
        total_sentences: 5,
        plagiarized_sentences: ["s1", "s2", "s3"],
        plagiarized_content: Array.from({ length: 10 }, (_, i) => ({
          source_url: `https://orig.example/${i}`,
          matched_text: long,
        })),
      })
    );
    const tools = createPangramTools({ config: baseConfig, wait: noWait });
    const out = JSON.parse((await tools.execute(PANGRAM_FIND_SOURCES_TOOL_NAME, { text: "a b c" }))!);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://plagiarism.pangram.example");
    expect(JSON.parse(init.body)).toEqual({ text: "a b c", source: "minerval" });
    expect(mockMeterExternal).toHaveBeenCalledWith(
      expect.objectContaining({ model: "pangram/find_sources", units: 3, costMicroUsd: 3000 })
    );
    expect(out).toMatchObject({ success: true, matches_found: true, percent_matching: 60, matching_sentences: 3 });
    expect(out.sources).toHaveLength(8);
    expect(out.more_sources).toBe(2);
    expect(out.sources[0].source_url).toBe("https://orig.example/0");
    expect(out.sources[0].matched_text.length).toBeLessThan(300);
  });
});
