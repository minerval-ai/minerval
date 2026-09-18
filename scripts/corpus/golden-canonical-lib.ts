/**
 * Canonical-form golden fixtures (#334 S1, addendum of 2026-08-11) — the
 * pure half. Pinned (source excerpt → expected §3 canonical form) cases, the
 * proposal-selection arithmetic, the pair-judge prompt and schema, and the
 * grading/summary, with no DB or LLM dependency so the unit suite can pin
 * (a) that the committed fixture stays well-formed and (b) exactly what
 * counts as a pass. The runner (golden-canonical.ts) owns invoking the real
 * Extractor, the embedding service and the judge.
 *
 * What it catches: a prompt or model change that starts REWRITING good
 * wording — bending a form toward the author, sharpening it with a parameter
 * no source committed to, flipping its direction, or hedging it into mush.
 * The Matcher golden suite grades decisions exact-match; canonical forms
 * are prose, so the grade is a three-question pair judgment (same
 * proposition? same direction? neutral, no invented specificity?) on
 * JUDGE_MODEL, and pass = all three yes. Near-deterministic in practice
 * because the questions are narrow; cents per run.
 */
import { readFileSync } from "node:fs";

export const CANONICAL_CATEGORIES = [
  /** The source argues AGAINST the proposition; the form must still state the affirmative the discourse debates. */
  "direction",
  /** The source's framing, dialectical setup or author must be stripped. */
  "neutrality",
  /** A claim about a specific population/condition must keep its scope, not generalize or narrow. */
  "scope",
  /** The source already states the proposition in near-canonical wording; it must survive untouched in substance. */
  "survive",
  /** A hedged or qualified assertion: the form states the proposition, not the hedge. */
  "hedging",
  /** A vague proposition must not be sharpened with parameters the author never committed to. */
  "specificity",
] as const;
export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

export interface CanonicalCase {
  id: string;
  category: CanonicalCategory;
  /** The corpus post the excerpt is taken from (cluster/post id), for provenance. */
  sourceTitle: string;
  /** 2–4 sentences, verbatim from the committed corpus post. */
  excerpt: string;
  /** The §3 canonical form the excerpt's central proposition should take. */
  expected: string;
  note: string;
}

export interface CanonicalFixture {
  version: number;
  description: string;
  cases: CanonicalCase[];
}

export function loadCanonicalFixture(path: string): CanonicalFixture {
  return JSON.parse(readFileSync(path, "utf-8")) as CanonicalFixture;
}

/** Structural validation; returns human-readable problems (empty = valid). */
export function validateCanonicalFixture(fixture: CanonicalFixture): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of fixture.cases ?? []) {
    const where = `case "${c.id ?? "?"}"`;
    if (!c.id) problems.push("a case is missing an id");
    else if (ids.has(c.id)) problems.push(`duplicate id "${c.id}"`);
    else ids.add(c.id);
    if (!CANONICAL_CATEGORIES.includes(c.category)) {
      problems.push(`${where}: unknown category "${c.category}"`);
    }
    if (!c.sourceTitle) problems.push(`${where}: missing sourceTitle`);
    if (!c.excerpt || c.excerpt.trim().split(/\s+/).length < 15) {
      problems.push(`${where}: excerpt too short to extract from (want 2–4 sentences)`);
    }
    const words = c.expected?.trim().split(/\s+/).length ?? 0;
    if (!c.expected) problems.push(`${where}: missing expected form`);
    else if (words > 30) problems.push(`${where}: expected form is ${words} words; §3 wants ~15, rarely over 25`);
    if (/\[[^\]]*\]/.test(c.expected ?? "")) {
      problems.push(`${where}: expected form carries a placeholder like "[year]" — §3 forbids them`);
    }
    if (!c.note) problems.push(`${where}: missing note (the why matters)`);
  }
  if ((fixture.cases?.length ?? 0) < 15) {
    problems.push(`fixture has ${fixture.cases?.length ?? 0} cases; the suite wants ≥15`);
  }
  return problems;
}

// --- proposal selection -----------------------------------------------------

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * The proposed canonical form closest to the expected one, by embedding
 * cosine. The Extractor may return several claims from one excerpt (the cap
 * is 1–3); the case is about the one the excerpt turns on, and the closest
 * proposal is the fair candidate for it. Returns null when nothing was
 * proposed.
 */
export function pickClosest(
  expectedEmbedding: number[],
  proposals: Array<{ text: string; embedding: number[] }>
): { index: number; text: string; similarity: number } | null {
  let best: { index: number; text: string; similarity: number } | null = null;
  proposals.forEach((p, index) => {
    const similarity = cosine(expectedEmbedding, p.embedding);
    if (!best || similarity > best.similarity) best = { index, text: p.text, similarity };
  });
  return best;
}

// --- the pair judge -----------------------------------------------------------

/** The §3 standard the pair judge grades against, pinned verbatim into the prompt. */
export const CANONICAL_FORM_STANDARD = `Canonical form (Minerval constitution §3): the shortest neutral statement of the proposition as it is actually debated, about fifteen words and rarely more than twenty-five, stated at the precision the discourse debates it. It strips the frame — the author's name, the document's dialectical setup, document-relative references — and is worded so that anyone discussing the proposition, whichever answer they give, would accept it as a fair statement of what is in dispute. It is written in the direction the discourse poses the question (the affirmative form of what is argued, as a debate motion or neutral headline would put it) even when the source argues against it; the source's stance is recorded on the instance, never by bending the form. It is not sharpened with parameters, thresholds or dates the author never committed to, and a vague proposition stays vague. Qualifications and hedges belong to the source's wording, not to the form.`;

export interface CanonicalJudgeVerdict {
  same_proposition: boolean;
  same_direction: boolean;
  neutral_no_invented_specificity: boolean;
  note: string;
}

export const CANONICAL_JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    same_proposition: {
      type: "boolean",
      description:
        "Do the two forms state the SAME proposition — would the same evidence and reasons bear on both, and would a source that affirms one thereby affirm the other? Wording may differ freely; substance may not.",
    },
    same_direction: {
      type: "boolean",
      description:
        "Are the two forms stated in the same direction — does the proposed form affirm what the expected form affirms, rather than its negation or denial? A form that states the contrary proposition (\"X does not…\" against \"X does…\") is the wrong direction even though it is the same node.",
    },
    neutral_no_invented_specificity: {
      type: "boolean",
      description:
        "Is the proposed form neutral (no author framing, no dialectical setup, no document-relative references, no hedges carried into the form) AND free of specificity the expected form does not carry (no added numbers, thresholds, dates, named studies, mechanisms, or qualifiers that narrow or sharpen the proposition)?",
    },
    note: { type: "string", description: "One sentence: the single most important difference, or 'equivalent' when there is none." },
  },
  required: ["same_proposition", "same_direction", "neutral_no_invented_specificity", "note"],
  // Required by native structured outputs' strict schema subset.
  additionalProperties: false,
};

/**
 * The exact prompt a case is judged with. Pure, so the evals guide can
 * render it verbatim (#368) with placeholders where the case's fields go.
 */
export function buildCanonicalJudgePrompt(input: {
  excerpt: string;
  expected: string;
  proposed: string;
}): string {
  return `You are comparing two candidate canonical forms for the central proposition of a source excerpt, against the standard below. One is the pinned EXPECTED form; the other was PROPOSED by an extraction agent. Answer three narrow questions about the proposed form relative to the expected one. This is a comparison of substance, not style: different words for the same proposition in the same direction with no added specificity is a full pass.

${CANONICAL_FORM_STANDARD}

## Source excerpt
${input.excerpt}

## Expected canonical form
${input.expected}

## Proposed canonical form
${input.proposed}

Answer: same proposition? same direction? neutral and no invented specificity? Then one sentence on the most important difference.`;
}

// --- grading -----------------------------------------------------------------

export interface CanonicalCaseResult {
  id: string;
  category: CanonicalCategory;
  expected: string;
  /** Every form the Extractor proposed for the excerpt, verbatim. */
  proposals: string[];
  /** The proposal judged (closest to expected by embedding), or null when none was proposed. */
  proposed: string | null;
  similarity: number | null;
  verdict: CanonicalJudgeVerdict | null;
  pass: boolean;
  failures: string[];
}

/**
 * Grade one case. Pass requires a proposal AND all three judge answers yes.
 * No proposal at all is a fail of its own kind (the excerpt turns on a
 * claim; extracting nothing from it is a regression too).
 */
export function gradeCanonicalCase(
  c: CanonicalCase,
  proposals: string[],
  proposed: { text: string; similarity: number } | null,
  verdict: CanonicalJudgeVerdict | null
): CanonicalCaseResult {
  const failures: string[] = [];
  if (!proposed) failures.push("extractor proposed no claim for the excerpt");
  else if (!verdict) failures.push("judge returned no verdict");
  else {
    if (!verdict.same_proposition) failures.push("different proposition");
    if (!verdict.same_direction) failures.push("direction flipped");
    if (!verdict.neutral_no_invented_specificity) failures.push("not neutral or added specificity");
  }
  return {
    id: c.id,
    category: c.category,
    expected: c.expected,
    proposals,
    proposed: proposed?.text ?? null,
    similarity: proposed?.similarity ?? null,
    verdict,
    pass: failures.length === 0,
    failures,
  };
}

export interface CanonicalSummary {
  total: number;
  passed: number;
  passRate: number;
  byCategory: Record<string, { total: number; passed: number }>;
  /** How the failures distribute over the three questions (a case can miss several). */
  misses: { noProposal: number; proposition: number; direction: number; neutrality: number };
  /** Plain-language reading of the run. */
  reading: string;
}

export function summarizeCanonical(results: CanonicalCaseResult[]): CanonicalSummary {
  const byCategory: CanonicalSummary["byCategory"] = {};
  const misses = { noProposal: 0, proposition: 0, direction: 0, neutrality: 0 };
  let passed = 0;
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, passed: 0 });
    c.total++;
    if (r.pass) {
      c.passed++;
      passed++;
    }
    if (!r.proposed) misses.noProposal++;
    if (r.verdict && !r.verdict.same_proposition) misses.proposition++;
    if (r.verdict && !r.verdict.same_direction) misses.direction++;
    if (r.verdict && !r.verdict.neutral_no_invented_specificity) misses.neutrality++;
  }
  const total = results.length;
  const passRate = total ? Math.round((passed / total) * 1000) / 1000 : 0;
  const parts: string[] = [];
  if (total === 0) parts.push("no cases ran.");
  else {
    parts.push(`${passed} of ${total} pinned canonical forms survived extraction (${Math.round(passRate * 100)}%).`);
    if (misses.direction > 0) parts.push(`${misses.direction} came back in the wrong direction — the Extractor bent the form toward the source's stance instead of the debated affirmative.`);
    if (misses.neutrality > 0) parts.push(`${misses.neutrality} lost neutrality or gained specificity no source committed to.`);
    if (misses.proposition > 0) parts.push(`${misses.proposition} stated a different proposition than the excerpt turns on.`);
    if (misses.noProposal > 0) parts.push(`${misses.noProposal} excerpt(s) yielded no claim at all.`);
    const survive = byCategory.survive;
    if (survive && survive.total > 0 && survive.passed < survive.total) {
      parts.push(`${survive.total - survive.passed} of ${survive.total} already-correct forms were rewritten in substance — the regression this suite exists to catch.`);
    }
  }
  return { total, passed, passRate, byCategory, misses, reading: parts.join(" ") };
}
