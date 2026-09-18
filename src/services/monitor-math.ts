/**
 * Production monitors (#334 S9), the pure half: the aggregation each signal
 * applies to the rows monitor-service.ts reads. No database, no config —
 * every function here takes rows and thresholds and returns a report, so
 * the arithmetic is unit-testable without seeding anything.
 *
 * What lives here and what does not: a monitor is a READER. It computes a
 * number or lists candidates; it never decides anything about a claim. The
 * two candidate detectors (performed settling, empty chairs) feed the Audit
 * Agent as INPUT (monitor-scheduler.ts), and the Audit Agent judges on the
 * merits. The other signals are numbers an operator reads.
 */

// ---------------------------------------------------------------------------
// Overturn-rate discrimination (#295 tier 2)
// ---------------------------------------------------------------------------

/** One credence bin: how many assessments landed there and how many were later materially reversed. */
export interface OverturnBinRow {
  /** 1..10 from width_bucket(credence, 0, 1, 10); 11 is credence exactly 1.0 and folds into 10. */
  bin: number;
  n: number;
  reversed: number;
}

export interface OverturnBin {
  bin: number;
  /** Inclusive lower / exclusive upper credence bound of the bin. */
  lo: number;
  hi: number;
  n: number;
  reversed: number;
  /** reversed / n, or null when the bin is empty. */
  share: number | null;
}

export interface OverturnReport {
  bins: OverturnBin[];
  /** Assessments that had a successor at all (the population). */
  assessed: number;
  reversed: number;
  /** Reversal share over the confident bins (credence ≤ 0.2 or ≥ 0.8). */
  confidentShare: number | null;
  confidentN: number;
  /** Reversal share over the uncertain bins (0.4 ≤ credence < 0.6). */
  uncertainShare: number | null;
  uncertainN: number;
  /**
   * Whether confident assessments reverse LESS often than uncertain ones.
   * null when either side has fewer than `minSample` assessments — no
   * verdict from too little history. false is the #295 failure: "if
   * 0.9-claims reverse as often as 0.6-claims, the credences aren't
   * discriminating."
   */
  discriminating: boolean | null;
  minSample: number;
}

export function summarizeOverturnBins(
  rows: OverturnBinRow[],
  opts: { minSample?: number } = {}
): OverturnReport {
  const minSample = opts.minSample ?? 10;
  const bins: OverturnBin[] = [];
  for (let b = 1; b <= 10; b++) {
    bins.push({ bin: b, lo: (b - 1) / 10, hi: b / 10, n: 0, reversed: 0, share: null });
  }
  for (const r of rows) {
    const idx = Math.min(10, Math.max(1, Math.floor(r.bin))) - 1;
    const bin = bins[idx]!;
    bin.n += r.n;
    bin.reversed += r.reversed;
  }
  for (const bin of bins) bin.share = bin.n > 0 ? bin.reversed / bin.n : null;

  const confident = bins.filter((b) => b.hi <= 0.2 + 1e-9 || b.lo >= 0.8 - 1e-9);
  const uncertain = bins.filter((b) => b.lo >= 0.4 - 1e-9 && b.hi <= 0.6 + 1e-9);
  const sum = (bs: OverturnBin[]) => bs.reduce((acc, b) => ({ n: acc.n + b.n, r: acc.r + b.reversed }), { n: 0, r: 0 });
  const c = sum(confident);
  const u = sum(uncertain);
  const assessed = bins.reduce((a, b) => a + b.n, 0);
  const reversed = bins.reduce((a, b) => a + b.reversed, 0);
  const confidentShare = c.n > 0 ? c.r / c.n : null;
  const uncertainShare = u.n > 0 ? u.r / u.n : null;
  const discriminating =
    c.n >= minSample && u.n >= minSample && confidentShare !== null && uncertainShare !== null
      ? confidentShare < uncertainShare
      : null;
  return {
    bins,
    assessed,
    reversed,
    confidentShare,
    confidentN: c.n,
    uncertainShare,
    uncertainN: u.n,
    discriminating,
    minSample,
  };
}

// ---------------------------------------------------------------------------
// Evidence monotonicity (#295 tier 2)
// ---------------------------------------------------------------------------

export interface MonotonicityRow {
  contributionId: string;
  claimId: string;
  claimText: string;
  contributionType: "support" | "challenge" | string;
  reviewedAt: string;
  credenceBefore: number | null;
  statusBefore: string | null;
  credenceAfter: number | null;
  statusAfter: string | null;
  assessedAfterAt: string | null;
}

export interface MonotonicityViolation extends MonotonicityRow {
  /** Signed credence change (after − before). */
  delta: number;
  /** "support_lowered" | "challenge_raised" */
  kind: "support_lowered" | "challenge_raised";
}

export interface MonotonicityReport {
  /** Accepted support/challenge contributions in the window. */
  accepted: number;
  /** Of those, how many had a credence both before and after (the checkable ones). */
  checked: number;
  /** Accepted but not yet re-assessed within the horizon — pending, not a violation. */
  unassessed: number;
  violations: MonotonicityViolation[];
  /** Sign-correct updates, by contribution type. */
  correct: { support: number; challenge: number };
  tolerance: number;
}

export function classifyMonotonicity(rows: MonotonicityRow[], tolerance: number): MonotonicityReport {
  const violations: MonotonicityViolation[] = [];
  const correct = { support: 0, challenge: 0 };
  let checked = 0;
  let unassessed = 0;
  for (const r of rows) {
    if (r.credenceAfter === null || r.assessedAfterAt === null) {
      unassessed++;
      continue;
    }
    if (r.credenceBefore === null) continue;
    checked++;
    const delta = r.credenceAfter - r.credenceBefore;
    if (r.contributionType === "support" && delta < -tolerance) {
      violations.push({ ...r, delta, kind: "support_lowered" });
    } else if (r.contributionType === "challenge" && delta > tolerance) {
      violations.push({ ...r, delta, kind: "challenge_raised" });
    } else if (r.contributionType === "support") {
      correct.support++;
    } else if (r.contributionType === "challenge") {
      correct.challenge++;
    }
  }
  violations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { accepted: rows.length, checked, unassessed, violations, correct, tolerance };
}

// ---------------------------------------------------------------------------
// Cascade health (empirical R from enqueue_events, #295 "cascade stability")
// ---------------------------------------------------------------------------

export interface CascadeDayRow {
  day: string;
  runs: number;
  materialRuns: number;
  materialChildren: number;
}

export interface CoalesceDayRow {
  day: string;
  enqueues: number;
  coalesced: number;
}

export interface CascadeDay {
  day: string;
  /** Finished steward runs that day. */
  runs: number;
  /** Runs that recorded a materially different assessment (status change or |Δcredence| ≥ threshold, or a first assessment). */
  materialRuns: number;
  /** Materially-changed steward runs those runs caused (via enqueue_events.source_run_id). */
  materialChildren: number;
  /** materialChildren / materialRuns — the empirical R; null with no material runs. */
  r: number | null;
  enqueues: number;
  coalesced: number;
  /** Share of steward enqueues absorbed into an already-pending slot. */
  coalescedShare: number | null;
}

export interface CascadeReport {
  days: CascadeDay[];
  /** Pooled over the window: Σ materialChildren / Σ materialRuns. */
  r: number | null;
  materialRuns: number;
  materialChildren: number;
  coalescedShare: number | null;
  /** R ≥ 1 on the pooled window: the cascade is not dying out. */
  supercritical: boolean | null;
}

function dayKey(d: string | Date): string {
  const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  return iso.slice(0, 10);
}

export function cascadeSeries(runRows: CascadeDayRow[], coalesceRows: CoalesceDayRow[]): CascadeReport {
  const byDay = new Map<string, CascadeDay>();
  const get = (day: string) => {
    let d = byDay.get(day);
    if (!d) {
      d = { day, runs: 0, materialRuns: 0, materialChildren: 0, r: null, enqueues: 0, coalesced: 0, coalescedShare: null };
      byDay.set(day, d);
    }
    return d;
  };
  for (const r of runRows) {
    const d = get(dayKey(r.day));
    d.runs += r.runs;
    d.materialRuns += r.materialRuns;
    d.materialChildren += r.materialChildren;
  }
  for (const c of coalesceRows) {
    const d = get(dayKey(c.day));
    d.enqueues += c.enqueues;
    d.coalesced += c.coalesced;
  }
  let materialRuns = 0;
  let materialChildren = 0;
  let enqueues = 0;
  let coalesced = 0;
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const d of days) {
    d.r = d.materialRuns > 0 ? d.materialChildren / d.materialRuns : null;
    d.coalescedShare = d.enqueues > 0 ? d.coalesced / d.enqueues : null;
    materialRuns += d.materialRuns;
    materialChildren += d.materialChildren;
    enqueues += d.enqueues;
    coalesced += d.coalesced;
  }
  const r = materialRuns > 0 ? materialChildren / materialRuns : null;
  return {
    days,
    r,
    materialRuns,
    materialChildren,
    coalescedShare: enqueues > 0 ? coalesced / enqueues : null,
    supercritical: r === null ? null : r >= 1,
  };
}

// ---------------------------------------------------------------------------
// Queue-depth trend
// ---------------------------------------------------------------------------

export interface SnapshotRow {
  periodKey: string | null;
  stewardPending: number;
  createdAt: string;
}

export interface SnapshotTrend {
  points: SnapshotRow[];
  latest: number | null;
  earliest: number | null;
  /** latest − earliest over the returned points; positive = the lane is growing. */
  delta: number | null;
  /** Least-squares slope in pending claims per hour over the points. */
  slopePerHour: number | null;
}

export function snapshotTrend(rowsNewestFirst: SnapshotRow[]): SnapshotTrend {
  const points = [...rowsNewestFirst].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (points.length === 0) return { points, latest: null, earliest: null, delta: null, slopePerHour: null };
  const earliest = points[0]!.stewardPending;
  const latest = points[points.length - 1]!.stewardPending;
  let slope: number | null = null;
  if (points.length >= 2) {
    const t0 = new Date(points[0]!.createdAt).getTime();
    const xs = points.map((p) => (new Date(p.createdAt).getTime() - t0) / 3_600_000);
    const ys = points.map((p) => p.stewardPending);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) ** 2;
    }
    slope = den > 0 ? num / den : null;
  }
  return { points, latest, earliest, delta: latest - earliest, slopePerHour: slope };
}

// ---------------------------------------------------------------------------
// Agent rollups (llm_usage + agent_runs)
// ---------------------------------------------------------------------------

export interface UsageAgentRow {
  agent: string;
  calls: number;
  costMicroUsd: number;
}

export interface RunsAgentRow {
  agent: string;
  runs: number;
  errors: number;
  running: number;
}

export interface AgentWindow {
  calls: number;
  costMicroUsd: number;
  runs: number;
  errors: number;
  running: number;
  /** errors / finished runs; null with no finished runs. */
  errorRate: number | null;
}

export interface AgentRollup {
  agent: string;
  last24h: AgentWindow;
  last7d: AgentWindow;
}

function emptyWindow(): AgentWindow {
  return { calls: 0, costMicroUsd: 0, runs: 0, errors: 0, running: 0, errorRate: null };
}

function fillWindow(agent: string, usage: UsageAgentRow[], runs: RunsAgentRow[]): AgentWindow {
  const w = emptyWindow();
  const u = usage.find((r) => r.agent === agent);
  if (u) {
    w.calls = u.calls;
    w.costMicroUsd = u.costMicroUsd;
  }
  const r = runs.find((x) => x.agent === agent);
  if (r) {
    w.runs = r.runs;
    w.errors = r.errors;
    w.running = r.running;
    const finished = r.runs - r.running;
    w.errorRate = finished > 0 ? r.errors / finished : null;
  }
  return w;
}

export function mergeAgentRollups(input: {
  usage24h: UsageAgentRow[];
  runs24h: RunsAgentRow[];
  usage7d: UsageAgentRow[];
  runs7d: RunsAgentRow[];
}): AgentRollup[] {
  const agents = new Set<string>();
  for (const rows of [input.usage24h, input.runs24h, input.usage7d, input.runs7d]) {
    for (const r of rows) agents.add(r.agent);
  }
  return [...agents]
    .map((agent) => ({
      agent,
      last24h: fillWindow(agent, input.usage24h, input.runs24h),
      last7d: fillWindow(agent, input.usage7d, input.runs7d),
    }))
    .sort((a, b) => b.last7d.costMicroUsd - a.last7d.costMicroUsd || a.agent.localeCompare(b.agent));
}
