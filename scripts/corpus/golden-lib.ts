/**
 * Golden-pair grading (#334 S1) — the pure half of the Matcher golden suite.
 *
 * Fixture loading/validation and decision grading, with no DB or LLM
 * dependencies, so the unit suite can pin (a) that the committed fixture set
 * stays well-formed and (b) exactly what counts as a pass. The runner
 * (golden-matcher.ts) owns seeding and invoking the real Matcher.
 *
 * Grading is exact-match on (is_match, matched claim, stance). That is
 * appropriate HERE and almost nowhere else: matching is the one saturating
 * task (§19) with stable enough judgments for golden labels — assessments
 * and decompositions are judged, never exact-matched.
 */
import { readFileSync } from "node:fs";
import type { MatchDecision } from "../../src/llm/agents/matcher.js";

export const GOLDEN_CATEGORIES = [
  "paraphrase",
  "negation",
  "specification",
  "similar_but_different",
  "hard",
] as const;
export type GoldenCategory = (typeof GOLDEN_CATEGORIES)[number];

export interface GoldenPair {
  id: string;
  category: GoldenCategory;
  /** Claims seeded into the graph; index 0 is the counterpart on match pairs. */
  existing: string[];
  candidate: { extractedText: string; proposedCanonical: string };
  expect:
    | { isMatch: true; matchedIndex: number; stance: "affirms" | "denies" }
    | { isMatch: false };
  note: string;
}

export interface GoldenFixture {
  version: number;
  description: string;
  pairs: GoldenPair[];
}

export function loadGoldenFixture(path: string): GoldenFixture {
  return JSON.parse(readFileSync(path, "utf-8")) as GoldenFixture;
}

/** Structural validation; returns human-readable problems (empty = valid). */
export function validateGoldenFixture(fixture: GoldenFixture): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const pair of fixture.pairs ?? []) {
    const where = `pair "${pair.id ?? "?"}"`;
    if (!pair.id) problems.push("a pair is missing an id");
    else if (ids.has(pair.id)) problems.push(`duplicate id "${pair.id}"`);
    else ids.add(pair.id);

    if (!GOLDEN_CATEGORIES.includes(pair.category)) {
      problems.push(`${where}: unknown category "${pair.category}"`);
    }
    if (!Array.isArray(pair.existing) || pair.existing.length === 0) {
      problems.push(`${where}: needs at least one existing claim`);
    }
    if (!pair.candidate?.extractedText || !pair.candidate?.proposedCanonical) {
      problems.push(`${where}: candidate needs extractedText and proposedCanonical`);
    }
    if (!pair.note) problems.push(`${where}: missing note (the why matters)`);
    if (pair.expect?.isMatch === true) {
      if (
        !Number.isInteger(pair.expect.matchedIndex) ||
        pair.expect.matchedIndex < 0 ||
        pair.expect.matchedIndex >= (pair.existing?.length ?? 0)
      ) {
        problems.push(`${where}: matchedIndex out of range`);
      }
      if (pair.expect.stance !== "affirms" && pair.expect.stance !== "denies") {
        problems.push(`${where}: match pairs need stance affirms|denies`);
      }
    } else if (pair.expect?.isMatch !== false) {
      problems.push(`${where}: expect.isMatch must be true or false`);
    }
  }
  if ((fixture.pairs?.length ?? 0) < 25) {
    problems.push(`fixture has ${fixture.pairs?.length ?? 0} pairs; the suite wants ≥25`);
  }
  return problems;
}

export interface PairResult {
  id: string;
  category: GoldenCategory;
  pass: boolean;
  failures: string[];
  decision: Pick<MatchDecision, "is_match" | "instance_stance" | "confidence" | "reasoning">;
  /**
   * How many Matcher calls this pair took (1 = passed or failed first try).
   * >1 means the pair failed and was retried: the decision recorded above is
   * the LAST attempt's. Retries exist because some pins sit on a genuine
   * decision boundary — measured live, neg-03 and spec-05 each fail roughly 1
   * run in 6 on deepseek-v4-flash while passing 5/5 in isolation — and a gate
   * that blocks the repo one run in three is worse than no gate. A pair that
   * is actually broken fails every attempt.
   */
  attempts?: number;
}

/**
 * Grade one Matcher decision. `seededIds[i]` is the DB id the runner gave
 * `existing[i]` for this pair.
 */
export function gradeDecision(
  pair: GoldenPair,
  decision: MatchDecision,
  seededIds: string[]
): PairResult {
  const failures: string[] = [];
  if (pair.expect.isMatch) {
    if (!decision.is_match) {
      failures.push("expected a match; matcher created a new claim");
    } else {
      const wanted = seededIds[pair.expect.matchedIndex];
      if (decision.matched_claim_id !== wanted) {
        failures.push(
          `matched the wrong claim (got ${decision.matched_claim_id ?? "null"}, ` +
            `wanted existing[${pair.expect.matchedIndex}])`
        );
      }
      if (decision.instance_stance !== pair.expect.stance) {
        failures.push(
          `wrong stance (got ${decision.instance_stance}, wanted ${pair.expect.stance})`
        );
      }
    }
  } else if (decision.is_match) {
    failures.push(
      `expected no match; matcher absorbed it into an existing claim ` +
        `(${decision.matched_claim_id ?? "?"})`
    );
  }
  return {
    id: pair.id,
    category: pair.category,
    pass: failures.length === 0,
    failures,
    decision: {
      is_match: decision.is_match,
      instance_stance: decision.instance_stance,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    },
  };
}

export interface GoldenSummary {
  total: number;
  passed: number;
  passRate: number;
  byCategory: Record<string, { total: number; passed: number }>;
  /**
   * Pairs that failed at least once and passed on a retry. A green run with a
   * rising count here is the suite degrading toward the boundary — the signal
   * that retries would otherwise hide, so it is reported alongside the rate
   * rather than folded into it.
   */
  passedOnRetry: string[];
}

export function summarize(results: PairResult[]): GoldenSummary {
  const byCategory: GoldenSummary["byCategory"] = {};
  let passed = 0;
  const passedOnRetry: string[] = [];
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, passed: 0 });
    c.total++;
    if (r.pass) {
      c.passed++;
      passed++;
      if ((r.attempts ?? 1) > 1) passedOnRetry.push(r.id);
    }
  }
  return {
    total: results.length,
    passed,
    passRate: results.length ? Math.round((passed / results.length) * 1000) / 1000 : 0,
    byCategory,
    passedOnRetry,
  };
}
