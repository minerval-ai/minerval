/**
 * Cascade stability, the pure half (#334 S3, from #295 tier 1 (d)).
 *
 * A Steward's reassessment notifies the claims that depend on it; each of
 * those may reassess and notify its own dependents. The graph is healthy
 * when that process dies out: R, the expected number of downstream
 * reassessments that MATERIALLY change per materially-changed reassessment,
 * must be < 1, or one accepted contribution could ripple forever.
 *
 * Everything here is reconstructed from three telemetry tables, none of
 * which carries a cascade id — the lineage is rebuilt:
 *
 *   enqueue_events  (queue 'steward'): who woke whom. `source_run_id` is the
 *                   agent run that enqueued; `coalesced` says the enqueue
 *                   joined an existing pending slot (#182) rather than
 *                   creating one.
 *   agent_runs      (agent 'steward'): each Steward run, its claim, when.
 *   assessments     history per claim, ordered by assessed_at: what each run
 *                   wrote, and so whether it changed anything.
 *
 * A run's pending SLOT is the set of steward enqueue events on its claim
 * created after the previous run on that claim started (a slot is consumed
 * the moment a run starts, so anything later belongs to the next one). The
 * run's PARENT is the Steward run that created the slot (the first
 * non-coalesced event's source), when that source is itself a Steward run;
 * otherwise the run is a ROOT — onboarding (structure_and_assess from the
 * claim pipeline), an accepted contribution (the reviewer), a staleness
 * sweep, a user order, a Curator change, or a run whose slot the telemetry
 * did not capture (counted as unattributed).
 *
 * A run CHANGED its claim when the assessment it wrote is the claim's first,
 * or differs materially from the previous one: status changed, or credence
 * moved by at least `materialCredenceDelta` (0.1 by default; a flag on the
 * CLI). R is material children per changed parent.
 *
 * Pure and DB-free; cascade-load.ts reads the tables, cascade.ts is the CLI,
 * score.ts folds the headline into the scorecard.
 */

export interface CascadeRun {
  id: string;
  claimId: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
}

export interface CascadeEvent {
  id: string;
  claimId: string | null;
  trigger: string | null;
  sourceRunId: string | null;
  sourceAgent: string | null;
  coalesced: boolean | null;
  createdAt: string;
}

export interface CascadeAssessment {
  claimId: string;
  status: string;
  credence: number | null;
  assessedAt: string;
  trigger: string | null;
}

export interface DepthSample {
  at: string;
  stewardPending: number;
}

export interface CascadeInput {
  runs: CascadeRun[];
  events: CascadeEvent[];
  assessments: CascadeAssessment[];
  /** queue_depth_snapshots in the window, when the sampler ran. */
  depthSamples?: DepthSample[];
  /** Start of the analysis window, for the record. */
  since?: string | null;
}

export interface CascadeOptions {
  /** |Δcredence| at or above which a reassessment counts as material. Default 0.1. */
  materialCredenceDelta?: number;
}

export type ChangeKind = "first" | "material" | "minor" | "none";

export interface RunNode {
  id: string;
  claimId: string | null;
  startedAt: string;
  trigger: string | null;
  parentId: string | null;
  rootId: string;
  generation: number;
  change: ChangeKind;
  /** Signed credence delta vs the previous assessment, when both stated. */
  credenceDelta: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  /** Steward enqueue events this run caused. */
  notified: number;
  notifiedCoalesced: number;
  /** Slot events that could not be attributed to a Steward source. */
  unattributed: boolean;
}

export interface GenerationRow {
  generation: number;
  runs: number;
  firstAssessed: number;
  materiallyChanged: number;
  minor: number;
  noAssessment: number;
  /** Notifications SENT by this generation's runs (to the next). */
  notified: number;
  /** …of which joined an existing pending slot. */
  coalesced: number;
  /** …of which were consumed by a run that then executed. */
  ran: number;
  /** …of which that run materially changed its claim. */
  ranMaterial: number;
  /** Share of notifications that led to a run. */
  ranShare: number | null;
  /** Share of notifications that led to a material change — the materiality decay. */
  materialShare: number | null;
  /** Material children (gen g+1) per changed parent (gen g). */
  R: number | null;
}

export interface DrainShape {
  source: "queue_depth_snapshots" | "reconstructed" | "none";
  /** Pending depth over time; reconstructed series are approximate (see reading). */
  series: Array<{ at: string; pending: number }>;
  peak: number;
  peakAt: string | null;
  final: number;
  /** Times the depth rose again after its peak — 0 means it drained monotonically. */
  risesAfterPeak: number;
  monotoneDrain: boolean;
}

export interface CascadeReport {
  window: { since: string | null; runs: number; stewardEvents: number; assessments: number };
  materialCredenceDelta: number;
  /** Material children per changed parent (first or material), over all generations. */
  R: number | null;
  /** The same over parents that were themselves material REassessments (gen ≥ 1 or a re-trigger). */
  rReassessment: number | null;
  changedParents: number;
  materialChildren: number;
  perGeneration: GenerationRow[];
  coalescing: { events: number; coalesced: number; share: number | null };
  cascades: {
    roots: number;
    /** Roots with at least one child. */
    propagating: number;
    sizeHistogram: Record<number, number>;
    depthHistogram: Record<number, number>;
    maxSize: number;
    meanSize: number | null;
    maxDepth: number;
    largest: Array<{ rootId: string; claimId: string | null; trigger: string | null; size: number; depth: number }>;
  };
  oscillations: {
    /** A→B→A status sequences on one claim. */
    status: number;
    /** Credence reversals: two consecutive material moves in opposite directions. */
    credence: number;
    claims: string[];
  };
  drain: DrainShape;
  unattributedRuns: number;
  rootsByTrigger: Record<string, number>;
  runs: RunNode[];
  reading: string;
}

const toMs = (s: string | null | undefined): number => (s ? new Date(s).getTime() : Number.NaN);
const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

function isMaterial(
  prev: CascadeAssessment | undefined,
  next: CascadeAssessment,
  threshold: number
): { kind: ChangeKind; delta: number | null } {
  if (!prev) return { kind: "first", delta: null };
  const both = typeof prev.credence === "number" && typeof next.credence === "number";
  const delta = both ? next.credence! - prev.credence! : null;
  if (prev.status !== next.status) return { kind: "material", delta };
  if (delta !== null && Math.abs(delta) >= threshold - 1e-12) return { kind: "material", delta };
  // One side states a credence and the other does not: the verdict's shape
  // changed, which is material under §7 (the omission is information).
  if (!both && (typeof prev.credence === "number") !== (typeof next.credence === "number")) {
    return { kind: "material", delta };
  }
  return { kind: "minor", delta };
}

export function analyzeCascade(input: CascadeInput, opts: CascadeOptions = {}): CascadeReport {
  const threshold = opts.materialCredenceDelta ?? 0.1;
  const runs = [...input.runs].sort((x, y) => toMs(x.startedAt) - toMs(y.startedAt));
  const runIds = new Set(runs.map((r) => r.id));
  const events = input.events
    .filter((e) => e.claimId)
    .sort((x, y) => toMs(x.createdAt) - toMs(y.createdAt));
  const assessments = [...input.assessments].sort((x, y) => toMs(x.assessedAt) - toMs(y.assessedAt));

  const runsByClaim = new Map<string, CascadeRun[]>();
  for (const r of runs) {
    if (!r.claimId) continue;
    (runsByClaim.get(r.claimId) ?? runsByClaim.set(r.claimId, []).get(r.claimId)!).push(r);
  }
  const eventsByClaim = new Map<string, CascadeEvent[]>();
  for (const e of events) {
    (eventsByClaim.get(e.claimId!) ?? eventsByClaim.set(e.claimId!, []).get(e.claimId!)!).push(e);
  }
  const assessmentsByClaim = new Map<string, CascadeAssessment[]>();
  for (const a of assessments) {
    (assessmentsByClaim.get(a.claimId) ?? assessmentsByClaim.set(a.claimId, []).get(a.claimId)!).push(a);
  }

  // Each event → the run that consumed it (the next run on its claim
  // starting at or after the event). Needed for "notified → ran".
  const consumedBy = new Map<string, string | null>();
  // Each run → its slot events, parent, trigger.
  const nodes = new Map<string, RunNode>();
  for (const [claimId, claimRuns] of runsByClaim) {
    const claimEvents = eventsByClaim.get(claimId) ?? [];
    const claimAssessments = assessmentsByClaim.get(claimId) ?? [];
    for (let i = 0; i < claimRuns.length; i++) {
      const run = claimRuns[i]!;
      const start = toMs(run.startedAt);
      const prevStart = i > 0 ? toMs(claimRuns[i - 1]!.startedAt) : Number.NEGATIVE_INFINITY;
      const slot = claimEvents.filter((e) => {
        const t = toMs(e.createdAt);
        return t > prevStart && t <= start;
      });
      for (const e of slot) consumedBy.set(e.id, run.id);
      const creator = slot.find((e) => e.coalesced === false) ?? slot[0];
      const parentId = creator?.sourceRunId && runIds.has(creator.sourceRunId) ? creator.sourceRunId : null;

      // What this run wrote: the last assessment in [start, end], where end
      // is the run's finish or, failing that, the next run's start.
      const end = run.finishedAt
        ? toMs(run.finishedAt)
        : i + 1 < claimRuns.length
          ? toMs(claimRuns[i + 1]!.startedAt)
          : Number.POSITIVE_INFINITY;
      const written = claimAssessments.filter((a) => {
        const t = toMs(a.assessedAt);
        return t >= start && t <= end;
      });
      const wrote = written[written.length - 1];
      const prev = [...claimAssessments].reverse().find((a) => toMs(a.assessedAt) < start);
      const change = wrote ? isMaterial(prev, wrote, threshold) : { kind: "none" as ChangeKind, delta: null };

      nodes.set(run.id, {
        id: run.id,
        claimId,
        startedAt: run.startedAt,
        trigger: creator?.trigger ?? null,
        parentId,
        rootId: run.id, // fixed below
        generation: 0,
        change: change.kind,
        credenceDelta: change.delta === null ? null : round(change.delta),
        statusBefore: prev?.status ?? null,
        statusAfter: wrote?.status ?? null,
        notified: 0,
        notifiedCoalesced: 0,
        unattributed: slot.length === 0,
      });
    }
  }
  // Runs without a claim id cannot be placed; they are counted in the window only.
  // Generations, in start order (parents always start first).
  for (const run of runs) {
    const n = nodes.get(run.id);
    if (!n) continue;
    if (n.parentId && nodes.has(n.parentId)) {
      const p = nodes.get(n.parentId)!;
      n.generation = p.generation + 1;
      n.rootId = p.rootId;
    }
  }
  // Notifications sent per run.
  for (const e of events) {
    if (!e.sourceRunId) continue;
    const src = nodes.get(e.sourceRunId);
    if (!src) continue;
    src.notified++;
    if (e.coalesced) src.notifiedCoalesced++;
  }

  // Per generation.
  const gens = new Map<number, GenerationRow>();
  const row = (g: number): GenerationRow =>
    gens.get(g) ??
    gens
      .set(g, {
        generation: g,
        runs: 0,
        firstAssessed: 0,
        materiallyChanged: 0,
        minor: 0,
        noAssessment: 0,
        notified: 0,
        coalesced: 0,
        ran: 0,
        ranMaterial: 0,
        ranShare: null,
        materialShare: null,
        R: null,
      })
      .get(g)!;
  for (const n of nodes.values()) {
    const r = row(n.generation);
    r.runs++;
    if (n.change === "first") r.firstAssessed++;
    else if (n.change === "material") r.materiallyChanged++;
    else if (n.change === "minor") r.minor++;
    else r.noAssessment++;
  }
  for (const e of events) {
    const src = e.sourceRunId ? nodes.get(e.sourceRunId) : undefined;
    if (!src) continue;
    const r = row(src.generation);
    r.notified++;
    if (e.coalesced) r.coalesced++;
    const consumer = consumedBy.get(e.id);
    const c = consumer ? nodes.get(consumer) : undefined;
    if (c) {
      r.ran++;
      if (c.change === "material") r.ranMaterial++;
    }
  }
  // R per generation: material children at g+1 per changed parent at g.
  let changedParents = 0;
  let materialChildren = 0;
  let materialParents = 0;
  let materialChildrenOfMaterial = 0;
  const childrenOf = new Map<string, RunNode[]>();
  for (const n of nodes.values()) {
    if (n.parentId) (childrenOf.get(n.parentId) ?? childrenOf.set(n.parentId, []).get(n.parentId)!).push(n);
  }
  const perGenChanged = new Map<number, number>();
  const perGenMaterialKids = new Map<number, number>();
  for (const n of nodes.values()) {
    const changed = n.change === "first" || n.change === "material";
    if (!changed) continue;
    const kids = (childrenOf.get(n.id) ?? []).filter((k) => k.change === "material").length;
    changedParents++;
    materialChildren += kids;
    perGenChanged.set(n.generation, (perGenChanged.get(n.generation) ?? 0) + 1);
    perGenMaterialKids.set(n.generation, (perGenMaterialKids.get(n.generation) ?? 0) + kids);
    const isReassessment = n.change === "material";
    if (isReassessment) {
      materialParents++;
      materialChildrenOfMaterial += kids;
    }
  }
  for (const r of gens.values()) {
    r.ranShare = round(ratio(r.ran, r.notified));
    r.materialShare = round(ratio(r.ranMaterial, r.notified));
    r.R = round(ratio(perGenMaterialKids.get(r.generation) ?? 0, perGenChanged.get(r.generation) ?? 0));
  }
  const perGeneration = [...gens.values()].sort((x, y) => x.generation - y.generation);

  // Coalescing share over steward events that carry the flag.
  const flagged = events.filter((e) => e.coalesced !== null);
  const coalesced = flagged.filter((e) => e.coalesced).length;

  // Trees.
  const treeSize = new Map<string, number>();
  const treeDepth = new Map<string, number>();
  for (const n of nodes.values()) {
    treeSize.set(n.rootId, (treeSize.get(n.rootId) ?? 0) + 1);
    treeDepth.set(n.rootId, Math.max(treeDepth.get(n.rootId) ?? 0, n.generation));
  }
  const sizeHistogram: Record<number, number> = {};
  const depthHistogram: Record<number, number> = {};
  for (const [, s] of treeSize) sizeHistogram[s] = (sizeHistogram[s] ?? 0) + 1;
  for (const [, d] of treeDepth) depthHistogram[d] = (depthHistogram[d] ?? 0) + 1;
  const sizes = [...treeSize.values()];
  const largest = [...treeSize.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([rootId, size]) => {
      const root = nodes.get(rootId)!;
      return { rootId, claimId: root.claimId, trigger: root.trigger, size, depth: treeDepth.get(rootId) ?? 0 };
    });
  const rootsByTrigger: Record<string, number> = {};
  for (const n of nodes.values()) {
    if (n.parentId) continue;
    const k = n.trigger ?? (n.unattributed ? "(unattributed)" : "(unknown)");
    rootsByTrigger[k] = (rootsByTrigger[k] ?? 0) + 1;
  }

  // Oscillation: per claim, over its assessment history in the window.
  let statusOsc = 0;
  let credenceOsc = 0;
  const oscClaims = new Set<string>();
  for (const [claimId, list] of assessmentsByClaim) {
    for (let i = 0; i + 2 < list.length; i++) {
      const s0 = list[i]!.status;
      const s1 = list[i + 1]!.status;
      const s2 = list[i + 2]!.status;
      if (s0 === s2 && s0 !== s1) {
        statusOsc++;
        oscClaims.add(claimId);
      }
    }
    for (let i = 0; i + 2 < list.length; i++) {
      const c0 = list[i]!.credence;
      const c1 = list[i + 1]!.credence;
      const c2 = list[i + 2]!.credence;
      if (typeof c0 !== "number" || typeof c1 !== "number" || typeof c2 !== "number") continue;
      const d1 = c1 - c0;
      const d2 = c2 - c1;
      if (Math.abs(d1) >= threshold - 1e-12 && Math.abs(d2) >= threshold - 1e-12 && Math.sign(d1) !== Math.sign(d2)) {
        credenceOsc++;
        oscClaims.add(claimId);
      }
    }
  }

  const drain = drainShape(input, runs, events);
  const unattributedRuns = [...nodes.values()].filter((n) => n.unattributed).length;

  const R = round(ratio(materialChildren, changedParents));
  const rReassessment = round(ratio(materialChildrenOfMaterial, materialParents));
  const report: CascadeReport = {
    window: {
      since: input.since ?? null,
      runs: runs.length,
      stewardEvents: events.length,
      assessments: assessments.length,
    },
    materialCredenceDelta: threshold,
    R,
    rReassessment,
    changedParents,
    materialChildren,
    perGeneration,
    coalescing: { events: flagged.length, coalesced, share: round(ratio(coalesced, flagged.length)) },
    cascades: {
      roots: treeSize.size,
      propagating: sizes.filter((s) => s > 1).length,
      sizeHistogram,
      depthHistogram,
      maxSize: sizes.length ? Math.max(...sizes) : 0,
      meanSize: round(sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null),
      maxDepth: treeDepth.size ? Math.max(...treeDepth.values()) : 0,
      largest,
    },
    oscillations: { status: statusOsc, credence: credenceOsc, claims: [...oscClaims] },
    drain,
    unattributedRuns,
    rootsByTrigger,
    runs: [...nodes.values()].sort((x, y) => toMs(x.startedAt) - toMs(y.startedAt)),
    reading: "",
  };
  report.reading = readCascade(report);
  return report;
}

/**
 * Pending-depth over the window: the sampler's rows when it ran; otherwise
 * reconstructed from the telemetry — +1 for every slot-creating steward
 * enqueue, −1 when a Steward run starts — from an assumed empty lane at the
 * window's start, clamped at zero. The reconstruction is approximate:
 * claims already pending when the window opened are invisible, and events
 * the telemetry dropped shift the curve.
 */
export function drainShape(input: CascadeInput, runs: CascadeRun[], events: CascadeEvent[]): DrainShape {
  let series: Array<{ at: string; pending: number }> = [];
  let source: DrainShape["source"] = "none";
  const samples = (input.depthSamples ?? []).slice().sort((x, y) => toMs(x.at) - toMs(y.at));
  if (samples.length >= 2) {
    source = "queue_depth_snapshots";
    series = samples.map((s) => ({ at: s.at, pending: s.stewardPending }));
  } else if (runs.length + events.length > 0) {
    source = "reconstructed";
    const steps: Array<{ t: number; at: string; d: number }> = [];
    for (const e of events) if (e.coalesced !== true) steps.push({ t: toMs(e.createdAt), at: e.createdAt, d: +1 });
    for (const r of runs) steps.push({ t: toMs(r.startedAt), at: r.startedAt, d: -1 });
    steps.sort((x, y) => x.t - y.t || y.d - x.d);
    let pending = 0;
    for (const s of steps) {
      pending = Math.max(0, pending + s.d);
      series.push({ at: s.at, pending });
    }
    // Keep the series readable: at most ~200 points, always keeping the peak.
    if (series.length > 200) {
      const stride = Math.ceil(series.length / 200);
      const peakIdx = series.reduce((best, p, i) => (p.pending > series[best]!.pending ? i : best), 0);
      series = series.filter((_, i) => i % stride === 0 || i === peakIdx || i === series.length - 1);
    }
  }
  let peak = 0;
  let peakAt: string | null = null;
  let peakIdx = -1;
  series.forEach((p, i) => {
    if (p.pending > peak) {
      peak = p.pending;
      peakAt = p.at;
      peakIdx = i;
    }
  });
  let rises = 0;
  for (let i = Math.max(peakIdx, 0) + 1; i < series.length; i++) {
    if (series[i]!.pending > series[i - 1]!.pending) rises++;
  }
  return {
    source,
    series,
    peak,
    peakAt,
    final: series.length ? series[series.length - 1]!.pending : 0,
    risesAfterPeak: rises,
    monotoneDrain: series.length > 0 && rises === 0 && series[series.length - 1]!.pending === 0,
  };
}

export function readCascade(r: CascadeReport): string {
  const parts: string[] = [];
  if (r.window.runs === 0) return "No Steward runs in the window; nothing to reconstruct.";
  if (r.R === null) {
    parts.push("No run changed its claim's assessment, so R is undefined.");
  } else if (r.R < 1) {
    parts.push(
      `R = ${r.R.toFixed(2)}: each changed assessment led to ${r.R.toFixed(2)} materially changed downstream reassessments on average (${r.materialChildren} of ${r.changedParents}), so cascades die out.`
    );
  } else {
    parts.push(
      `R = ${r.R.toFixed(2)} (${r.materialChildren} material children from ${r.changedParents} changed parents): at or above 1, a change propagates without dying out — read the largest cascades.`
    );
  }
  if (r.rReassessment !== null && r.rReassessment !== r.R) {
    parts.push(`Over reassessments alone (excluding first assessments as parents) R = ${r.rReassessment.toFixed(2)}.`);
  }
  const g1 = r.perGeneration.find((g) => g.generation === 0);
  if (g1 && g1.notified > 0) {
    parts.push(
      `Of ${g1.notified} notifications sent by root runs, ${g1.ran} led to a run and ${g1.ranMaterial} to a material change` +
        (g1.materialShare !== null ? ` (materiality ${(g1.materialShare * 100).toFixed(0)}%).` : ".")
    );
  }
  if (r.coalescing.share !== null && r.coalescing.events > 0) {
    parts.push(`Coalescing absorbed ${(r.coalescing.share * 100).toFixed(0)}% of ${r.coalescing.events} steward enqueues.`);
  }
  parts.push(
    `${r.cascades.roots} root(s), ${r.cascades.propagating} of which propagated; largest cascade ${r.cascades.maxSize} run(s), deepest ${r.cascades.maxDepth} generation(s).`
  );
  if (r.oscillations.status + r.oscillations.credence > 0) {
    parts.push(
      `${r.oscillations.status} status oscillation(s) (A→B→A) and ${r.oscillations.credence} credence reversal(s) on ${r.oscillations.claims.length} claim(s) — a sign of two Stewards pulling a claim back and forth.`
    );
  } else {
    parts.push("No oscillations.");
  }
  if (r.drain.source === "none") parts.push("No queue-depth data.");
  else {
    parts.push(
      `Pending depth (${r.drain.source === "reconstructed" ? "reconstructed from the telemetry, approximate" : "sampled"}) peaked at ${r.drain.peak} and ` +
        (r.drain.monotoneDrain
          ? "drained to zero without rising again."
          : `ended at ${r.drain.final} with ${r.drain.risesAfterPeak} rise(s) after the peak.`)
    );
  }
  if (r.unattributedRuns > 0) {
    parts.push(`${r.unattributedRuns} run(s) had no enqueue event in their slot (telemetry gap or pre-window enqueue) and were treated as roots.`);
  }
  return parts.join(" ");
}

/** The scorecard-sized summary (score.ts's `cascade` block, band.ts headline rows). */
export interface CascadeHeadline {
  R: number | null;
  rReassessment: number | null;
  oscillations: number;
  roots: number;
  propagating: number;
  maxSize: number;
  maxDepth: number;
  coalescingShare: number | null;
  drainMonotone: boolean;
  drainSource: DrainShape["source"];
  runs: number;
  reading: string;
}

export function cascadeHeadline(r: CascadeReport): CascadeHeadline {
  return {
    R: r.R,
    rReassessment: r.rReassessment,
    oscillations: r.oscillations.status + r.oscillations.credence,
    roots: r.cascades.roots,
    propagating: r.cascades.propagating,
    maxSize: r.cascades.maxSize,
    maxDepth: r.cascades.maxDepth,
    coalescingShare: r.coalescing.share,
    drainMonotone: r.drain.monotoneDrain,
    drainSource: r.drain.source,
    runs: r.window.runs,
    reading: r.reading,
  };
}

export function renderCascade(r: CascadeReport): string {
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  const o: string[] = [];
  o.push(
    `Cascade stability — window ${r.window.since ?? "(all)"} · ${r.window.runs} steward run(s) · ${r.window.stewardEvents} steward enqueue(s) · ${r.window.assessments} assessment(s) · material |Δcredence| ≥ ${r.materialCredenceDelta}`
  );
  o.push(`  R ${f(r.R)} (material children ${r.materialChildren} / changed parents ${r.changedParents}) · R over reassessments ${f(r.rReassessment)}`);
  o.push(`  gen  runs  first  material  minor  none | notified  coalesced  ran  material  ran%  material%  R`);
  for (const g of r.perGeneration) {
    const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(0).padStart(4)}%`);
    o.push(
      `  ${String(g.generation).padStart(3)}  ${String(g.runs).padStart(4)}  ${String(g.firstAssessed).padStart(5)}  ${String(g.materiallyChanged).padStart(8)}  ${String(g.minor).padStart(5)}  ${String(g.noAssessment).padStart(4)} | ${String(g.notified).padStart(8)}  ${String(g.coalesced).padStart(9)}  ${String(g.ran).padStart(3)}  ${String(g.ranMaterial).padStart(8)}  ${pct(g.ranShare)}  ${pct(g.materialShare)}      ${f(g.R)}`
    );
  }
  o.push(
    `  cascades: ${r.cascades.roots} root(s) (${Object.entries(r.rootsByTrigger).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) · ${r.cascades.propagating} propagating · size max ${r.cascades.maxSize} mean ${f(r.cascades.meanSize)} · depth max ${r.cascades.maxDepth}`
  );
  o.push(
    `  size histogram: ${Object.entries(r.cascades.sizeHistogram).map(([s, n]) => `${s}:${n}`).join(" ") || "—"} · depth histogram: ${Object.entries(r.cascades.depthHistogram).map(([d, n]) => `${d}:${n}`).join(" ") || "—"}`
  );
  for (const c of r.cascades.largest.filter((c) => c.size > 1)) {
    o.push(`    root ${c.rootId.slice(0, 8)} (${c.trigger ?? "?"}, claim ${c.claimId?.slice(0, 8) ?? "?"}): ${c.size} run(s), depth ${c.depth}`);
  }
  o.push(`  coalescing: ${r.coalescing.coalesced} of ${r.coalescing.events} (${f(r.coalescing.share)})`);
  o.push(`  oscillations: status ${r.oscillations.status} · credence ${r.oscillations.credence} · claims ${r.oscillations.claims.length}`);
  o.push(
    `  drain (${r.drain.source}): peak ${r.drain.peak}${r.drain.peakAt ? ` at ${r.drain.peakAt}` : ""} · final ${r.drain.final} · rises after peak ${r.drain.risesAfterPeak} · monotone ${r.drain.monotoneDrain ? "yes" : "no"}`
  );
  o.push(`  ${r.reading}`);
  return o.join("\n");
}
