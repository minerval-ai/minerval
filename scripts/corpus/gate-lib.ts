/**
 * Epoch-bump gate (#334 L4, from #137.3) — the pure half.
 *
 * The docs/graph-epochs.md norm made enforceable: a scored corpus run under
 * a new epoch or prompt is compared against the committed baseline group
 * with band.ts's noise-band rule, and a regression on a gated headline
 * metric fails the gate. The arithmetic is band.ts's (|Δ mean| > sdA + sdB
 * over N≈3 per side); what this adds is the DIRECTION each metric is read
 * in (a coherence violation going up is a regression, a claim-bar pass
 * rate going down is), the choice of baseline and candidate groups from a
 * cluster's committed scorecards, and the refusals: a side with too few
 * runs, or two sides that are not the same profile and epoch, get no
 * verdict at all — the gate says so and exits clean, because a verdict it
 * cannot stand behind is worse than none.
 *
 * Baseline group, in order of precedence: --baseline=<files>, then the
 * cluster's corpus/scorecards/<cluster>/baselines.json
 * ({"epoch": "...", "files": [...]}), then the earliest N files sharing
 * the earliest file's epoch and profile. Candidate group: --candidate,
 * else the newest files not in the baseline that share the newest file's
 * epoch and profile.
 */
import { compareBand, HEADLINE_METRICS, type BandRow } from "./band.js";
import type { Scorecard } from "./score.js";

export interface ScorecardFile {
  file: string;
  card: Scorecard;
}

/** The committed baseline declaration, one per cluster directory. */
export interface BaselinesSpec {
  epoch: string;
  /** Scorecard file names (relative to the cluster's scorecards directory). */
  files: string[];
  note?: string;
}

export const BASELINES_FILE = "baselines.json";

/** Which way a headline metric is good. null: no direction — reported, never gated. */
export const METRIC_DIRECTIONS: Record<string, "higher" | "lower" | null> = {
  "A · claims per 1k words": null,
  "B · canonical p90 words": "lower",
  "B · share > 25 words": "lower",
  "C · dedup ratio": "higher",
  "D · max depth": null,
  "D · atomic share": null,
  "E · shared subclaims": "higher",
  "F · % with trace": "higher",
  "§21 · coherence violations": "lower",
  "B · matcher rewrite rate": null,
  "B · rewrite magnitude": null,
  "C · matched denies share": null,
  "imp · mean": null,
  "imp · atomic vs compound gap": null,
  "judge · claim-bar pass-rate": "higher",
  "judge · importance overrated share": "lower",
  "judge · readability": "higher",
  "judge · reasoning-fit": "higher",
  "judge · impartiality": "higher",
  "judge · sycophancy share": "lower",
  "judge · overhedged share": "lower",
  "judge · overconfident share": "lower",
  "judge · canonical-form miss share": "lower",
  "judge · political bias share": "lower",
};

/** The metrics a regression on fails the gate, by default. */
export const DEFAULT_GATED = [
  "judge · claim-bar pass-rate",
  "§21 · coherence violations",
  "C · dedup ratio",
  "F · % with trace",
];

/** Resolve a --gated spec (comma list; each item a label or a case-insensitive fragment of one). */
export function resolveGated(spec: string | undefined): string[] {
  if (!spec) return DEFAULT_GATED;
  const labels = HEADLINE_METRICS.map((m) => m.label);
  const out: string[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const exact = labels.find((l) => l === raw);
    const hits = exact ? [exact] : labels.filter((l) => l.toLowerCase().includes(raw.toLowerCase()));
    if (hits.length === 0) throw new Error(`--gated: "${raw}" matches no headline metric`);
    if (hits.length > 1) throw new Error(`--gated: "${raw}" is ambiguous (${hits.join("; ")})`);
    if (METRIC_DIRECTIONS[hits[0]!] == null) throw new Error(`--gated: "${hits[0]}" has no direction and cannot be gated`);
    if (!out.includes(hits[0]!)) out.push(hits[0]!);
  }
  return out;
}

/** The part of a fingerprint a comparison must share: epoch and profile. */
export function fingerprintKey(card: Scorecard): string {
  return `${card.config.pipelineEpoch}|${card.config.profile ?? ""}`;
}

export function describeFingerprint(card: Scorecard): string {
  return `epoch ${card.config.pipelineEpoch}` + (card.config.profile ? ` · profile ${card.config.profile}` : " · no profile");
}

export interface GroupSelection {
  baseline: ScorecardFile[];
  candidate: ScorecardFile[];
  /** How each side was chosen. */
  how: { baseline: string; candidate: string };
}

function byGeneratedAt(a: ScorecardFile, b: ScorecardFile): number {
  return a.card.generatedAt.localeCompare(b.card.generatedAt) || a.file.localeCompare(b.file);
}

function pickFiles(all: ScorecardFile[], names: string[], what: string): ScorecardFile[] {
  return names.map((name) => {
    const hit = all.find((f) => f.file === name || f.file === `${name}.json`);
    if (!hit) throw new Error(`${what}: no scorecard file "${name}" in the cluster's history`);
    return hit;
  });
}

export function selectGroups(opts: {
  files: ScorecardFile[];
  baselines: BaselinesSpec | null;
  baselineArg?: string;
  candidateArg?: string;
  minN: number;
  /** Cap on the default candidate group (newest first). */
  maxN?: number;
}): GroupSelection {
  const all = [...opts.files].sort(byGeneratedAt);
  if (all.length === 0) throw new Error("no committed scorecards to gate on");
  const maxN = opts.maxN ?? Math.max(3, opts.minN);

  let baseline: ScorecardFile[];
  let howB: string;
  if (opts.baselineArg) {
    baseline = pickFiles(all, opts.baselineArg.split(",").map((s) => s.trim()).filter(Boolean), "--baseline");
    howB = "--baseline";
  } else if (opts.baselines) {
    baseline = pickFiles(all, opts.baselines.files, BASELINES_FILE);
    howB = `${BASELINES_FILE} (epoch ${opts.baselines.epoch})`;
    for (const f of baseline) {
      if (f.card.config.pipelineEpoch !== opts.baselines.epoch) {
        throw new Error(`${BASELINES_FILE} declares epoch ${opts.baselines.epoch} but ${f.file} is epoch ${f.card.config.pipelineEpoch}`);
      }
    }
  } else {
    const key = fingerprintKey(all[0]!.card);
    baseline = all.filter((f) => fingerprintKey(f.card) === key).slice(0, opts.minN);
    howB = `earliest ${baseline.length} run(s) sharing the earliest run's fingerprint (no ${BASELINES_FILE})`;
  }

  const inBaseline = new Set(baseline.map((f) => f.file));
  let candidate: ScorecardFile[];
  let howC: string;
  if (opts.candidateArg && opts.candidateArg !== "latest") {
    candidate = pickFiles(all, opts.candidateArg.split(",").map((s) => s.trim()).filter(Boolean), "--candidate");
    howC = "--candidate";
  } else {
    const rest = all.filter((f) => !inBaseline.has(f.file));
    const newest = rest[rest.length - 1];
    if (!newest) {
      candidate = [];
      howC = "no run outside the baseline";
    } else {
      const key = fingerprintKey(newest.card);
      candidate = rest.filter((f) => fingerprintKey(f.card) === key).slice(-maxN);
      howC = `newest ${candidate.length} run(s) outside the baseline sharing the newest run's fingerprint`;
    }
  }
  return { baseline, candidate, how: { baseline: howB, candidate: howC } };
}

export type GateVerdict = "regressed" | "improved" | "within band" | "moved" | "no verdict" | "n/a";

export interface GateRow extends BandRow {
  direction: "higher" | "lower" | null;
  gated: boolean;
  gateVerdict: GateVerdict;
}

/** Read a band row in its metric's direction. */
export function gateVerdictFor(row: BandRow, direction: "higher" | "lower" | null): GateVerdict {
  if (row.verdict === "n/a") return "n/a";
  if (row.verdict === "single-sample") return "no verdict";
  if (row.verdict === "within-band") return "within band";
  if (direction === null || row.delta === null) return "moved";
  const good = direction === "higher" ? row.delta > 0 : row.delta < 0;
  return good ? "improved" : "regressed";
}

export interface GateResult {
  status: "gated" | "refused";
  /** Why the gate refused, when it did. */
  reason: string | null;
  baseline: string[];
  candidate: string[];
  fingerprint: { baseline: string[]; candidate: string[] };
  rows: GateRow[];
  gated: string[];
  /** Gated metrics that regressed beyond the band. */
  regressions: string[];
  /** Gated metrics compared one-sided (weaker evidence), for the record. */
  oneSided: string[];
  passed: boolean;
  /** Plain-language reading. */
  reading: string;
}

export function evaluateGate(opts: {
  baseline: ScorecardFile[];
  candidate: ScorecardFile[];
  gated: string[];
  minN: number;
}): GateResult {
  const a = opts.baseline.map((f) => f.card);
  const b = opts.candidate.map((f) => f.card);
  const rows: GateRow[] = HEADLINE_METRICS.map((m) => {
    const row = compareBand(m.label, a.map((s) => m.get(s)), b.map((s) => m.get(s)));
    const direction = METRIC_DIRECTIONS[m.label] ?? null;
    return { ...row, direction, gated: opts.gated.includes(m.label), gateVerdict: gateVerdictFor(row, direction) };
  });
  const fpA = [...new Set(a.map(describeFingerprint))];
  const fpB = [...new Set(b.map(describeFingerprint))];
  const base = {
    baseline: opts.baseline.map((f) => f.file),
    candidate: opts.candidate.map((f) => f.file),
    fingerprint: { baseline: fpA, candidate: fpB },
    rows,
    gated: opts.gated,
  };

  const refuse = (reason: string): GateResult => ({
    ...base,
    status: "refused",
    reason,
    regressions: [],
    oneSided: [],
    passed: true,
    reading: `No verdict: ${reason} Deltas are printed for reading, not gating.`,
  });
  if (a.length === 0 || b.length === 0) return refuse(`a side is empty (baseline ${a.length}, candidate ${b.length}).`);
  const keysA = new Set(a.map(fingerprintKey));
  const keysB = new Set(b.map(fingerprintKey));
  if (keysA.size > 1) return refuse(`the baseline mixes fingerprints (${fpA.join(" / ")}); a baseline is one configuration.`);
  if (keysB.size > 1) return refuse(`the candidate mixes fingerprints (${fpB.join(" / ")}); a candidate is one configuration.`);
  if ([...keysA][0] !== [...keysB][0]) {
    return refuse(`the sides differ in profile or epoch (baseline ${fpA[0]}; candidate ${fpB[0]}) — a delta across configurations is not a regression, it is a different graph.`);
  }
  if (a.length < opts.minN || b.length < opts.minN) {
    return refuse(
      `each side needs ≥ ${opts.minN} runs to measure spread (baseline ${a.length}, candidate ${b.length}); one run is one nondeterministic sample (corpus/SCORING.md).`
    );
  }

  const gatedRows = rows.filter((r) => r.gated);
  const regressions = gatedRows.filter((r) => r.gateVerdict === "regressed").map((r) => r.label);
  const oneSided = gatedRows.filter((r) => r.oneSided && r.gateVerdict !== "n/a" && r.gateVerdict !== "no verdict").map((r) => r.label);
  const improved = rows.filter((r) => r.gateVerdict === "improved").map((r) => r.label);
  const otherRegressed = rows.filter((r) => !r.gated && r.gateVerdict === "regressed").map((r) => r.label);
  const unjudged = gatedRows.filter((r) => r.gateVerdict === "n/a").map((r) => r.label);

  const parts: string[] = [];
  parts.push(
    regressions.length === 0
      ? `Gate passed: no gated metric regressed beyond the noise band (baseline n=${a.length}, candidate n=${b.length}).`
      : `Gate FAILED: ${regressions.join("; ")} regressed beyond the noise band (baseline n=${a.length}, candidate n=${b.length}).`
  );
  if (otherRegressed.length) parts.push(`Ungated metrics that also regressed: ${otherRegressed.join("; ")}.`);
  if (improved.length) parts.push(`Improved beyond the band: ${improved.join("; ")}.`);
  if (unjudged.length) parts.push(`Not measurable on these scorecards (unjudged or absent): ${unjudged.join("; ")}.`);
  if (oneSided.length) parts.push(`One-sided verdicts (one side had no spread): ${oneSided.join("; ")} — weaker evidence.`);
  parts.push("A delta counts only beyond sdA + sdB; a passed gate is 'not shown to regress', not 'shown equal'.");

  return { ...base, status: "gated", reason: null, regressions, oneSided, passed: regressions.length === 0, reading: parts.join(" ") };
}

const fmt = (x: number | null): string => (x === null ? "n/a" : String(Math.round(x * 100) / 100));
const side = (s: BandRow["a"]): string => (s.mean === null ? "n/a" : s.sd === null ? fmt(s.mean) : `${fmt(s.mean)} ± ${fmt(s.sd)}`);

/** The delta table with verdicts, for the terminal or a PR comment. */
export function renderGate(result: GateResult): string {
  const rows = result.rows.filter((r) => r.gateVerdict !== "n/a");
  const w = Math.max(...rows.map((r) => r.label.length), 6);
  const out: string[] = [];
  out.push(`  baseline (n=${result.baseline.length}): ${result.baseline.join(", ")}`);
  out.push(`      ${result.fingerprint.baseline.join(" / ") || "?"}`);
  out.push(`  candidate (n=${result.candidate.length}): ${result.candidate.join(", ") || "(none)"}`);
  out.push(`      ${result.fingerprint.candidate.join(" / ") || "?"}`);
  out.push("");
  out.push(`  ${"metric".padEnd(w)}  ${"baseline".padStart(16)}  ${"candidate".padStart(16)}  ${"delta".padStart(7)}  verdict`);
  for (const r of rows) {
    const delta = r.delta === null ? "" : `${r.delta > 0 ? "+" : ""}${fmt(r.delta)}`;
    const verdict = r.gateVerdict + (r.oneSided && r.gateVerdict !== "no verdict" ? " (one-sided)" : "") + (r.gated ? "  [gated]" : "");
    out.push(`  ${r.label.padEnd(w)}  ${side(r.a).padStart(16)}  ${side(r.b).padStart(16)}  ${delta.padStart(7)}  ${verdict}`);
  }
  out.push("");
  out.push(`  ${result.reading}`);
  return out.join("\n");
}
