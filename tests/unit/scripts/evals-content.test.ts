import { describe, expect, it } from "vitest";

import {
  agentOfEnvVar,
  buildEvalsIndex,
  modelLabel,
  parseReviewSheet,
  parseRubric,
  slugifyHeading,
  type EvalsIndexInput,
} from "../../../scripts/evals-content.js";

const RUBRIC = `# Ingestion Review Rubric

Intro text.

## A. Extraction — what got pulled out of the document

**Standard.** Extract *all* substantive claims, faithfully.
Second line of the standard (Constitution §2).

**Failure modes.**
- Under-extraction

## C. Matching / canonicalization / dedup — **the core test**

Some preface.

**Standard.** Two formulations are the same claim when they turn on the same considerations.

## I. Field notes

No standard here.
`;

const input: EvalsIndexInput = {
  syncedAt: "2026-09-04T12:00:00.000Z",
  gitCommit: "abc1234",
  pins: [
    { envVar: "STEWARD_MODEL", model: "claude-fable-5-1" },
    { envVar: "MATCHER_MODEL", model: "deepseek/deepseek-v4-flash" },
    { envVar: "EXTRACTOR_FALLBACK_MODEL", model: "claude-opus-4-8" },
  ],
  judgeModel: "claude-sonnet-5",
  ratesFor: (m) =>
    m.startsWith("claude-fable")
      ? { inputPerMtok: 10, outputPerMtok: 50 }
      : m.startsWith("claude-sonnet")
        ? { inputPerMtok: 3, outputPerMtok: 15 }
        : m.startsWith("claude-opus")
          ? { inputPerMtok: 5, outputPerMtok: 25 }
          : null,
  clusters: [
    {
      key: "eggs",
      kind: "web",
      description: "The health effects of eggs.",
      source: "Curated markdown.",
      words: 1710,
      posts: [
        { id: "a", title: "A", author: "Harvard", url: "https://x", role: "overview" },
        { id: "b", title: "B" },
      ],
    },
  ],
  golden: {
    version: "1",
    description: "Pinned pairs.",
    pairs: [
      { id: "neg-01", category: "negation" },
      { id: "neg-02", category: "negation" },
      { id: "para-01", category: "paraphrase" },
    ],
  },
  predictions: {
    authoredAt: "2026-09-02",
    predictions: [
      { id: "p1", domain: "science", resolutionDate: "2027-01-31" },
      { id: "p2", domain: "economics", resolutionDate: "2026-10-31" },
      { id: "p3", domain: "science", resolutionDate: "2027-09-02" },
    ],
  },
  contributions: [
    {
      scenario: "blackholes",
      cluster: "blackholes",
      contributors: [{ key: "physicist" }, { key: "troll" }],
      contributions: [
        { type: "support" },
        { type: "challenge", appealIfRejected: "because" },
        { type: "challenge" },
      ],
    },
  ],
  reviews: [
    {
      file: "blackholes-2026-08-09-832f7f15-review.md",
      text: "# Judge-review sheet — blackholes\n\neval_run: 832f7f15-3063\n\n```overall\nReviewed 2026-09-02 (Claude pass).\n```\n",
    },
  ],
  scorecardFiles: [
    { cluster: "eggs", file: "2026-09-10T00-00-00-000Z.json" },
    { cluster: "blackholes", file: "2026-08-09T15-47-32-753Z.json" },
  ],
  goldenRunFiles: ["2026-08-08-deepseek-v4-flash.json"],
  rubric: RUBRIC,
};

describe("evals content index", () => {
  it("slugs headings the way the site's Markdown renderer does", () => {
    expect(slugifyHeading("A. Extraction — what got pulled out of the document")).toBe(
      "a-extraction-what-got-pulled-out-of-the-document"
    );
    expect(slugifyHeading("C. Matching / canonicalization / dedup — the core test")).toBe(
      "c-matching-canonicalization-dedup-the-core-test"
    );
  });

  it("parses the rubric's sections and their Standard paragraphs", () => {
    const r = parseRubric(RUBRIC);
    expect(r.map((x) => x.letter)).toEqual(["A", "C", "I"]);
    expect(r[0]).toEqual({
      letter: "A",
      title: "A. Extraction — what got pulled out of the document",
      slug: "a-extraction-what-got-pulled-out-of-the-document",
      standard: "Extract all substantive claims, faithfully. Second line of the standard (Constitution §2).",
    });
    expect(r[1]!.title).toBe("C. Matching / canonicalization / dedup — the core test");
    expect(r[1]!.standard).toBe("Two formulations are the same claim when they turn on the same considerations.");
    expect(r[2]!.standard).toBe("");
    expect(buildEvalsIndex(input).rubric).toHaveLength(3);
  });

  it("labels the models the system pins and falls back to the id", () => {
    expect(modelLabel("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelLabel("deepseek/deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(modelLabel("mistral/large")).toBe("mistral/large");
  });

  it("names the agent from its env var", () => {
    expect(agentOfEnvVar("STEWARD_MODEL")).toBe("steward");
    expect(agentOfEnvVar("EXTRACTOR_FALLBACK_MODEL")).toBe("extractor fallback");
  });

  it("parses a filled review sheet's cluster, run and date", () => {
    const r = parseReviewSheet("x.md", input.reviews[0]!.text);
    expect(r).toEqual({ file: "x.md", cluster: "blackholes", evalRun: "832f7f15-3063", reviewedOn: "2026-09-02" });
    expect(parseReviewSheet("y.md", "# nothing")).toEqual({ file: "y.md", cluster: null, evalRun: null, reviewedOn: null });
  });

  it("builds the index with rates for every model on the page, null where provider-priced", () => {
    const idx = buildEvalsIndex(input);
    expect(idx.pins.map((p) => [p.agent, p.label])).toEqual([
      ["steward", "Claude Fable 5.1"],
      ["matcher", "DeepSeek V4 Flash"],
      ["extractor fallback", "Claude Opus 4.8"],
    ]);
    expect(idx.judge).toEqual({ model: "claude-sonnet-5", label: "Claude Sonnet 5" });
    expect(idx.rates["claude-fable-5-1"]).toEqual({ inputPerMtok: 10, outputPerMtok: 50 });
    expect(idx.rates["claude-sonnet-5"]).toEqual({ inputPerMtok: 3, outputPerMtok: 15 });
    expect(idx.rates["deepseek/deepseek-v4-flash"]).toBeNull();
  });

  it("summarises clusters, fixtures and scenarios", () => {
    const idx = buildEvalsIndex(input);
    expect(idx.clusters[0]).toMatchObject({ key: "eggs", kind: "web", posts: 2, words: 1710 });
    expect(idx.clusters[0]!.sources[1]).toEqual({ id: "b", title: "B", author: undefined, url: undefined, role: undefined });
    expect(idx.golden).toEqual({
      pairs: 3,
      byCategory: { negation: 2, paraphrase: 1 },
      version: "1",
      description: "Pinned pairs.",
    });
    expect(idx.predictions).toEqual({
      count: 3,
      authoredAt: "2026-09-02",
      byDomain: { science: 2, economics: 1 },
      firstResolution: "2026-10-31",
      lastResolution: "2027-09-02",
    });
    expect(idx.contributions[0]).toEqual({
      scenario: "blackholes",
      cluster: "blackholes",
      personas: 2,
      contributions: 3,
      byType: { support: 1, challenge: 2 },
      withAppeal: 1,
    });
  });

  it("sorts the run records so the page's history is deterministic", () => {
    const idx = buildEvalsIndex(input);
    expect(idx.scorecards.map((s) => s.cluster)).toEqual(["blackholes", "eggs"]);
    expect(idx.reviews[0]!.reviewedOn).toBe("2026-09-02");
    expect(idx.goldenRuns).toEqual(["2026-08-08-deepseek-v4-flash.json"]);
  });
});
