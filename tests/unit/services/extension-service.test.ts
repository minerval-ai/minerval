import { describe, it, expect } from "vitest";

import {
  AnalysisCache,
  buildAnnotations,
  extractCitedClaimIds,
  pageCacheKey,
} from "../../../src/services/extension-service.js";
import type { ClaimVerdict } from "../../../src/llm/agents/extension-agent.js";

describe("pageCacheKey", () => {
  it("is stable for identical url + content", () => {
    expect(pageCacheKey("https://a.example/x", "hello world")).toBe(
      pageCacheKey("https://a.example/x", "hello world")
    );
  });

  it("changes when either url or content changes", () => {
    const base = pageCacheKey("https://a.example/x", "hello world");
    expect(pageCacheKey("https://a.example/y", "hello world")).not.toBe(base);
    expect(pageCacheKey("https://a.example/x", "hello world!")).not.toBe(base);
  });
});

describe("AnalysisCache", () => {
  it("returns entries before TTL and drops them after", () => {
    const cache = new AnalysisCache<string>(1000, 10);
    cache.set("k", "v", 0);
    expect(cache.get("k", 999)).toBe("v");
    expect(cache.get("k", 1000)).toBeNull();
    // expired entry is actually removed
    expect(cache.get("k", 0)).toBeNull();
  });

  it("evicts the oldest entry at capacity", () => {
    const cache = new AnalysisCache<number>(60_000, 2);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    expect(cache.get("a", 1)).toBeNull();
    expect(cache.get("b", 1)).toBe(2);
    expect(cache.get("c", 1)).toBe(3);
  });

  it("sweeps expired entries on write, not only on read (#356)", () => {
    const cache = new AnalysisCache<number>(1000, 10);
    cache.set("a", 1, 0);
    cache.set("b", 2, 1000);
    // "a" expired at t=1000 and nobody read it; the write swept it anyway.
    expect(cache.get("a", 0)).toBeNull();
    expect(cache.get("b", 1000)).toBe(2);
  });

  it("overwriting an existing key does not evict", () => {
    const cache = new AnalysisCache<number>(60_000, 2);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("b", 20, 0);
    expect(cache.get("a", 1)).toBe(1);
    expect(cache.get("b", 1)).toBe(20);
  });
});

describe("buildAnnotations", () => {
  const matched = {
    claimId: "22222222-2222-2222-2222-222222222222",
    canonicalForm: "GDP fell in 2020",
    status: "verified",
    statusConfidence: 0.9,
    subclaimCount: 3,
    claimUrl: "https://minerval.ai/claims/22222222-2222-2222-2222-222222222222",
  };
  const base = {
    original_text: "GDP dropped in 2020",
    context: null,
    source_location: null,
    stance: "affirms" as const,
  };

  it("carries the assessor's verdict for matched claims", () => {
    const verdicts = new Map<number, ClaimVerdict>([
      [0, { index: 0, verdict: "egregious", why: "why", confidence: 0.9 }],
    ]);
    const [a] = buildAnnotations({
      claims: [{ ...base, matched }],
      verdicts,
    });
    expect(a!.verdict).toBe("egregious");
    expect(a!.why).toBe("why");
    expect(a!.claim?.id).toBe(matched.claimId);
    expect(a!.claim?.url).toContain("/claims/");
  });

  it("fails safe to 'fine' (no markup) when the assessor dropped a claim", () => {
    const [a] = buildAnnotations({
      claims: [{ ...base, matched }],
      verdicts: new Map(),
    });
    expect(a!.verdict).toBe("fine");
    expect(a!.confidence).toBe(0);
  });

  it("marks unmatched claims 'unknown' with no claim payload", () => {
    const [a] = buildAnnotations({
      claims: [{ ...base, matched: null }],
      verdicts: new Map(),
    });
    expect(a!.verdict).toBe("unknown");
    expect(a!.claim).toBeNull();
  });
});

describe("extractCitedClaimIds", () => {
  it("extracts, lowercases and dedupes [claim:<uuid>] markers", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const reply =
      `Per the graph [claim:${id}], and again [claim:${id.toUpperCase()}], ` +
      `but [claim:not-a-uuid] is ignored.`;
    expect(extractCitedClaimIds(reply)).toEqual([id]);
  });

  it("returns empty for replies without citations", () => {
    expect(extractCitedClaimIds("no markers here")).toEqual([]);
  });
});
