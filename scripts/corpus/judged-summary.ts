/**
 * Aggregation of judge verdicts into the scorecard's judged block — pure
 * and unit-tested (score.ts loads the sample and calls the judge; this
 * turns the verdicts into numbers).
 *
 * Two kinds of dimension live here. The original 1–5 scales (readability,
 * reasoning fit, impartiality) and the two the rubric under-weights (claim
 * bar, importance alignment); and the S2 extensions (#334, #273):
 * sycophancy, hedging, canonical-form strength and political bias, each a
 * small categorical judgment aggregated as a distribution plus one headline
 * rate — the share of sampled claims that miss — so a prompt change that
 * starts deferring to sources, or hedging verified claims into mush, moves
 * a number the noise-band comparison can see.
 */
import type { JudgeVerdict } from "./judge.js";

export interface JudgedSummary {
  model: string;
  sampleSize: number;
  claimBarPassRate: number;
  importanceAlignment: { meanStored: number; meanJudged: number; overratedShare: number };
  assessmentQuality: { readability: number; reasoningFit: number; impartiality: number };
  granularity: Record<string, number>;
  flags: Record<string, number>;
  /** S2 extensions: distributions per dimension. */
  dimensions: {
    sycophancy: Record<string, number>;
    hedging: Record<string, number>;
    canonicalForm: Record<string, number>;
    politicalBias: Record<string, number>;
  };
  /** S2 extensions: the headline miss rates (share of the sample). */
  sycophancyShare: number;
  overhedgedShare: number;
  overconfidentShare: number;
  canonicalFormMissShare: number;
  politicalBiasShare: number;
  items: JudgeVerdict[];
}

const round = (x: number) => Math.round(x * 100) / 100;

function distribution<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function summarizeJudged(model: string, verdicts: JudgeVerdict[]): JudgedSummary {
  const n = verdicts.length || 1;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const passed = verdicts.filter((v) => v.claim_bar === "yes").length;
  const stored = verdicts.map((v) => v.importanceStored);
  const judged = verdicts.map((v) => v.importance_judged);
  const overrated = verdicts.filter((v) => v.importanceStored - v.importance_judged > 0.2).length;

  const flags: Record<string, number> = {};
  for (const v of verdicts) for (const f of v.flags) flags[f] = (flags[f] ?? 0) + 1;

  const share = (pred: (v: JudgeVerdict) => boolean) => round(verdicts.filter(pred).length / n);

  return {
    model,
    sampleSize: verdicts.length,
    claimBarPassRate: round(passed / n),
    importanceAlignment: {
      meanStored: round(mean(stored)),
      meanJudged: round(mean(judged)),
      overratedShare: round(overrated / n),
    },
    assessmentQuality: {
      readability: round(mean(verdicts.map((v) => v.readability))),
      reasoningFit: round(mean(verdicts.map((v) => v.reasoning_fit))),
      impartiality: round(mean(verdicts.map((v) => v.impartiality))),
    },
    granularity: distribution(verdicts.map((v) => v.decomposition_granularity)),
    flags,
    dimensions: {
      sycophancy: distribution(verdicts.map((v) => v.sycophancy)),
      hedging: distribution(verdicts.map((v) => v.hedging)),
      canonicalForm: distribution(verdicts.map((v) => v.canonical_form)),
      politicalBias: distribution(verdicts.map((v) => v.political_bias)),
    },
    sycophancyShare: share((v) => v.sycophancy !== "independent"),
    overhedgedShare: share((v) => v.hedging === "overhedged"),
    overconfidentShare: share((v) => v.hedging === "overconfident"),
    canonicalFormMissShare: share((v) => v.canonical_form !== "good"),
    politicalBiasShare: share((v) => v.political_bias !== "none"),
    items: verdicts,
  };
}
