import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  renderReport,
  summarizeOutcomes,
  validateScenario,
  type ContributionOutcome,
  type Scenario,
} from "../../../scripts/corpus/contributions-lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO = join(here, "../../../corpus/contributions/blackholes.json");

describe("the committed scenario", () => {
  it("is well-formed and exercises every path", () => {
    const s = JSON.parse(readFileSync(SCENARIO, "utf8")) as Scenario;
    expect(validateScenario(s)).toEqual([]);
    const types = new Set(s.contributions.map((c) => c.type));
    for (const t of ["challenge", "support", "propose_edit", "propose_merge", "add_instance", "propose_argument"]) {
      expect(types).toContain(t);
    }
    expect(s.contributions.some((c) => c.appealIfRejected)).toBe(true);
    expect(s.contributions.every((c) => c.expect)).toBe(true);
  });
});

describe("validateScenario", () => {
  it("names the problems", () => {
    const bad = {
      scenario: "x",
      cluster: "x",
      contributors: [{ key: "a", displayName: "A" }],
      contributions: [
        { id: "1", contributor: "nobody", type: "challenge", target: { query: "q" }, content: "c" },
        { id: "1", contributor: "a", type: "propose_merge", target: { query: "q" }, content: "c" },
        { id: "2", contributor: "a", type: "propose_edit", target: { query: "q" }, content: "c", evidenceUrls: ["ftp://x"] },
      ],
    } as unknown as Scenario;
    const problems = validateScenario(bad);
    expect(problems.join("\n")).toMatch(/unknown contributor/);
    expect(problems.join("\n")).toMatch(/duplicate id 1/);
    expect(problems.join("\n")).toMatch(/needs mergeTarget/);
    expect(problems.join("\n")).toMatch(/needs proposedCanonicalForm/);
    expect(problems.join("\n")).toMatch(/not http/);
  });
});

const outcome = (over: Partial<ContributionOutcome>): ContributionOutcome => ({
  id: "o",
  type: "challenge",
  contributor: "p",
  targetClaimId: "c1",
  targetText: "t",
  contributionId: "x",
  reviewStatus: "reviewed",
  review: { decision: "accept", confidence: 0.8, reasoning: "ok", policyCitations: ["P4"], suspectedBadFaith: false, badFaithCategory: null },
  escalationReason: null,
  appeal: null,
  arbitration: null,
  claimChange: { textBefore: "t", textAfter: "t", statusBefore: "supported", statusAfter: "supported" },
  ...over,
});

describe("summarizeOutcomes and renderReport", () => {
  const outcomes = [
    outcome({ id: "a" }),
    outcome({ id: "b", type: "support", review: { decision: "reject", confidence: 0.9, reasoning: "spam", policyCitations: [], suspectedBadFaith: true, badFaithCategory: "spam" }, appeal: { id: "ap", status: "resolved" }, arbitration: { outcome: "uphold_original", decision: "reject", reasoning: "still spam", suspectedBadFaith: false, humanReviewRecommended: false } }),
    outcome({ id: "c", reviewStatus: "escalated", review: { decision: "escalate", confidence: 0.5, reasoning: "hard", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null }, escalationReason: "crux", arbitration: { outcome: "overturn", decision: "accept", reasoning: "substantive", suspectedBadFaith: false, humanReviewRecommended: true }, claimChange: { textBefore: "t", textAfter: "t2", statusBefore: "verified", statusAfter: "contested" } }),
    outcome({ id: "d", contributionId: "y", review: null, reviewStatus: "pending" }),
    outcome({ id: "e", contributionId: null, targetClaimId: null, targetText: null, review: null, claimChange: null }),
  ];

  it("counts decisions, escalations, bad faith, appeals, arbitration and changed claims", () => {
    const s = summarizeOutcomes(outcomes);
    expect(s.submitted).toBe(4);
    expect(s.reviewed).toBe(3);
    expect(s.decisions).toEqual({ accept: 1, reject: 1, escalate: 1 });
    expect(s.decisionsByType.challenge).toEqual({ accept: 1, escalate: 1 });
    expect(s.escalated).toBe(1);
    expect(s.badFaithFlags).toBe(1);
    expect(s.appealsFiled).toBe(1);
    expect(s.arbitrated).toBe(2);
    expect(s.arbitrationOutcomes).toEqual({ uphold_original: 1, overturn: 1 });
    expect(s.humanReviewRecommended).toBe(1);
    expect(s.claimsChanged).toBe(1);
    expect(s.unreviewed).toEqual(["d"]);
  });

  it("renders a report a reader can follow", () => {
    const scenario = JSON.parse(readFileSync(SCENARIO, "utf8")) as Scenario;
    const md = renderReport({
      scenario,
      outcomes,
      summary: summarizeOutcomes(outcomes),
      costMicroUsd: 1_234_000,
      reputation: [{ key: "troll", displayName: "T", before: 50, after: 35, standing: "must_pay" }],
      generatedAt: "2026-09-02T00:00:00Z",
    });
    expect(md).toMatch(/metered cost \$1.2340/);
    expect(md).toMatch(/bad faith: spam/);
    expect(md).toMatch(/\*\*Arbitration:\*\* overturn/);
    expect(md).toMatch(/status: verified → contested/);
    expect(md).toMatch(/50 → 35/);
    expect(md).toMatch(/_not submitted_/);
  });
});
