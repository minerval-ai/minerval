/**
 * The replay schema, mirrored from scripts/corpus/replay-types.ts for the web
 * (as web/lib/types.ts mirrors the API), plus the pure helpers the player is
 * built on: folding an arm's deltas into the graph as it stood after any
 * event, a claim's credence over time, and a deterministic layered layout
 * assigned from the FINAL graph so nodes keep their place as they appear.
 *
 * Nothing here touches the filesystem: the "use client" player imports this
 * module; the loaders live in web/lib/replay.ts.
 */

export const REPLAY_VERSION = 1 as const;

export type ReplayKind = "ingest" | "property" | "swap" | "contributions" | "adversarial" | "personas" | "redteam";

export type ReplayAgent =
  | "extractor"
  | "matcher"
  | "steward"
  | "curator"
  | "tagger"
  | "contribution_reviewer"
  | "dispute_arbitrator"
  | "audit"
  | "lookout"
  | "consistency_checker"
  | "grantmaker"
  | "judge"
  | "redteam"
  | "persona"
  | "system"
  | string;

export interface ReplayFingerprint {
  pipelineEpoch: string | null;
  gitCommit: string | null;
  profile: string | null;
  swap: { agent: string; model: string } | null;
  order: string | null;
  models: Record<string, string | undefined>;
  caps: Record<string, number>;
}

export interface ReplaySource {
  id: string;
  key: string | null;
  title: string | null;
  url: string | null;
  order: number;
  words?: number | null;
}

export interface ReplayClaim {
  id: string;
  text: string;
  claimType: string;
  createdBy: string | null;
  createdAt: string;
  importance: number;
  stewardState: string;
  status: string | null;
  credence: number | null;
  confidence: number | null;
  topLevel: boolean;
  sourceIds: string[];
}

export interface ReplayEdge {
  id: string;
  parentId: string;
  childId: string;
  relation: string;
  argumentId: string | null;
  createdAt: string;
}

export type ReplayStepKind =
  | "prompt"        // what the agent was given: model, system prompt, initial messages, tool definitions
  | "thought"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "completion"
  | string;

/** A system prompt as the exporter records it: one string, or the API's content blocks. */
export type ReplayPromptText = string | Array<{ type?: string; text?: string; [k: string]: unknown }>;

export interface ReplayToolDef {
  name: string;
  description?: string | null;
  input_schema?: unknown;
}

/** The payload of a "prompt" step (on `step.prompt`, or `step.input` in older exports). */
export interface ReplayPromptSpec {
  model?: string | null;
  effort?: string | null;
  maxTokens?: number | null;
  system?: ReplayPromptText | null;
  initialMessages?: Array<{ role?: string; content?: unknown }> | null;
  tools?: ReplayToolDef[] | null;
  /** The sha256 of the system text, matching ReplayArm.promptsUsed. */
  sha256?: string | null;
}

export interface ReplayStep {
  seq: number;
  kind: ReplayStepKind;
  at: string | null;
  /** Short text for the reader. A derived gist in the index; the verbatim text in a detail file. */
  text: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  truncated?: boolean;
  /** Character sizes of the untrimmed fields, so the index can say how much a detail file holds. */
  sizes?: { text?: number; input?: number; output?: number; system?: number; [k: string]: number | undefined } | null;
  /** True when this record carries the untrimmed content (a detail file); false or absent in the index. */
  full?: boolean;
  prompt?: ReplayPromptSpec | null;
}

/** One tool read the event made, for the data-flow panel. */
export interface ReplayDataRead {
  tool: string;
  claimIds?: string[];
  sourceIds?: string[];
}

export type ReplayDelta =
  | { op: "source_submitted"; sourceId: string; title: string | null; url: string | null }
  | { op: "claim_created"; claimId: string; text: string; createdBy: string | null; topLevel: boolean; sourceId?: string | null }
  | { op: "claim_matched"; claimId: string; sourceId: string | null; stance: string; verbatim?: string | null; proposed?: string | null }
  | { op: "instance_added"; claimId: string; sourceId: string | null; stance: string }
  | { op: "edge_added"; edgeId: string; parentId: string; childId: string; relation: string; argumentId?: string | null }
  | { op: "assessment_recorded"; claimId: string; status: string; credence: number | null; confidence: number; trigger: string | null; summary?: string | null }
  | { op: "canonical_form_updated"; claimId: string; before: string; after: string }
  | { op: "importance_set"; claimId: string; importance: number }
  | { op: "claim_merged"; claimId: string; into: string }
  | { op: "steward_notified"; claimId: string; trigger: string; coalesced: boolean | null }
  | { op: "contribution_submitted"; contributionId: string; claimId: string | null; type: string; contributor: string; arm?: string | null; gambit?: string | null }
  | { op: "review_decided"; contributionId: string; decision: string; confidence: number | null; badFaith: boolean; reasoning?: string | null }
  | { op: "appeal_filed"; contributionId: string; appealId: string }
  | { op: "arbitration_decided"; contributionId: string; outcome: string; reasoning?: string | null }
  | { op: "note"; text: string };

export interface ReplayEvent {
  seq: number;
  at: string;
  endedAt: string | null;
  agent: ReplayAgent;
  runId: string | null;
  claimId: string | null;
  claimText?: string | null;
  sourceId: string | null;
  trigger: string | null;
  causedBy: number | null;
  title: string;
  outcome: "ok" | "error" | "running" | null;
  error?: string | null;
  steps: ReplayStep[];
  deltas: ReplayDelta[];
  costMicroUsd: number | null;
  durationMs: number | null;
  attribution: "exact" | "run-window" | "harness";
  /** Where the untrimmed event lives, relative to the events root: "a/12.json" → /evals/replays/<name>/events/a/12.json. */
  detailPath?: string | null;
  /** What the event read (tool calls that fetched claims or sources) and what it wrote (its deltas). */
  dataFlow?: { read: ReplayDataRead[]; wrote: ReplayDelta[] } | null;
}

/** A detail file: the same event with every step untrimmed (`steps[i].full`). */
export type ReplayEventDetail = ReplayEvent;

/** One distinct system prompt an arm ran with; the text itself is in the prompt step of any event that used it. */
export interface ReplayPromptUsed {
  sha256: string;
  agents: string[];
  count: number;
  chars: number;
  /** An event that used it, when the exporter names one; otherwise the player finds the first event of a listed agent. */
  eventSeq?: number | null;
}

export interface ReplayArm {
  key: string;
  label: string;
  variation: string | null;
  fingerprint: ReplayFingerprint;
  sources: ReplaySource[];
  events: ReplayEvent[];
  final: { claims: ReplayClaim[]; edges: ReplayEdge[] };
  /** The graph as it stood BEFORE the arm's first event, for episodes run against a snapshot (contributions, adversarial). */
  initial?: { claims: ReplayClaim[]; edges: ReplayEdge[] } | null;
  costMicroUsd: number | null;
  capped: boolean;
  database: string | null;
  promptsUsed?: ReplayPromptUsed[] | null;
  /** The exact command(s) that produced the arm, when the driver recorded them. */
  commands?: string[] | null;
}

export interface ReplayMatching {
  armA: string;
  armB: string;
  pairs: Array<{ a: string; b: string; method: string; similarity: number | null }>;
  unmatchedA: string[];
  unmatchedB: string[];
  summary: {
    claimSetF1: number | null;
    credenceMeanAbsDiff: number | null;
    statusAgreement: number | null;
    edgeEditDistance: number | null;
  } | null;
}

export interface ReplayScenario {
  name: string;
  description: string | null;
  actors: Array<{ key: string; displayName: string; note?: string | null; tier?: string | null; role?: "attacker" | "benign" | "persona" | null }>;
  targets?: Array<{ key: string; claimId: string | null; text: string | null; direction?: "up" | "down" | null }>;
}

export interface Replay {
  version: typeof REPLAY_VERSION;
  kind: ReplayKind;
  name: string;
  title: string;
  cluster: string | null;
  generatedAt: string;
  about: string;
  arms: ReplayArm[];
  matching: ReplayMatching[] | null;
  scenario: ReplayScenario | null;
  summary: Record<string, unknown> | null;
  evalRunId: string | null;
  /** Total metered cost across arms. */
  costMicroUsd: number | null;
  /** The exact command(s) the episode was run with, when the driver recorded them. */
  commands?: string[] | null;
}

/** The site path of an event's detail file: the recorded relative path, or the conventional one. */
export function detailUrl(replayName: string, armKey: string, event: ReplayEvent): string {
  const root = `/evals/replays/${encodeURIComponent(replayName)}/events/`;
  const p = event.detailPath;
  if (p) return root + p.replace(/^\/+/, "");
  return `${root}${encodeURIComponent(armKey)}/${event.seq}.json`;
}

/** The prompt payload of a prompt step, wherever the exporter put it. */
export function promptSpecOf(step: ReplayStep): ReplayPromptSpec | null {
  if (step.kind !== "prompt") return null;
  const p = step.prompt ?? (step.input && typeof step.input === "object" ? (step.input as ReplayPromptSpec) : null);
  return p ?? null;
}

/** A system prompt's text, whether recorded as one string or as content blocks. */
export function promptText(system: ReplayPromptText | null | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b))).join("\n\n");
}

/** Events an event caused (the reverse of causedBy), by index. */
export function causedIndexes(arm: ReplayArm, seq: number): number[] {
  const out: number[] = [];
  arm.events.forEach((e, i) => { if (e.causedBy === seq) out.push(i); });
  return out;
}

/** The chain of causes above an event, nearest first. Stops on a cycle. */
export function causeChain(arm: ReplayArm, index: number): number[] {
  const bySeq = eventIndexBySeq(arm);
  const out: number[] = [];
  const seen = new Set<number>([index]);
  let cur = arm.events[index];
  while (cur && cur.causedBy != null) {
    const i = bySeq.get(cur.causedBy);
    if (i == null || seen.has(i)) break;
    seen.add(i);
    out.push(i);
    cur = arm.events[i];
  }
  return out;
}

/** Which event (arm key, index) carries a given prompt's text: the named one, else the first event of a listed agent. */
export function promptCarrier(replay: Replay, armKey: string, p: ReplayPromptUsed): { armKey: string; index: number } | null {
  const arm = replay.arms.find((a) => a.key === armKey);
  if (!arm) return null;
  if (p.eventSeq != null) {
    const i = arm.events.findIndex((e) => e.seq === p.eventSeq);
    if (i >= 0) return { armKey, index: i };
  }
  const i = arm.events.findIndex((e) => p.agents.includes(e.agent) && (e.steps.some((s) => s.kind === "prompt") || e.runId));
  return i >= 0 ? { armKey, index: i } : null;
}

/** True when this build knows how to play the recording. */
export function isKnownVersion(r: { version?: unknown }): r is { version: typeof REPLAY_VERSION } {
  return r.version === REPLAY_VERSION;
}

/** A run traced `off` records events with no steps: the player says so rather than showing empty transcripts. */
export function isTraced(replay: Replay): boolean {
  return replay.arms.some((arm) => arm.events.some((e) => e.steps.length > 0));
}

// ---- the graph as it stood after an event -----------------------------------

export interface InterimClaim {
  id: string;
  text: string;
  claimType: string | null;
  createdBy: string | null;
  topLevel: boolean;
  status: string | null;
  credence: number | null;
  confidence: number | null;
  importance: number | null;
  /** Instances recorded so far (the creating source counts as one). */
  instances: number;
  sourceIds: string[];
  /** Stances of the instances matched onto this claim, in order. */
  stances: string[];
  /** The claim this one was merged into, when it was. */
  merged: string | null;
  /** True when the claim predates the recording (seeded from `arm.initial`, or from the final record when no initial state was exported). */
  preexisting?: boolean;
  /** True when a pre-existing claim's state before the window is not recorded (no `arm.initial`, and the window reassessed it). */
  priorUnknown?: boolean;
  /** The seq of the event that created it and of the last event that touched it. */
  createdSeq: number;
  touchedSeq: number;
}

export interface InterimEdge {
  id: string;
  parentId: string;
  childId: string;
  relation: string;
  argumentId: string | null;
  seq: number;
}

export interface InterimSource {
  id: string;
  title: string | null;
  url: string | null;
  seq: number;
}

export interface InterimGraph {
  claims: InterimClaim[];
  edges: InterimEdge[];
  sources: InterimSource[];
  byId: Record<string, InterimClaim>;
}

/**
 * Fold the arm's deltas, in event order, up to and including `uptoSeq`
 * (Infinity for the final state). A delta that names a claim the deltas have
 * not created (an assessment of a claim that predates the window) still gets
 * a node, filled from the arm's final claim record where one exists, so the
 * picture never references a claim it cannot show.
 */
export function graphAt(arm: ReplayArm, uptoSeq: number): InterimGraph {
  const finalById = new Map(arm.final.claims.map((c) => [c.id, c]));
  const byId: Record<string, InterimClaim> = {};
  const claims: InterimClaim[] = [];
  const edges: InterimEdge[] = [];
  const edgeIds = new Set<string>();
  const sources: InterimSource[] = [];
  const sourceIds = new Set<string>();

  const ensure = (id: string, seq: number, seed?: Partial<InterimClaim>): InterimClaim => {
    let c = byId[id];
    if (!c) {
      const f = finalById.get(id);
      c = {
        id,
        text: seed?.text ?? f?.text ?? id,
        claimType: f?.claimType ?? null,
        createdBy: seed?.createdBy ?? f?.createdBy ?? null,
        topLevel: seed?.topLevel ?? f?.topLevel ?? false,
        status: null,
        credence: null,
        confidence: null,
        importance: null,
        instances: 0,
        sourceIds: [],
        stances: [],
        merged: null,
        createdSeq: seq,
        touchedSeq: seq,
      };
      byId[id] = c;
      claims.push(c);
    }
    c.touchedSeq = seq;
    return c;
  };

  const events = [...arm.events].sort((a, b) => a.seq - b.seq);

  // Claims that predate the recording: seed them from the exported initial
  // state, or, failing that, from the final record (with their pre-window
  // assessment marked unknown when the window reassessed them).
  const createdInWindow = new Set<string>();
  const assessedInWindow = new Set<string>();
  for (const ev of events) for (const d of ev.deltas) {
    if (d.op === "claim_created") createdInWindow.add(d.claimId);
    if (d.op === "assessment_recorded") assessedInWindow.add(d.claimId);
  }
  const seedFrom = arm.initial ?? null;
  const seeds: Array<{ c: ReplayClaim; known: boolean }> = seedFrom
    ? seedFrom.claims.map((c) => ({ c, known: true }))
    : arm.final.claims.filter((c) => !createdInWindow.has(c.id)).map((c) => ({ c, known: !assessedInWindow.has(c.id) }));
  for (const { c: f, known } of seeds) {
    const c = ensure(f.id, 0, { text: f.text, createdBy: f.createdBy, topLevel: f.topLevel });
    c.preexisting = true;
    c.instances = f.sourceIds.length;
    c.sourceIds = [...f.sourceIds];
    c.importance = f.importance;
    if (known) { c.status = f.status; c.credence = f.credence; c.confidence = f.confidence; }
    else c.priorUnknown = true;
  }
  for (const e of seedFrom?.edges ?? (seedFrom ? [] : arm.final.edges.filter((e) => byId[e.parentId] && byId[e.childId]))) {
    if (!edgeIds.has(e.id)) {
      edgeIds.add(e.id);
      edges.push({ id: e.id, parentId: e.parentId, childId: e.childId, relation: e.relation, argumentId: e.argumentId, seq: 0 });
    }
  }

  for (const ev of events) {
    if (ev.seq > uptoSeq) break;
    for (const d of ev.deltas) {
      switch (d.op) {
        case "source_submitted":
          if (!sourceIds.has(d.sourceId)) {
            sourceIds.add(d.sourceId);
            sources.push({ id: d.sourceId, title: d.title, url: d.url, seq: ev.seq });
          }
          break;
        case "claim_created": {
          const c = ensure(d.claimId, ev.seq, { text: d.text, createdBy: d.createdBy, topLevel: d.topLevel });
          c.text = d.text;
          c.topLevel = c.topLevel || d.topLevel;
          if (d.sourceId) {
            c.instances += 1;
            if (!c.sourceIds.includes(d.sourceId)) c.sourceIds.push(d.sourceId);
          }
          break;
        }
        case "claim_matched":
        case "instance_added": {
          const c = ensure(d.claimId, ev.seq);
          c.instances += 1;
          c.stances.push(d.stance);
          if (d.sourceId && !c.sourceIds.includes(d.sourceId)) c.sourceIds.push(d.sourceId);
          if (d.sourceId) c.topLevel = true;
          break;
        }
        case "edge_added": {
          ensure(d.parentId, ev.seq);
          ensure(d.childId, ev.seq);
          if (!edgeIds.has(d.edgeId)) {
            edgeIds.add(d.edgeId);
            edges.push({ id: d.edgeId, parentId: d.parentId, childId: d.childId, relation: d.relation, argumentId: d.argumentId ?? null, seq: ev.seq });
          }
          break;
        }
        case "assessment_recorded": {
          const c = ensure(d.claimId, ev.seq);
          c.status = d.status;
          c.credence = d.credence;
          c.confidence = d.confidence;
          break;
        }
        case "canonical_form_updated":
          ensure(d.claimId, ev.seq).text = d.after;
          break;
        case "importance_set":
          ensure(d.claimId, ev.seq).importance = d.importance;
          break;
        case "claim_merged": {
          const c = ensure(d.claimId, ev.seq);
          c.merged = d.into;
          ensure(d.into, ev.seq);
          break;
        }
        case "steward_notified":
          ensure(d.claimId, ev.seq);
          break;
        default:
          break;
      }
    }
  }
  return { claims, edges, sources, byId };
}

/** The arm's final graph, from its final claim/edge records rather than the deltas: the layout's input. */
export function finalGraph(arm: ReplayArm): InterimGraph {
  const folded = graphAt(arm, Infinity);
  const byId: Record<string, InterimClaim> = {};
  const claims: InterimClaim[] = [];
  const seen = new Set<string>();
  for (const f of arm.final.claims) {
    const c = folded.byId[f.id];
    const merged = c?.merged ?? null;
    const node: InterimClaim = {
      id: f.id,
      text: f.text,
      claimType: f.claimType,
      createdBy: f.createdBy,
      topLevel: f.topLevel || (c?.topLevel ?? false),
      status: f.status,
      credence: f.credence,
      confidence: f.confidence,
      importance: f.importance,
      instances: Math.max(c?.instances ?? 0, f.sourceIds.length),
      sourceIds: f.sourceIds.length ? f.sourceIds : (c?.sourceIds ?? []),
      stances: c?.stances ?? [],
      merged,
      createdSeq: c?.createdSeq ?? 0,
      touchedSeq: c?.touchedSeq ?? 0,
    };
    byId[f.id] = node;
    claims.push(node);
    seen.add(f.id);
  }
  // Claims the deltas mention that the final record lacks (merged away, or a
  // partial final): keep them so the interim picture has somewhere to put them.
  for (const c of folded.claims) {
    if (seen.has(c.id)) continue;
    byId[c.id] = c;
    claims.push(c);
  }
  const edgeIds = new Set<string>();
  const edges: InterimEdge[] = [];
  for (const e of arm.final.edges) {
    edgeIds.add(e.id);
    edges.push({ id: e.id, parentId: e.parentId, childId: e.childId, relation: e.relation, argumentId: e.argumentId, seq: folded.edges.find((x) => x.id === e.id)?.seq ?? 0 });
  }
  for (const e of folded.edges) if (!edgeIds.has(e.id)) edges.push(e);
  return { claims, edges, sources: folded.sources, byId };
}

// ---- indexes and series -------------------------------------------------------

/** runId → index into arm.events, for resolving enqueue provenance. */
export function eventIndexByRunId(arm: ReplayArm): Map<string, number> {
  const m = new Map<string, number>();
  arm.events.forEach((e, i) => {
    if (e.runId) m.set(e.runId, i);
  });
  return m;
}

/** seq → index into arm.events, for the "caused by" link. */
export function eventIndexBySeq(arm: ReplayArm): Map<number, number> {
  const m = new Map<number, number>();
  arm.events.forEach((e, i) => m.set(e.seq, i));
  return m;
}

export interface CredencePoint {
  seq: number;
  /** Index into arm.events of the event that recorded it. */
  index: number;
  credence: number | null;
  status: string;
  confidence: number;
  trigger: string | null;
}

/** Every assessment recorded on one claim, in event order. */
export function credenceSeries(arm: ReplayArm, claimId: string): CredencePoint[] {
  const out: CredencePoint[] = [];
  // A claim that predates the recording starts from its known prior state (index -1).
  const prior = graphAt(arm, -1).byId[claimId];
  if (prior?.preexisting && !prior.priorUnknown && prior.status) {
    out.push({ seq: -1, index: -1, credence: prior.credence, status: prior.status, confidence: prior.confidence ?? 0, trigger: null });
  }
  arm.events.forEach((e, index) => {
    for (const d of e.deltas) {
      if (d.op === "assessment_recorded" && d.claimId === claimId) {
        out.push({ seq: e.seq, index, credence: d.credence, status: d.status, confidence: d.confidence, trigger: d.trigger });
      }
    }
  });
  return out;
}

/** The claim ids an event touches: its own claim and every claim its deltas name. */
export function touchedClaimIds(event: ReplayEvent): string[] {
  const ids = new Set<string>();
  if (event.claimId) ids.add(event.claimId);
  for (const d of event.deltas) {
    if ("claimId" in d && d.claimId) ids.add(d.claimId);
    if (d.op === "edge_added") { ids.add(d.parentId); ids.add(d.childId); }
    if (d.op === "claim_merged") ids.add(d.into);
  }
  return [...ids];
}

// ---- layout -------------------------------------------------------------------

export const NODE_W = 148;
export const NODE_H = 46;
const GAP_X = 14;
const GROUP_GAP = 26;
const ROW_GAP = 64;
const PAD = 12;

export interface LayoutNode {
  id: string;
  x: number;       // left, world coords
  y: number;       // top
  w: number;
  h: number;
  depth: number;
  /** The source the top-level claim is grouped under (its first source), or the parent group it hangs from. */
  group: string | null;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  byId: Record<string, LayoutNode>;
  width: number;
  height: number;
  /** Group labels along the top row: one per source that has a top-level claim. */
  groups: Array<{ key: string; x: number; w: number }>;
}

/**
 * A deterministic layered layout. Top-level claims sit in one row, grouped by
 * their first source in the order the sources landed; subclaims hang below
 * by decomposition depth (shortest path from a top-level claim), each shown
 * once, ordered by the mean x of their parents so edges stay short. Positions
 * come from the whole graph passed in: give it the final graph and the picture
 * does not jump as nodes are revealed.
 */
export function layoutGraph(graph: InterimGraph): GraphLayout {
  const claims = graph.claims;
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!graph.byId[e.parentId] || !graph.byId[e.childId]) continue;
    childrenOf.set(e.parentId, [...(childrenOf.get(e.parentId) ?? []), e.childId]);
    parentsOf.set(e.childId, [...(parentsOf.get(e.childId) ?? []), e.parentId]);
  }

  // Roots: top-level claims, plus anything nobody points at (an orphan the
  // record calls a subclaim still needs a row).
  const roots = claims.filter((c) => c.topLevel || !(parentsOf.get(c.id)?.length));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) { depth.set(r.id, 0); queue.push(r.id); }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const ch of childrenOf.get(id) ?? []) {
      if (!depth.has(ch)) { depth.set(ch, d + 1); queue.push(ch); }
    }
  }
  for (const c of claims) if (!depth.has(c.id)) depth.set(c.id, 0);

  const sourceOrder = new Map<string, number>();
  graph.sources.forEach((s, i) => sourceOrder.set(s.id, i));
  const sourceRank = (c: InterimClaim) => {
    const first = c.sourceIds[0];
    if (!first) return 1e6;
    return sourceOrder.get(first) ?? 1e5 + first.charCodeAt(0);
  };

  // Row 0: grouped by first source, then by creation order; stable tiebreak on id.
  const row0 = claims.filter((c) => depth.get(c.id) === 0).sort((a, b) =>
    sourceRank(a) - sourceRank(b) || a.createdSeq - b.createdSeq || a.id.localeCompare(b.id));

  const byId: Record<string, LayoutNode> = {};
  const nodes: LayoutNode[] = [];
  const groups: Array<{ key: string; x: number; w: number }> = [];
  let x = PAD;
  let lastGroup: string | null | undefined;
  let groupStart = PAD;
  for (const c of row0) {
    const g = c.sourceIds[0] ?? null;
    if (lastGroup !== undefined && g !== lastGroup) {
      groups.push({ key: lastGroup ?? "", x: groupStart, w: x - GAP_X - groupStart });
      x += GROUP_GAP - GAP_X;
      groupStart = x;
    }
    const n: LayoutNode = { id: c.id, x, y: PAD + 18, w: NODE_W, h: NODE_H, depth: 0, group: g };
    byId[c.id] = n;
    nodes.push(n);
    x += NODE_W + GAP_X;
    lastGroup = g;
  }
  if (row0.length) groups.push({ key: lastGroup ?? "", x: groupStart, w: x - GAP_X - groupStart });
  let width = x - GAP_X + PAD;

  const maxDepth = Math.max(0, ...[...depth.values()]);
  for (let d = 1; d <= maxDepth; d++) {
    const row = claims.filter((c) => depth.get(c.id) === d);
    const bary = (c: InterimClaim) => {
      const ps = (parentsOf.get(c.id) ?? []).map((p) => byId[p]).filter(Boolean);
      if (!ps.length) return 1e6;
      return ps.reduce((s, p) => s + p.x + p.w / 2, 0) / ps.length;
    };
    row.sort((a, b) => bary(a) - bary(b) || a.createdSeq - b.createdSeq || a.id.localeCompare(b.id));
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    // Centre the row under the row above, but never off the left edge.
    let rx = Math.max(PAD, (width - rowW) / 2);
    const y = PAD + 18 + d * (NODE_H + ROW_GAP);
    for (const c of row) {
      const parents = parentsOf.get(c.id) ?? [];
      const n: LayoutNode = { id: c.id, x: rx, y, w: NODE_W, h: NODE_H, depth: d, group: parents[0] ?? null };
      byId[c.id] = n;
      nodes.push(n);
      rx += NODE_W + GAP_X;
    }
    width = Math.max(width, rx - GAP_X + PAD);
  }
  const height = PAD + 18 + (maxDepth + 1) * NODE_H + maxDepth * ROW_GAP + PAD;
  return { nodes, byId, width: Math.max(width, NODE_W + 2 * PAD), height, groups };
}

// ---- lockstep between arms ------------------------------------------------------

/**
 * The "source order" of each event: the position (in the arm's ingest order)
 * of the source it works on, carried forward through events that name none,
 * so two arms can be stepped by "same source" instead of by event index.
 */
export function sourceOrderOfEvents(arm: ReplayArm): number[] {
  const order = new Map(arm.sources.map((s) => [s.id, s.order]));
  let cur = -1;
  return arm.events.map((e) => {
    if (e.sourceId && order.has(e.sourceId)) cur = order.get(e.sourceId)!;
    return cur;
  });
}

/**
 * For a master index in arm A, the matching index in arm B when locked to the
 * same source: the same offset within B's block of events for that source
 * order, clipped to the block. Before any source (-1) both start at 0.
 */
export function lockedIndex(master: ReplayArm, masterIndex: number, other: ReplayArm): number {
  const mo = sourceOrderOfEvents(master);
  const oo = sourceOrderOfEvents(other);
  if (other.events.length === 0) return 0;
  const s = mo[Math.min(masterIndex, mo.length - 1)] ?? -1;
  const mStart = mo.indexOf(s);
  const offset = Math.max(0, masterIndex - mStart);
  const oStart = oo.indexOf(s);
  if (oStart < 0) return Math.min(masterIndex, other.events.length - 1);
  let oEnd = oStart;
  while (oEnd + 1 < oo.length && oo[oEnd + 1] === s) oEnd++;
  return Math.min(oStart + offset, oEnd);
}
