import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The async analyze state machine (#93): startAnalysis answers within its
 * grace window (ready/failed) or hands off to polling (running), with the
 * pipeline mocked at the agent boundary.
 */
const mocks = vi.hoisted(() => ({
  extractClaims: vi.fn(),
  matchClaim: vi.fn(),
}));

vi.mock("../../../src/llm/agents/extractor.js", () => ({
  extractClaims: mocks.extractClaims,
}));
vi.mock("../../../src/llm/agents/matcher.js", () => ({
  matchClaim: mocks.matchClaim,
}));
vi.mock("../../../src/llm/agents/extension-agent.js", () => ({
  assessPageClaims: vi.fn(async () => []),
  extensionChat: vi.fn(),
  EXTENSION_VERDICTS: ["egregious", "contested", "oversimplified", "noteworthy", "fine"],
}));

import {
  startAnalysis,
  getAnalysisByHash,
  resetAnalysisCache,
  pageCacheKey,
} from "../../../src/services/extension-service.js";

const INPUT = {
  url: "https://example.com/article",
  title: "Article",
  content: "Some page content with a claim in it.",
};
const HASH = pageCacheKey(INPUT.url, INPUT.content);

const EXTRACTED = [
  {
    verbatim_text: "a claim",
    context: null,
    proposed_canonical_form: "A claim.",
    claim_type: "empirical_verifiable",
    confidence: 0.9,
    importance: 0.5,
    source_location: null,
  },
];

const NO_MATCH = {
  is_match: false,
  matched_claim_id: null,
  new_canonical_form: "A claim.",
  instance_stance: "affirms" as const,
  confidence: 0.4,
  reasoning: "novel",
  alternative_matches: [],
  relationship_notes: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntilNotRunning(hash: string): Promise<void> {
  for (let i = 0; i < 100 && getAnalysisByHash(hash).state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  resetAnalysisCache();
  mocks.extractClaims.mockReset();
  mocks.matchClaim.mockReset();
  mocks.matchClaim.mockResolvedValue(NO_MATCH);
});

describe("startAnalysis", () => {
  it("returns ready within the grace window and caches the result", async () => {
    mocks.extractClaims.mockResolvedValue(EXTRACTED);

    const first = await startAnalysis(INPUT, { graceMs: 2000 });
    expect(first.state).toBe("ready");
    if (first.state !== "ready") return;
    expect(first.cached).toBe(false);
    expect(first.analysis.content_hash).toBe(HASH);
    expect(first.analysis.annotations[0]?.verdict).toBe("unknown");

    const second = await startAnalysis(INPUT, { graceMs: 2000 });
    expect(second).toMatchObject({ state: "ready", cached: true });
    expect(mocks.extractClaims).toHaveBeenCalledTimes(1);
  });

  it("hands off to polling when the run outlasts the grace window", async () => {
    const gate = deferred<typeof EXTRACTED>();
    mocks.extractClaims.mockReturnValue(gate.promise);

    const started = await startAnalysis(INPUT, { graceMs: 10 });
    expect(started).toEqual({ state: "running", content_hash: HASH });
    expect(getAnalysisByHash(HASH).state).toBe("running");

    gate.resolve(EXTRACTED);
    await waitUntilNotRunning(HASH);

    const polled = getAnalysisByHash(HASH);
    expect(polled.state).toBe("ready");
    if (polled.state === "ready") {
      expect(polled.analysis.stats.extracted).toBe(1);
    }
  });

  it("reports failure, exposes it to pollers, and lets a new POST retry", async () => {
    mocks.extractClaims.mockRejectedValueOnce(new Error("LLM exploded"));

    const failed = await startAnalysis(INPUT, { graceMs: 2000 });
    expect(failed).toMatchObject({ state: "failed", content_hash: HASH });
    if (failed.state === "failed") expect(failed.error).toContain("LLM exploded");
    expect(getAnalysisByHash(HASH)).toMatchObject({ state: "failed" });

    // A fresh POST retries rather than replaying the cached failure.
    mocks.extractClaims.mockResolvedValue(EXTRACTED);
    const retried = await startAnalysis(INPUT, { graceMs: 2000 });
    expect(retried.state).toBe("ready");
  });

  it("returns unknown for a hash nobody started", () => {
    expect(getAnalysisByHash("0".repeat(64))).toEqual({ state: "unknown" });
  });
});
