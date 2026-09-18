/**
 * Model adoption (#334 S7 / #324 "adopt") — the pure half.
 *
 * A candidate model for one agent runs that agent's eval suite with the
 * judge pinned, and its quality per dollar is set against the incumbent's:
 *   - matcher: the golden pairs (corpus:golden) on candidate and incumbent —
 *     pass rate per dollar — plus, when a cluster is given, a model swap
 *     (corpus:swap) for fidelity to the incumbent's graph;
 *   - extractor / steward / curator: a model swap on the cluster — the
 *     fidelity summary (claim-set F1, credence divergence, status agreement,
 *     edge edit distance) against the reference arm, with each arm's cost.
 * The summary is one line: adopt / hold / reject — and a human decides. No
 * pin is flipped here; the load-bearing agents' models are declared in
 * infra/lib/api-stack.ts and changed by a reviewed PR.
 *
 * The plan (which child commands run) and the summary live here, DB- and
 * LLM-free; adopt.ts runs the children and reads their reports.
 */
import type { SwapSummary, SwappableAgent } from "./swap-lib.js";

export type AdoptAgent = SwappableAgent;

export interface AdoptChild {
  script: string;
  args: string[];
  env: Record<string, string>;
  /** What this child establishes. */
  role: "golden-candidate" | "golden-incumbent" | "swap";
}

/**
 * The children an adoption runs. The matcher has a cheap, saturating suite
 * of its own, so it always runs the golden pairs on both models and adds a
 * swap only when a cluster is named; the other agents have no per-decision
 * golden set and are judged by fidelity to the reference graph.
 */
export function buildAdoptPlan(opts: {
  agent: AdoptAgent;
  model: string;
  incumbent: string;
  cluster?: string | null;
  profile?: string | null;
  baselineSnapshot?: string | null;
  limit?: number;
}): AdoptChild[] {
  const profile = opts.profile ? [`--profile=${opts.profile}`] : [];
  const plan: AdoptChild[] = [];
  if (opts.agent === "matcher") {
    plan.push({ script: "scripts/corpus/golden-matcher.ts", args: [...profile, `--model=${opts.model}`], env: {}, role: "golden-candidate" });
    plan.push({ script: "scripts/corpus/golden-matcher.ts", args: [...profile, `--model=${opts.incumbent}`], env: {}, role: "golden-incumbent" });
  }
  if (opts.cluster || opts.agent !== "matcher") {
    if (!opts.cluster) throw new Error(`--cluster is required to adopt a ${opts.agent} model (its suite is a model swap on a cluster)`);
    const args = [opts.cluster, `--agent=${opts.agent}`, `--model=${opts.model}`, ...profile];
    if (opts.limit !== undefined) args.push(`--limit=${opts.limit}`);
    if (opts.baselineSnapshot) args.push(`--baseline=${opts.baselineSnapshot}`);
    plan.push({ script: "scripts/corpus/swap.ts", args, env: {}, role: "swap" });
  }
  return plan;
}

export interface GoldenArm {
  model: string;
  passRate: number;
  passed: number;
  total: number;
  costMicroUsd: number;
}

export interface AdoptSummary {
  agent: AdoptAgent;
  candidate: string;
  incumbent: string;
  golden: {
    candidate: GoldenArm;
    incumbent: GoldenArm;
    /** Pass rate per dollar, each side; null when a side cost nothing (unmetered). */
    qualityPerDollar: { candidate: number | null; incumbent: number | null };
    passRateDelta: number;
  } | null;
  swap: {
    claimSetF1: number | null;
    credenceMeanAbsDiff: number | null;
    statusAgreement: number | null;
    edgeEditDistance: number;
    cost: { reference: number | null; candidate: number | null };
    /** Fidelity (claim-set F1) per dollar of the candidate arm; null when cost is unknown. */
    fidelityPerDollar: number | null;
    capped: { a: boolean; b: boolean };
  } | null;
  recommendation: "adopt" | "hold" | "reject";
  /** Plain-language reading; ends with "human decides". */
  reading: string;
}

/** Fidelity band the swap reading treats as "close to the reference" (one sample; a heuristic, not a rule). */
export const SWAP_CLOSE_F1 = 0.85;
/** A golden pass-rate drop larger than this is a regression on a saturating task. */
export const GOLDEN_TOLERANCE = 0.05;

const perDollar = (quality: number | null, micro: number | null): number | null =>
  quality === null || micro === null || micro <= 0 ? null : Math.round((quality / (micro / 1_000_000)) * 100) / 100;

export function summarizeAdoption(input: {
  agent: AdoptAgent;
  candidate: string;
  incumbent: string;
  golden?: { candidate: GoldenArm; incumbent: GoldenArm } | null;
  swap?: SwapSummary | null;
}): AdoptSummary {
  const golden = input.golden
    ? {
        candidate: input.golden.candidate,
        incumbent: input.golden.incumbent,
        qualityPerDollar: {
          candidate: perDollar(input.golden.candidate.passRate, input.golden.candidate.costMicroUsd),
          incumbent: perDollar(input.golden.incumbent.passRate, input.golden.incumbent.costMicroUsd),
        },
        passRateDelta: Math.round((input.golden.candidate.passRate - input.golden.incumbent.passRate) * 1000) / 1000,
      }
    : null;
  const swap = input.swap
    ? {
        claimSetF1: input.swap.claimSetF1,
        credenceMeanAbsDiff: input.swap.credenceMeanAbsDiff,
        statusAgreement: input.swap.statusAgreement,
        edgeEditDistance: input.swap.edgeEditDistance,
        cost: { reference: input.swap.cost.a, candidate: input.swap.cost.b },
        fidelityPerDollar: perDollar(input.swap.claimSetF1, input.swap.cost.b),
        capped: input.swap.capped,
      }
    : null;

  const parts: string[] = [];
  let recommendation: AdoptSummary["recommendation"] = "hold";

  if (golden) {
    const c = golden.candidate;
    const i = golden.incumbent;
    parts.push(
      `Golden pairs: candidate ${c.passed}/${c.total} (${pct(c.passRate)}) at ${usd(c.costMicroUsd)} vs incumbent ${i.passed}/${i.total} (${pct(i.passRate)}) at ${usd(i.costMicroUsd)}` +
        (golden.qualityPerDollar.candidate !== null && golden.qualityPerDollar.incumbent !== null
          ? ` — ${golden.qualityPerDollar.candidate} vs ${golden.qualityPerDollar.incumbent} pass-rate points per dollar.`
          : ".")
    );
    if (golden.passRateDelta < -GOLDEN_TOLERANCE) {
      recommendation = "reject";
      parts.push(`The candidate loses ${pct(-golden.passRateDelta)} on a saturating task; that is a regression, not noise.`);
    } else if (c.costMicroUsd <= i.costMicroUsd && golden.passRateDelta >= 0) {
      recommendation = "adopt";
      parts.push("Equal or better pass rate at equal or lower cost.");
    } else if (c.costMicroUsd > i.costMicroUsd && golden.passRateDelta <= 0) {
      recommendation = "hold";
      parts.push("Costs more and passes no more; nothing to gain.");
    } else {
      recommendation = "hold";
      parts.push("A trade-off (better on one axis, worse on the other): decide on the agent's budget.");
    }
  }

  if (swap) {
    const f1 = swap.claimSetF1;
    parts.push(
      `Swap on the cluster: claim-set F1 ${num(f1)}, credence mean |Δ| ${num(swap.credenceMeanAbsDiff)}, status agreement ${num(swap.statusAgreement)}, edge edit distance ${swap.edgeEditDistance}; ` +
        `reference arm ${usdOrNa(swap.cost.reference)}, candidate arm ${usdOrNa(swap.cost.candidate)}` +
        (swap.fidelityPerDollar !== null ? ` — ${swap.fidelityPerDollar} F1 points per dollar.` : ".")
    );
    if (swap.capped.a || swap.capped.b) parts.push("An arm hit its Steward cap: the comparison is partial.");
    if (f1 === null) {
      parts.push("No fidelity could be read (a side had no claims).");
      if (!golden) recommendation = "hold";
    } else if (f1 < 0.6) {
      recommendation = "reject";
      parts.push(`The candidate's graph departs substantially from the reference (F1 ${num(f1)}).`);
    } else if (!golden) {
      const cheaper = swap.cost.candidate !== null && swap.cost.reference !== null && swap.cost.candidate < swap.cost.reference;
      if (f1 >= SWAP_CLOSE_F1 && cheaper) {
        recommendation = "adopt";
        parts.push("Close to the reference graph at lower cost.");
      } else if (f1 >= SWAP_CLOSE_F1) {
        recommendation = "hold";
        parts.push("Close to the reference graph but not cheaper: no economic case, and fidelity alone does not argue for a change.");
      } else {
        recommendation = "hold";
        parts.push("Some distance from the reference: repeat the swap and read the unmatched claims before deciding.");
      }
    } else if (f1 < SWAP_CLOSE_F1 && recommendation === "adopt") {
      recommendation = "hold";
      parts.push("The golden pairs pass but the cluster graph moved: repeat the swap before adopting.");
    }
  }

  if (!golden && !swap) parts.push("Nothing ran.");
  parts.push(
    "Fidelity is relative to the incumbent, not to truth (§2.2), and one run is one sample; " +
      `recommendation: ${recommendation} — human decides, and the pin changes by PR in infra/lib/api-stack.ts.`
  );
  return { agent: input.agent, candidate: input.candidate, incumbent: input.incumbent, golden, swap, recommendation, reading: parts.join(" ") };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;
const usdOrNa = (micro: number | null) => (micro === null ? "cost n/a" : usd(micro));
const num = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
