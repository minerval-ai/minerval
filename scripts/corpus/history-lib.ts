/**
 * Assessment-history properties, the pure half (#334 S3 tier 2, from #295
 * (g) and (h)): what the record of a graph's verdicts over time says about
 * the Steward, with no referent and no second arm.
 *
 *   evidence monotonicity   A supporting contribution should not lower a
 *                           claim's credence; a challenge should not raise
 *                           it. Sign, not magnitude: the Steward may weigh a
 *                           contribution at zero, never backwards. Each
 *                           accepted support / add_instance / challenge is
 *                           linked to the contribution_accepted assessment
 *                           that followed it, and the credence delta's sign
 *                           is checked against expectation.
 *   overturn-rate           How often a claim first assessed at credence c
 *   discrimination          is later materially reversed. Confidence should
 *                           mean something: 0.9-claims should reverse less
 *                           than 0.6-claims. First-assessment credences are
 *                           binned; per bin, the share later materially
 *                           changed and the share reversed (credence crossed
 *                           0.5, or the status flipped polarity).
 *
 * Pure and DB-free; cascade-load.ts's loadHistoryInput reads the tables,
 * history.ts is the CLI.
 */

export interface HistoryAssessment {
  claimId: string;
  status: string;
  credence: number | null;
  assessedAt: string;
  trigger: string | null;
}

export interface HistoryContribution {
  id: string;
  claimId: string | null;
  type: string;
  reviewStatus: string;
  submittedAt: string;
  reviewedAt: string | null;
  decision: string | null;
}

export interface HistoryInput {
  assessments: HistoryAssessment[];
  contributions: HistoryContribution[];
  since?: string | null;
}

export interface HistoryOptions {
  /** |Δcredence| at or above which a later assessment counts as a material change. Default 0.1. */
  materialCredenceDelta?: number;
  /** Bins with fewer claims than this are flagged as small samples. Default 5. */
  minBin?: number;
}

export type ExpectedDirection = "up" | "down";

/** Contribution types with an expected sign; the rest carry none. */
export function expectedDirection(type: string): ExpectedDirection | null {
  if (type === "support" || type === "add_instance") return "up";
  if (type === "challenge") return "down";
  return null;
}

export interface MonotonicityItem {
  contributionId: string;
  claimId: string;
  type: string;
  expected: ExpectedDirection;
  before: number | null;
  after: number | null;
  delta: number | null;
  statusBefore: string | null;
  statusAfter: string;
  /** 'consistent' (right sign), 'zero' (no move), 'violation' (wrong sign), 'no-credence' (a side states none). */
  outcome: "consistent" | "zero" | "violation" | "no-credence";
  linkedBy: "trigger" | "next-assessment";
}

export interface MonotonicityReport {
  /** Accepted contributions with an expected direction. */
  accepted: number;
  /** …linked to a following assessment. */
  linked: number;
  unlinked: number;
  /** …whose assessment integrated contributions pulling both ways (skipped). */
  ambiguous: number;
  consistent: number;
  zero: number;
  violations: number;
  noCredence: number;
  items: MonotonicityItem[];
  reading: string;
}

export interface OverturnBin {
  bin: string;
  n: number;
  /** Claims with at least one later assessment. */
  reassessed: number;
  changed: number;
  changedShare: number | null;
  reversed: number;
  reversedShare: number | null;
  smallSample: boolean;
}

export interface OverturnReport {
  claims: number;
  noCredence: number;
  neverReassessed: number;
  bins: OverturnBin[];
  /** By distance of the first credence from 0.5: how confident the Steward was, either way. */
  byConfidence: Array<OverturnBin & { band: string }>;
  /** Reversal share among first credences ≥ 0.8 or ≤ 0.2 vs those in [0.4, 0.6]. */
  extremes: { n: number; reversedShare: number | null };
  middle: { n: number; reversedShare: number | null };
  reading: string;
}

export interface HistoryReport {
  window: { since: string | null; assessments: number; contributions: number; claims: number };
  materialCredenceDelta: number;
  monotonicity: MonotonicityReport;
  overturn: OverturnReport;
  reading: string;
}

const toMs = (s: string | null | undefined): number => (s ? new Date(s).getTime() : Number.NaN);
const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

const POSITIVE = new Set(["verified", "supported"]);
const NEGATIVE = new Set(["unsupported", "contradicted"]);

function polarity(status: string): 1 | -1 | 0 {
  if (POSITIVE.has(status)) return 1;
  if (NEGATIVE.has(status)) return -1;
  return 0;
}

export function credenceBin(c: number): string {
  const b = Math.min(4, Math.max(0, Math.floor(c * 5)));
  return `${(b * 0.2).toFixed(1)}-${((b + 1) * 0.2).toFixed(1)}`;
}

export function confidenceBand(c: number): string {
  const d = Math.abs(c - 0.5);
  if (d < 0.1) return "near 0.5 (<0.1)";
  if (d < 0.3) return "moderate (0.1-0.3)";
  return "confident (≥0.3)";
}

function groupByClaim(assessments: HistoryAssessment[]): Map<string, HistoryAssessment[]> {
  const out = new Map<string, HistoryAssessment[]>();
  for (const a of [...assessments].sort((x, y) => toMs(x.assessedAt) - toMs(y.assessedAt))) {
    (out.get(a.claimId) ?? out.set(a.claimId, []).get(a.claimId)!).push(a);
  }
  return out;
}

export function analyzeMonotonicity(input: HistoryInput): MonotonicityReport {
  const byClaim = groupByClaim(input.assessments);
  const accepted = input.contributions.filter(
    (k) => k.claimId && (k.decision === "accept" || k.reviewStatus === "accepted") && expectedDirection(k.type) !== null
  );
  // Link each accepted contribution to the first assessment on its claim at
  // or after its review, preferring one that says it was triggered by a
  // contribution; contributions that land on the same assessment were
  // integrated together (the pending slot coalesced them).
  const linked = new Map<string, Array<{ k: HistoryContribution; linkedBy: MonotonicityItem["linkedBy"] }>>();
  const keyOf = (a: HistoryAssessment) => `${a.claimId}|${a.assessedAt}`;
  let unlinked = 0;
  for (const k of accepted) {
    const list = byClaim.get(k.claimId!) ?? [];
    const t = toMs(k.reviewedAt ?? k.submittedAt);
    const after = list.filter((a) => toMs(a.assessedAt) >= t);
    const byTrigger = after.find((a) => a.trigger === "contribution_accepted");
    const target = byTrigger ?? after[0];
    if (!target) {
      unlinked++;
      continue;
    }
    const key = keyOf(target);
    (linked.get(key) ?? linked.set(key, []).get(key)!).push({ k, linkedBy: byTrigger ? "trigger" : "next-assessment" });
  }
  const items: MonotonicityItem[] = [];
  let ambiguous = 0;
  for (const [key, group] of linked) {
    const dirs = new Set(group.map((g) => expectedDirection(g.k.type)));
    if (dirs.size > 1) {
      ambiguous += group.length;
      continue;
    }
    const [claimId, assessedAt] = key.split("|") as [string, string];
    const list = byClaim.get(claimId) ?? [];
    const idx = list.findIndex((a) => a.assessedAt === assessedAt);
    const after = list[idx]!;
    const before = idx > 0 ? list[idx - 1]! : undefined;
    for (const { k, linkedBy } of group) {
      const expected = expectedDirection(k.type)!;
      const b = before && typeof before.credence === "number" ? before.credence : null;
      const a = typeof after.credence === "number" ? after.credence : null;
      const delta = b !== null && a !== null ? a - b : null;
      let outcome: MonotonicityItem["outcome"];
      if (delta === null) outcome = "no-credence";
      else if (Math.abs(delta) < 1e-9) outcome = "zero";
      else if ((expected === "up" && delta > 0) || (expected === "down" && delta < 0)) outcome = "consistent";
      else outcome = "violation";
      items.push({
        contributionId: k.id,
        claimId,
        type: k.type,
        expected,
        before: b,
        after: a,
        delta: round(delta),
        statusBefore: before?.status ?? null,
        statusAfter: after.status,
        outcome,
        linkedBy,
      });
    }
  }
  const count = (o: MonotonicityItem["outcome"]) => items.filter((i) => i.outcome === o).length;
  const report: MonotonicityReport = {
    accepted: accepted.length,
    linked: items.length,
    unlinked,
    ambiguous,
    consistent: count("consistent"),
    zero: count("zero"),
    violations: count("violation"),
    noCredence: count("no-credence"),
    items,
    reading: "",
  };
  const judged = report.consistent + report.zero + report.violations;
  if (accepted.length === 0) report.reading = "No accepted support, add_instance or challenge contributions in the window; monotonicity has nothing to read.";
  else if (judged === 0) report.reading = `${accepted.length} accepted contribution(s) but none could be linked to a credence-bearing reassessment (${unlinked} without a following assessment, ${report.noCredence} without a credence on one side).`;
  else if (report.violations === 0) report.reading = `Evidence moved credence the right way or not at all in all ${judged} linked case(s) (${report.zero} unmoved). No violations.`;
  else report.reading = `${report.violations} of ${judged} linked contribution(s) moved credence AGAINST the evidence's direction (a support lowered it, or a challenge raised it) — read the listed items; a single-digit count can be the Steward re-weighing everything on a re-trigger rather than the contribution itself.`;
  if (unlinked > 0 && judged > 0) report.reading += ` ${unlinked} accepted contribution(s) had no following assessment (the re-trigger may still be pending).`;
  return report;
}

export function analyzeOverturn(input: HistoryInput, opts: HistoryOptions = {}): OverturnReport {
  const threshold = opts.materialCredenceDelta ?? 0.1;
  const minBin = opts.minBin ?? 5;
  const byClaim = groupByClaim(input.assessments);
  const bins = new Map<string, OverturnBin>();
  const bands = new Map<string, OverturnBin & { band: string }>();
  const mk = (bin: string): OverturnBin => ({ bin, n: 0, reassessed: 0, changed: 0, changedShare: null, reversed: 0, reversedShare: null, smallSample: true });
  for (const b of ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"]) bins.set(b, mk(b));
  for (const b of ["near 0.5 (<0.1)", "moderate (0.1-0.3)", "confident (≥0.3)"]) bands.set(b, { ...mk(b), band: b });
  let noCredence = 0;
  let neverReassessed = 0;
  let extremesN = 0;
  let extremesReversed = 0;
  let middleN = 0;
  let middleReversed = 0;
  for (const [, list] of byClaim) {
    const first = list[0]!;
    if (typeof first.credence !== "number") {
      noCredence++;
      continue;
    }
    const c0 = first.credence;
    const later = list.slice(1);
    const changed = later.some(
      (a) => a.status !== first.status || (typeof a.credence === "number" && Math.abs(a.credence - c0) >= threshold - 1e-12)
    );
    const p0 = polarity(first.status);
    const reversed = later.some(
      (a) =>
        (typeof a.credence === "number" && (a.credence - 0.5) * (c0 - 0.5) < 0) ||
        (p0 !== 0 && polarity(a.status) === -p0)
    );
    if (later.length === 0) neverReassessed++;
    const tally = (row: OverturnBin) => {
      row.n++;
      if (later.length > 0) row.reassessed++;
      if (changed) row.changed++;
      if (reversed) row.reversed++;
    };
    tally(bins.get(credenceBin(c0))!);
    tally(bands.get(confidenceBand(c0))!);
    if (c0 >= 0.8 || c0 <= 0.2) {
      extremesN++;
      if (reversed) extremesReversed++;
    } else if (c0 >= 0.4 && c0 <= 0.6) {
      middleN++;
      if (reversed) middleReversed++;
    }
  }
  const finish = (row: OverturnBin) => {
    row.changedShare = round(ratio(row.changed, row.reassessed));
    row.reversedShare = round(ratio(row.reversed, row.reassessed));
    row.smallSample = row.reassessed < minBin;
  };
  for (const b of bins.values()) finish(b);
  for (const b of bands.values()) finish(b);
  const report: OverturnReport = {
    claims: byClaim.size,
    noCredence,
    neverReassessed,
    bins: [...bins.values()],
    byConfidence: [...bands.values()],
    extremes: { n: extremesN, reversedShare: round(ratio(extremesReversed, extremesN)) },
    middle: { n: middleN, reversedShare: round(ratio(middleReversed, middleN)) },
    reading: "",
  };
  const reassessedTotal = report.bins.reduce((s, b) => s + b.reassessed, 0);
  if (reassessedTotal === 0) {
    report.reading = `${byClaim.size} assessed claim(s), none reassessed yet; overturn rates need a second look at each claim (a staleness sweep, a contribution, or corpus:property fixpoint).`;
  } else {
    const confident = report.byConfidence.find((b) => b.band.startsWith("confident"))!;
    const near = report.byConfidence.find((b) => b.band.startsWith("near"))!;
    const parts: string[] = [`${reassessedTotal} of ${byClaim.size} assessed claim(s) were reassessed at least once.`];
    if (confident.reversedShare !== null && near.reversedShare !== null && !confident.smallSample && !near.smallSample) {
      if (confident.reversedShare < near.reversedShare) {
        parts.push(
          `Reversal falls with confidence: ${(confident.reversedShare * 100).toFixed(0)}% of confident first verdicts (|c−0.5| ≥ 0.3) were later reversed vs ${(near.reversedShare * 100).toFixed(0)}% of near-0.5 ones — the stated credence discriminates.`
        );
      } else {
        parts.push(
          `Reversal does NOT fall with confidence: ${(confident.reversedShare * 100).toFixed(0)}% of confident first verdicts were later reversed vs ${(near.reversedShare * 100).toFixed(0)}% of near-0.5 ones — a high credence is not buying stability.`
        );
      }
    } else {
      parts.push(`Too few reassessed claims per confidence band (fewer than ${minBin} in at least one) to say whether reversal falls with confidence; read the bins as counts, not rates.`);
    }
    const small = report.bins.filter((b) => b.smallSample && b.n > 0).map((b) => b.bin);
    if (small.length > 0) parts.push(`Small-sample bins: ${small.join(", ")}.`);
    report.reading = parts.join(" ");
  }
  return report;
}

export function analyzeHistory(input: HistoryInput, opts: HistoryOptions = {}): HistoryReport {
  const monotonicity = analyzeMonotonicity(input);
  const overturn = analyzeOverturn(input, opts);
  const claims = new Set(input.assessments.map((a) => a.claimId)).size;
  return {
    window: { since: input.since ?? null, assessments: input.assessments.length, contributions: input.contributions.length, claims },
    materialCredenceDelta: opts.materialCredenceDelta ?? 0.1,
    monotonicity,
    overturn,
    reading: `${monotonicity.reading} ${overturn.reading}`,
  };
}

export function renderHistory(r: HistoryReport): string {
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  const o: string[] = [];
  o.push(
    `Assessment history — window ${r.window.since ?? "(all)"} · ${r.window.claims} claim(s) · ${r.window.assessments} assessment(s) · ${r.window.contributions} contribution(s) · material |Δcredence| ≥ ${r.materialCredenceDelta}`
  );
  const m = r.monotonicity;
  o.push(
    `  monotonicity: accepted ${m.accepted} · linked ${m.linked} (unlinked ${m.unlinked}, ambiguous ${m.ambiguous}) · consistent ${m.consistent} · unmoved ${m.zero} · violations ${m.violations} · no credence ${m.noCredence}`
  );
  for (const i of m.items.filter((i) => i.outcome === "violation")) {
    o.push(
      `    VIOLATION ${i.type} on claim ${i.claimId.slice(0, 8)} (contribution ${i.contributionId.slice(0, 8)}): credence ${i.before} → ${i.after} (${i.delta! > 0 ? "+" : ""}${i.delta}), status ${i.statusBefore ?? "—"} → ${i.statusAfter}, expected ${i.expected}`
    );
  }
  o.push(`  ${m.reading}`);
  const v = r.overturn;
  o.push(`  overturn: ${v.claims} claim(s) · no credence ${v.noCredence} · never reassessed ${v.neverReassessed}`);
  o.push(`    first credence   n  reassessed  changed  changed%  reversed  reversed%`);
  const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(0).padStart(4)}%`);
  for (const b of [...v.bins, ...v.byConfidence]) {
    o.push(
      `    ${b.bin.padEnd(18)} ${String(b.n).padStart(3)}  ${String(b.reassessed).padStart(10)}  ${String(b.changed).padStart(7)}  ${pct(b.changedShare).padStart(8)}  ${String(b.reversed).padStart(8)}  ${pct(b.reversedShare).padStart(9)}${b.smallSample && b.n > 0 ? "  (small)" : ""}`
    );
  }
  o.push(`    extremes (≤0.2 / ≥0.8): n ${v.extremes.n} reversed ${f(v.extremes.reversedShare)} · middle [0.4, 0.6]: n ${v.middle.n} reversed ${f(v.middle.reversedShare)}`);
  o.push(`  ${v.reading}`);
  return o.join("\n");
}
