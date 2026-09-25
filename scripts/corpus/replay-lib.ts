/**
 * The replay exporter, the pure half (#334, the evals page's "show me"
 * half): plain rows from the trace substrate (agent_runs, agent_steps,
 * enqueue_events, llm_usage) and the graph tables in, one ReplayArm out.
 * replay.ts reads the rows from a database and writes the files; this
 * module never touches one, so the whole attribution logic is unit-tested
 * on fixture rows.
 *
 * What it does, in order:
 *   1. One ReplayEvent per agent_runs row, plus harness events: a "system"
 *      event per source submitted in the window, a "persona" event per
 *      contribution and per appeal. Ordered by time.
 *   2. Steps from agent_steps, verbatim: the exporter never trims (`text` is
 *      a one-line gist it derives; `input`/`output`/`full` carry the whole
 *      content) and marks `truncated` only where the trace itself capped a
 *      step. A tool_use of a load-bearing tool (the Matcher's decision, the
 *      Steward's assessment, the Reviewer's and Arbitrator's rulings, …) is
 *      a "decision" step.
 *   3. Deltas. Exact first: a decision tool's input names the object (the
 *      matched claim id, the assessed claim, the merged pair), so the graph
 *      row it produced is credited to that run with attribution "exact".
 *      Then by window: every remaining graph row is credited to the run
 *      whose effective window contains its timestamp and whose agent is the
 *      row's natural author (Matcher/Extractor for top-level claims and
 *      their instances, Steward for subclaims, edges and assessments,
 *      Curator for curator rows), preferring a run on the same claim —
 *      attribution "run-window". Rows nobody claims go to a trailing
 *      "system" event. No row is credited twice.
 *   4. Causality: enqueue_events.source_run_id → causedBy; a run nested in
 *      another run's window (the Steward's match_claim spawns a Matcher) is
 *      caused by the enclosing run; steward enqueues become steward_notified
 *      deltas on the run that made them.
 *   5. Cost from llm_usage per run; duration from the run's timestamps.
 *
 * The "effective window" of a run runs from started_at to the LATER of its
 * finished_at and the next run of the same agent: the ingest worker writes
 * the claim and instance a Matcher decided on after the Matcher's run has
 * closed, and a Steward's subclaim lands after its nested Matcher returns.
 */
import { createHash } from "node:crypto";
import type {
  Replay,
  ReplayArm,
  ReplayClaim,
  ReplayDataFlow,
  ReplayDelta,
  ReplayEdge,
  ReplayEvent,
  ReplayFingerprint,
  ReplayPromptUse,
  ReplaySource,
  ReplayStep,
} from "./replay-types.js";

// ---------------------------------------------------------------------------
// Input rows (snake_case, as the tables spell them; timestamps as Date or ISO)
// ---------------------------------------------------------------------------

export type Stamp = string | Date;

export interface AgentRunRow {
  id: string;
  agent: string;
  claim_id: string | null;
  job_id?: string | null;
  started_at: Stamp;
  finished_at: Stamp | null;
  outcome: string | null;
  error?: string | null;
}

export interface AgentStepRow {
  run_id: string;
  seq: number;
  kind: string;
  content: unknown;
  created_at?: Stamp | null;
}

export interface EnqueueEventRow {
  id: string;
  queue: string;
  trigger: string | null;
  claim_id: string | null;
  contribution_id?: string | null;
  source_agent?: string | null;
  source_run_id: string | null;
  coalesced: boolean | null;
  created_at: Stamp;
}

/** llm_usage summed per run (run_id null = calls outside any traced run). */
export interface UsageRow {
  run_id: string | null;
  cost_micro_usd: number | string;
}

export interface ClaimRow {
  id: string;
  text: string;
  claim_type: string;
  created_by: string | null;
  created_at: Stamp;
  importance: number;
  steward_state: string;
  state?: string | null;
  merged_into?: string | null;
}

export interface EdgeRow {
  id: string;
  parent_claim_id: string;
  child_claim_id: string;
  relation_type: string;
  created_by?: string | null;
  created_at: Stamp;
  argument_id?: string | null;
}

export interface InstanceRow {
  id: string;
  claim_id: string;
  source_id: string;
  stance: string;
  verbatim_text?: string | null;
  proposed_canonical_form?: string | null;
  created_by?: string | null;
  created_at: Stamp;
}

export interface AssessmentRow {
  id: string;
  claim_id: string;
  status: string;
  confidence: number;
  claim_credence: number | null;
  summary?: string | null;
  trigger?: string | null;
  is_current: boolean;
  assessed_at: Stamp;
}

export interface SourceRow {
  id: string;
  url: string | null;
  title: string | null;
  retrieved_at: Stamp;
  words?: number | null;
}

export interface ContributionRow {
  id: string;
  claim_id: string | null;
  contribution_type: string;
  contributor_id: string;
  contributor_name?: string | null;
  submitted_at: Stamp;
  review_status?: string | null;
}

export interface ReviewRow {
  id: string;
  contribution_id: string;
  decision: string;
  confidence: number | null;
  suspected_bad_faith: boolean;
  reasoning: string | null;
  reviewed_at: Stamp;
}

export interface AppealRow {
  id: string;
  contribution_id: string;
  appellant_name?: string | null;
  submitted_at: Stamp;
}

export interface ArbitrationRow {
  id: string;
  contribution_id: string;
  appeal_id: string | null;
  outcome: string;
  reasoning: string | null;
  arbitrated_at: Stamp;
}

export interface ReplayArmMeta {
  key: string;
  label: string;
  variation: string | null;
  fingerprint: ReplayFingerprint;
  database?: string | null;
  capped?: boolean;
}

export interface ReplayArmInput {
  meta: ReplayArmMeta;
  /** Rows at or after this instant are the arm's; earlier graph rows are background (in `final`, no deltas). */
  since?: Stamp | null;
  until?: Stamp | null;
  runs: AgentRunRow[];
  steps: AgentStepRow[];
  enqueueEvents: EnqueueEventRow[];
  usage: UsageRow[];
  claims: ClaimRow[];
  edges: EdgeRow[];
  instances: InstanceRow[];
  assessments: AssessmentRow[];
  sources: SourceRow[];
  contributions?: ContributionRow[];
  reviews?: ReviewRow[];
  appeals?: AppealRow[];
  arbitrations?: ArbitrationRow[];
  /** Corpus post ids by source id or url, when the driver knows the manifest. */
  sourceKeys?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tool vocabulary
// ---------------------------------------------------------------------------

/** Tools whose call is the load-bearing submission of a run: shown as "decision" steps. */
export const DECISION_TOOLS: ReadonlySet<string> = new Set([
  // Matcher (src/llm/agents/matcher.ts) and the Matcher-as-a-tool.
  "submit_match_decision",
  "match_claim",
  // Steward (src/llm/tools/steward-tools.ts).
  "update_claim_assessment",
  "update_canonical_form",
  "add_decomposition_edge",
  "add_relationship_edge",
  "add_parent_claim",
  "record_claim_instance",
  "set_claim_importance",
  "notify_dependent_stewards",
  "escalate_to_curator",
  // Curator (src/llm/tools/curator-tools.ts).
  "merge_claims",
  // Reviewer (src/llm/tools/reviewer-tools.ts).
  "record_review_decision",
  "escalate_to_arbitrator",
  // Arbitrator (src/llm/tools/arbitrator-tools.ts).
  "record_arbitration_decision",
]);

/** The queue each agent is fed from, for causedBy. */
const QUEUE_OF_AGENT: Record<string, string> = {
  steward: "steward",
  curator: "curator",
  contribution_reviewer: "contribution",
  dispute_arbitrator: "arbitration",
};

/** Which agents naturally write a row with this created_by. */
function naturalAuthors(createdBy: string | null | undefined): string[] | null {
  switch (createdBy) {
    case "extractor":
      return ["matcher", "extractor"];
    case "claim_steward":
    case "decomposer":
    case "steward":
      return ["steward"];
    case "curator":
      return ["curator"];
    case "user":
      return ["contribution_reviewer", "dispute_arbitrator"];
    default:
      return null; // any agent
  }
}

// A run's post-processing (the ingest worker inserting what the Matcher
// decided) lands shortly after the run closes; when no later run of the same
// agent bounds it, this much slack does.
const POST_RUN_SLACK_MS = 60_000;
// A row may be stamped a hair before the run that wrote it opened its
// step (clock granularity between two statements); allow that much.
const PRE_RUN_SLACK_MS = 1_000;

const GIST_CHARS = 160;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function ms(x: Stamp | null | undefined): number {
  if (x === null || x === undefined) return Number.NaN;
  return x instanceof Date ? x.getTime() : new Date(x).getTime();
}

export function iso(x: Stamp | null | undefined): string | null {
  const t = ms(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One line for the timeline, never the record: whitespace-collapsed and cut with an ellipsis. */
export function gist(value: unknown, n = GIST_CHARS): string {
  const s = typeof value === "string" ? value : safeStringify(value);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function chars(value: unknown): number {
  return typeof value === "string" ? value.length : safeStringify(value).length;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function quote(text: string | null | undefined, n = 90): string {
  return `«${gist(text ?? "", n)}»`;
}

function words(s: string): string {
  return s.replace(/_/g, " ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The system prompt as one string, for hashing and sizing (string, or cached blocks joined). */
export function systemPromptText(system: unknown): string | null {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts = system.map((b) =>
      typeof b === "string" ? b : b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : safeStringify(b)
    );
    return parts.join("\n\n");
  }
  return null;
}

function isErrorOutput(output: unknown): boolean {
  if (typeof output !== "string") return false;
  if (/^\s*error\b/i.test(output)) return true;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if (parsed.success === false) return true;
      if (typeof parsed.error === "string") return true;
    }
  } catch {
    /* plain text */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  /** False when the following tool result refused it (an error, a rejected decision). */
  applied: boolean;
  stepSeq: number;
}

interface BuiltSteps {
  steps: ReplayStep[];
  decisions: ToolCall[];
  promptSystem: string | null;
  promptStepSeq: number | null;
}

/** agent_steps rows of one run → replay steps, verbatim, plus the decisions the run made. */
export function buildSteps(rows: AgentStepRow[]): BuiltSteps {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const steps: ReplayStep[] = [];
  const decisions: ToolCall[] = [];
  let promptSystem: string | null = null;
  let promptStepSeq: number | null = null;
  // Tool calls awaiting their results, to know whether a decision was applied.
  let pendingCalls: ToolCall[] = [];
  let seq = 0;
  const push = (s: Omit<ReplayStep, "seq">): ReplayStep => {
    const step = { seq: seq++, ...s };
    steps.push(step);
    return step;
  };

  for (const row of sorted) {
    const at = iso(row.created_at);
    const content = row.content as Record<string, unknown> | unknown[] | null;
    // The trace capped this step: what survives is a preview, and says so.
    if (content && !Array.isArray(content) && content.truncated === true) {
      push({
        kind: row.kind === "prompt" ? "prompt" : row.kind === "completion" ? "completion" : row.kind === "tool_results" ? "tool_result" : "thought",
        at,
        text: `(${row.kind} step capped by the trace at ${(content.originalChars as number | undefined)?.toLocaleString("en-US") ?? "?"} chars)`,
        full: content.preview,
        truncated: true,
      });
      continue;
    }
    switch (row.kind) {
      case "prompt": {
        const c = (content ?? {}) as Record<string, unknown>;
        const system = systemPromptText(c.system);
        const tools = Array.isArray(c.tools) ? c.tools : [];
        const step = push({
          kind: "prompt",
          at,
          text:
            `Prompt: ${String(c.model ?? "?")}` +
            (system ? `, system ${system.length.toLocaleString("en-US")} chars` : ", no system prompt") +
            (tools.length ? `, ${tools.length} tool(s)` : "") +
            (c.schemaName ? `, schema ${String(c.schemaName)}` : ""),
          full: content,
        });
        if (promptSystem === null) {
          promptSystem = system;
          promptStepSeq = step.seq;
        }
        break;
      }
      case "assistant": {
        const c = (content ?? {}) as Record<string, unknown>;
        const blocks = Array.isArray(c.content) ? (c.content as Array<Record<string, unknown>>) : [];
        pendingCalls = [];
        for (const block of blocks) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            if (!block.text.trim()) continue;
            push({ kind: "thought", at, text: gist(block.text), full: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            if (!block.thinking.trim()) continue;
            push({ kind: "thought", at, text: `(thinking) ${gist(block.thinking)}`, full: block.thinking });
          } else if (block.type === "tool_use" || block.type === "server_tool_use") {
            const tool = String(block.name ?? "?");
            const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
            const step = push({
              kind: DECISION_TOOLS.has(tool) ? "decision" : "tool_call",
              at,
              text: `${tool}(${gist(input, 120)})`,
              tool,
              input,
            });
            pendingCalls.push({ tool, input, applied: true, stepSeq: step.seq });
          }
        }
        if (blocks.length === 0 && c.stopReason) {
          push({ kind: "thought", at, text: `(empty turn, stop reason ${String(c.stopReason)})`, full: content });
        }
        break;
      }
      case "tool_results": {
        const entries = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
        for (const e of entries) {
          const tool = String(e.name ?? "?");
          const output = e.output;
          push({
            kind: "tool_result",
            at,
            text: `${tool} → ${gist(output)}`,
            tool,
            input: e.input,
            output,
          });
          // The first pending call of this name is the one this result answers.
          const idx = pendingCalls.findIndex((p) => p.tool === tool);
          if (idx >= 0) {
            const call = pendingCalls[idx]!;
            if (isErrorOutput(output)) call.applied = false;
            pendingCalls.splice(idx, 1);
            if (DECISION_TOOLS.has(call.tool)) decisions.push(call);
          }
        }
        break;
      }
      case "completion": {
        const c = (content ?? {}) as Record<string, unknown>;
        push({
          kind: "completion",
          at,
          text: gist(c.output),
          output: c.output,
          full: content,
        });
        break;
      }
      default:
        push({ kind: "thought", at, text: `(${row.kind})`, full: content });
    }
    // Calls with no result at all (a final tool the loop accepted, or the run
    // ending) are applied as far as the trace can tell.
    if (row.kind !== "assistant") {
      for (const call of pendingCalls) if (DECISION_TOOLS.has(call.tool)) decisions.push(call);
      pendingCalls = [];
    }
  }
  for (const call of pendingCalls) if (DECISION_TOOLS.has(call.tool)) decisions.push(call);
  decisions.sort((a, b) => a.stepSeq - b.stepSeq);
  return { steps, decisions, promptSystem, promptStepSeq };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

interface Ev {
  event: ReplayEvent;
  run: AgentRunRow | null;
  start: number;
  end: number;
  effEnd: number;
  decisions: ToolCall[];
  promptSystem: string | null;
  promptStepSeq: number | null;
  exact: number;
  window: number;
}

export function buildReplayArm(input: ReplayArmInput): ReplayArm {
  const since = input.since != null ? ms(input.since) : Number.NEGATIVE_INFINITY;
  const until = input.until != null ? ms(input.until) : Number.POSITIVE_INFINITY;
  const inWindow = (t: number) => t >= since && t <= until;

  const claimsById = new Map(input.claims.map((c) => [c.id, c]));
  const sourcesById = new Map(input.sources.map((s) => [s.id, s]));
  const contributionsById = new Map((input.contributions ?? []).map((c) => [c.id, c]));
  // The claim's text as it stood when an event happened: seeded from the
  // final rows, overwritten as creations and rewordings are emitted in order.
  const textNow = new Map<string, string>(input.claims.map((c) => [c.id, c.text]));
  const claimText = (id: string | null | undefined): string | null =>
    id ? (textNow.get(id) ?? null) : null;

  // Sources: the arm's are those submitted in the window, in ingest order.
  const armSources = input.sources
    .filter((s) => inWindow(ms(s.retrieved_at)))
    .sort((a, b) => ms(a.retrieved_at) - ms(b.retrieved_at));
  const armSourceIds = new Set(armSources.map((s) => s.id));
  const sources: ReplaySource[] = armSources.map((s, i) => ({
    id: s.id,
    key: input.sourceKeys?.[s.id] ?? (s.url ? (input.sourceKeys?.[s.url] ?? null) : null),
    title: s.title,
    url: s.url,
    order: i,
    ...(s.words != null ? { words: s.words } : {}),
  }));

  // Instances by claim, for topLevel and sourceIds.
  const instancesByClaim = new Map<string, InstanceRow[]>();
  for (const inst of input.instances) {
    (instancesByClaim.get(inst.claim_id) ?? instancesByClaim.set(inst.claim_id, []).get(inst.claim_id)!).push(inst);
  }
  const isTopLevel = (claimId: string) =>
    (instancesByClaim.get(claimId) ?? []).some((i) => armSourceIds.has(i.source_id));

  // ---- 1. Events -----------------------------------------------------------
  const evs: Ev[] = [];
  const stepsByRun = new Map<string, AgentStepRow[]>();
  for (const s of input.steps) {
    (stepsByRun.get(s.run_id) ?? stepsByRun.set(s.run_id, []).get(s.run_id)!).push(s);
  }
  const costByRun = new Map<string, number>();
  let armCost = 0;
  for (const u of input.usage) {
    const c = Number(u.cost_micro_usd) || 0;
    armCost += c;
    if (u.run_id) costByRun.set(u.run_id, (costByRun.get(u.run_id) ?? 0) + c);
  }

  const runs = input.runs
    .filter((r) => inWindow(ms(r.started_at)))
    .sort((a, b) => ms(a.started_at) - ms(b.started_at));
  const lastStamp = Math.max(
    ...runs.map((r) => (Number.isFinite(ms(r.finished_at)) ? ms(r.finished_at) : ms(r.started_at))),
    Number.NEGATIVE_INFINITY
  );
  for (const run of runs) {
    const start = ms(run.started_at);
    const end = Number.isFinite(ms(run.finished_at)) ? ms(run.finished_at) : start;
    const nextSame = runs
      .filter((r) => r.agent === run.agent && ms(r.started_at) > start)
      .map((r) => ms(r.started_at))
      .sort((a, b) => a - b)[0];
    const effEnd = nextSame !== undefined && nextSame > end ? nextSame : end + POST_RUN_SLACK_MS;
    const built = buildSteps(stepsByRun.get(run.id) ?? []);
    evs.push({
      event: {
        seq: 0,
        at: new Date(start).toISOString(),
        endedAt: iso(run.finished_at),
        agent: run.agent,
        runId: run.id,
        claimId: run.claim_id,
        claimText: claimText(run.claim_id),
        sourceId: null,
        trigger: null,
        causedBy: null,
        title: `${capitalize(run.agent)} run`,
        outcome: run.outcome === "ok" || run.outcome === "error" ? run.outcome : "running",
        ...(run.error ? { error: run.error } : {}),
        steps: built.steps,
        deltas: [],
        costMicroUsd: costByRun.get(run.id) ?? null,
        durationMs: Number.isFinite(ms(run.finished_at)) ? Math.max(0, end - start) : null,
        attribution: "run-window",
      },
      run,
      start,
      end,
      effEnd,
      decisions: built.decisions,
      promptSystem: built.promptSystem,
      promptStepSeq: built.promptStepSeq,
      exact: 0,
      window: 0,
    });
  }
  const harness = (at: number, agent: string, title: string, extra: Partial<ReplayEvent> = {}): Ev => {
    const ev: Ev = {
      event: {
        seq: 0,
        at: new Date(at).toISOString(),
        endedAt: null,
        agent,
        runId: null,
        claimId: null,
        sourceId: null,
        trigger: null,
        causedBy: null,
        title,
        outcome: null,
        steps: [],
        deltas: [],
        costMicroUsd: null,
        durationMs: null,
        attribution: "harness",
        ...extra,
      },
      run: null,
      start: at,
      end: at,
      effEnd: at,
      decisions: [],
      promptSystem: null,
      promptStepSeq: null,
      exact: 0,
      window: 0,
    };
    evs.push(ev);
    return ev;
  };
  for (const s of armSources) {
    const ev = harness(ms(s.retrieved_at), "system", `Source submitted: ${quote(s.title)}`, { sourceId: s.id });
    ev.event.deltas.push({ op: "source_submitted", sourceId: s.id, title: s.title, url: s.url });
  }
  const contributorName = (c: ContributionRow | undefined): string =>
    c?.contributor_name ?? (c ? `contributor ${c.contributor_id.slice(0, 8)}` : "contributor");
  for (const c of (input.contributions ?? []).filter((c) => inWindow(ms(c.submitted_at)))) {
    const ev = harness(
      ms(c.submitted_at),
      "persona",
      `${contributorName(c)} submits ${words(c.contribution_type)}` + (c.claim_id ? ` on ${quote(claimText(c.claim_id))}` : ""),
      { claimId: c.claim_id, claimText: claimText(c.claim_id) }
    );
    ev.event.deltas.push({
      op: "contribution_submitted",
      contributionId: c.id,
      claimId: c.claim_id,
      type: c.contribution_type,
      contributor: contributorName(c),
    });
  }
  for (const a of (input.appeals ?? []).filter((a) => inWindow(ms(a.submitted_at)))) {
    const c = contributionsById.get(a.contribution_id);
    const ev = harness(
      ms(a.submitted_at),
      "persona",
      `${a.appellant_name ?? contributorName(c)} appeals the decision on ${words(c?.contribution_type ?? "contribution")}`,
      { claimId: c?.claim_id ?? null, claimText: claimText(c?.claim_id) }
    );
    ev.event.deltas.push({ op: "appeal_filed", contributionId: a.contribution_id, appealId: a.id });
  }

  // Order: by time; a harness event before a run at the same instant.
  evs.sort((a, b) => a.start - b.start || (a.run ? 1 : 0) - (b.run ? 1 : 0));
  evs.forEach((e, i) => (e.event.seq = i));
  const byRunId = new Map<string, Ev>();
  for (const e of evs) if (e.run) byRunId.set(e.run.id, e);

  // ---- 2. Deltas -----------------------------------------------------------
  const consumed = new Set<string>(); // "<table>:<id>"
  const take = (table: string, id: string): boolean => {
    const k = `${table}:${id}`;
    if (consumed.has(k)) return false;
    consumed.add(k);
    return true;
  };
  const isFree = (table: string, id: string) => !consumed.has(`${table}:${id}`);
  const within = (ev: Ev, t: number) => t >= ev.start - PRE_RUN_SLACK_MS && t <= ev.effEnd;
  const emit = (ev: Ev, delta: ReplayDelta, how: "exact" | "window") => {
    ev.event.deltas.push(delta);
    if (how === "exact") ev.exact++;
    else ev.window++;
    if (delta.op === "claim_created") textNow.set(delta.claimId, delta.text);
    if (delta.op === "canonical_form_updated") textNow.set(delta.claimId, delta.after);
  };
  const claimCreated = (c: ClaimRow, sourceId?: string | null): ReplayDelta => ({
    op: "claim_created",
    claimId: c.id,
    text: c.text,
    createdBy: c.created_by,
    topLevel: isTopLevel(c.id),
    sourceId: sourceId ?? (instancesByClaim.get(c.id) ?? []).find((i) => armSourceIds.has(i.source_id))?.source_id ?? null,
  });
  const assessmentDelta = (a: AssessmentRow): ReplayDelta => ({
    op: "assessment_recorded",
    claimId: a.claim_id,
    status: a.status,
    credence: a.claim_credence,
    confidence: a.confidence,
    trigger: a.trigger ?? null,
    summary: a.summary ?? null,
  });
  const edgeDelta = (e: EdgeRow): ReplayDelta => ({
    op: "edge_added",
    edgeId: e.id,
    parentId: e.parent_claim_id,
    childId: e.child_claim_id,
    relation: e.relation_type,
    argumentId: e.argument_id ?? null,
  });
  const reviewDelta = (r: ReviewRow): ReplayDelta => ({
    op: "review_decided",
    contributionId: r.contribution_id,
    decision: r.decision,
    confidence: r.confidence,
    badFaith: r.suspected_bad_faith,
    reasoning: r.reasoning ?? null,
  });
  const arbitrationDelta = (r: ArbitrationRow): ReplayDelta => ({
    op: "arbitration_decided",
    contributionId: r.contribution_id,
    outcome: r.outcome,
    reasoning: r.reasoning ?? null,
  });

  // Row lookups, each restricted to unconsumed rows inside the run's window.
  const freeClaims = (ev: Ev, pred: (c: ClaimRow) => boolean) =>
    input.claims
      .filter((c) => isFree("claim", c.id) && within(ev, ms(c.created_at)) && inWindow(ms(c.created_at)) && pred(c))
      .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const freeInstances = (ev: Ev, pred: (i: InstanceRow) => boolean) =>
    input.instances
      .filter((i) => isFree("instance", i.id) && within(ev, ms(i.created_at)) && inWindow(ms(i.created_at)) && pred(i))
      .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const freeEdges = (ev: Ev, pred: (e: EdgeRow) => boolean) =>
    input.edges
      .filter((e) => isFree("edge", e.id) && within(ev, ms(e.created_at)) && inWindow(ms(e.created_at)) && pred(e))
      .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const freeAssessments = (ev: Ev, pred: (a: AssessmentRow) => boolean) =>
    input.assessments
      .filter((a) => isFree("assessment", a.id) && within(ev, ms(a.assessed_at)) && inWindow(ms(a.assessed_at)) && pred(a))
      .sort((a, b) => ms(a.assessed_at) - ms(b.assessed_at));

  // 2a. Exact: the decision names the object.
  for (const ev of evs) {
    if (!ev.run) continue;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    // The Matcher's accepted decision is its last applied one.
    const matchDecision = [...ev.decisions].reverse().find((d) => d.tool === "submit_match_decision" && d.applied);
    for (const d of ev.decisions) {
      if (!d.applied) continue;
      const inp = d.input;
      switch (d.tool) {
        case "submit_match_decision": {
          if (d !== matchDecision) break;
          const stance = str(inp.instance_stance) ?? "affirms";
          if (inp.is_match === true && str(inp.matched_claim_id)) {
            const claimId = str(inp.matched_claim_id)!;
            const inst = freeInstances(ev, (i) => i.claim_id === claimId && (i.created_by ?? "extractor") === "extractor")[0];
            if (inst) take("instance", inst.id);
            emit(
              ev,
              {
                op: "claim_matched",
                claimId,
                sourceId: inst?.source_id ?? null,
                stance: inst?.stance ?? stance,
                verbatim: inst?.verbatim_text ?? null,
                proposed: inst?.proposed_canonical_form ?? null,
              },
              "exact"
            );
          } else if (inp.is_match === false) {
            const text = str(inp.new_canonical_form);
            let claim = text ? freeClaims(ev, (c) => norm(c.text) === norm(text) && (c.created_by ?? "extractor") === "extractor")[0] : undefined;
            if (!claim) {
              // No rewording: the claim carries the Extractor's proposal, which
              // the instance written next to it records.
              const inst = freeInstances(ev, (i) => (i.created_by ?? "extractor") === "extractor")[0];
              const viaInstance = inst ? claimsById.get(inst.claim_id) : undefined;
              if (viaInstance && isFree("claim", viaInstance.id) && within(ev, ms(viaInstance.created_at)) && viaInstance.created_by === "extractor") {
                claim = viaInstance;
              }
            }
            if (claim) {
              take("claim", claim.id);
              const inst = freeInstances(ev, (i) => i.claim_id === claim!.id)[0];
              if (inst) take("instance", inst.id);
              emit(ev, claimCreated(claim, inst?.source_id ?? null), "exact");
            }
            // A nested Matcher (the Steward's match_claim) decides "new" and the
            // Steward mints the subclaim itself: that creation is the Steward's.
          }
          break;
        }
        case "update_claim_assessment": {
          const claimId = str(inp.claim_id);
          if (!claimId) break;
          const row = freeAssessments(ev, (a) => a.claim_id === claimId)[0];
          if (row) {
            take("assessment", row.id);
            emit(ev, assessmentDelta(row), "exact");
          } else {
            emit(
              ev,
              {
                op: "assessment_recorded",
                claimId,
                status: str(inp.status) ?? "?",
                credence: typeof inp.claim_credence === "number" ? inp.claim_credence : null,
                confidence: typeof inp.confidence === "number" ? inp.confidence : 0,
                trigger: null,
                summary: str(inp.assessment),
              },
              "exact"
            );
          }
          break;
        }
        case "add_decomposition_edge": {
          const parentId = str(inp.parent_id);
          const childText = str(inp.child_text);
          if (!parentId) break;
          let child = childText ? freeClaims(ev, (c) => norm(c.text) === norm(childText))[0] : undefined;
          let edge: EdgeRow | undefined;
          if (child) {
            edge = freeEdges(ev, (e) => e.parent_claim_id === parentId && e.child_claim_id === child!.id)[0];
          } else {
            edge = freeEdges(ev, (e) => e.parent_claim_id === parentId && isFree("claim", e.child_claim_id))[0];
            const c = edge ? claimsById.get(edge.child_claim_id) : undefined;
            if (c && within(ev, ms(c.created_at))) child = c;
          }
          if (child) {
            take("claim", child.id);
            emit(ev, claimCreated(child), "exact");
          }
          if (edge) {
            take("edge", edge.id);
            emit(ev, edgeDelta(edge), "exact");
          }
          break;
        }
        case "add_parent_claim": {
          const childId = str(inp.claim_id);
          const parentText = str(inp.parent_text);
          const parent = parentText ? freeClaims(ev, (c) => norm(c.text) === norm(parentText))[0] : undefined;
          if (parent) {
            take("claim", parent.id);
            emit(ev, claimCreated(parent), "exact");
            const edge = freeEdges(ev, (e) => e.parent_claim_id === parent.id && e.child_claim_id === childId)[0];
            if (edge) {
              take("edge", edge.id);
              emit(ev, edgeDelta(edge), "exact");
            }
          }
          break;
        }
        case "add_relationship_edge": {
          const parentId = str(inp.parent_id);
          const childId = str(inp.child_id);
          const edge = freeEdges(ev, (e) => e.parent_claim_id === parentId && e.child_claim_id === childId)[0];
          if (edge) {
            take("edge", edge.id);
            emit(ev, edgeDelta(edge), "exact");
          }
          break;
        }
        case "record_claim_instance": {
          const claimId = str(inp.claim_id);
          const inst = freeInstances(ev, (i) => i.claim_id === claimId)[0];
          if (inst) {
            take("instance", inst.id);
            emit(ev, { op: "instance_added", claimId: inst.claim_id, sourceId: inst.source_id, stance: inst.stance }, "exact");
          }
          break;
        }
        case "update_canonical_form": {
          const claimId = str(inp.claim_id);
          const after = str(inp.new_text);
          if (claimId && after) {
            emit(ev, { op: "canonical_form_updated", claimId, before: textNow.get(claimId) ?? "", after }, "exact");
          }
          break;
        }
        case "set_claim_importance": {
          const claimId = str(inp.claim_id);
          if (claimId && typeof inp.importance === "number") {
            emit(ev, { op: "importance_set", claimId, importance: inp.importance }, "exact");
          }
          break;
        }
        case "merge_claims": {
          const loser = str(inp.loser_id);
          const survivor = str(inp.survivor_id);
          if (loser && survivor) emit(ev, { op: "claim_merged", claimId: loser, into: survivor }, "exact");
          break;
        }
        case "escalate_to_curator":
          emit(ev, { op: "note", text: `Escalated to the Curator: ${str(inp.concern) ?? ""}`.trim() }, "exact");
          break;
        case "escalate_to_arbitrator":
          emit(ev, { op: "note", text: `Escalated to the Arbitrator: ${str(inp.reason) ?? str(inp.reasoning) ?? ""}`.trim() }, "exact");
          break;
        case "record_review_decision": {
          const contributionId = str(inp.contribution_id);
          if (!contributionId) break;
          const row = (input.reviews ?? [])
            .filter((r) => isFree("review", r.id) && r.contribution_id === contributionId && within(ev, ms(r.reviewed_at)))
            .sort((a, b) => ms(a.reviewed_at) - ms(b.reviewed_at))[0];
          if (row) {
            take("review", row.id);
            emit(ev, reviewDelta(row), "exact");
          } else {
            emit(
              ev,
              {
                op: "review_decided",
                contributionId,
                decision: str(inp.decision) ?? "?",
                confidence: typeof inp.confidence === "number" ? inp.confidence : null,
                badFaith: inp.suspected_bad_faith === true,
                reasoning: str(inp.reasoning),
              },
              "exact"
            );
          }
          break;
        }
        case "record_arbitration_decision": {
          const contributionId = str(inp.contribution_id);
          if (!contributionId) break;
          const row = (input.arbitrations ?? [])
            .filter((r) => isFree("arbitration", r.id) && r.contribution_id === contributionId && within(ev, ms(r.arbitrated_at)))
            .sort((a, b) => ms(a.arbitrated_at) - ms(b.arbitrated_at))[0];
          if (row) {
            take("arbitration", row.id);
            emit(ev, arbitrationDelta(row), "exact");
          } else {
            emit(ev, { op: "arbitration_decided", contributionId, outcome: str(inp.outcome) ?? "?", reasoning: str(inp.reasoning) }, "exact");
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // 2b. By window: the run whose effective window contains the row and whose
  // agent is the natural author, preferring a run on the same claim, latest
  // start wins.
  const runEvs = evs.filter((e) => e.run);
  const credit = (t: number, agents: string[] | null, prefer?: (ev: Ev) => boolean): Ev | null => {
    let cands = runEvs.filter((e) => within(e, t) && (agents === null || agents.includes(e.run!.agent)));
    if (prefer) {
      const preferred = cands.filter(prefer);
      if (preferred.length) cands = preferred;
    }
    if (!cands.length) return null;
    return cands.reduce((best, e) => (e.start > best.start ? e : best));
  };
  const orphans: ReplayDelta[] = [];
  const windowDeltas: Array<{ ev: Ev; t: number; delta: ReplayDelta }> = [];
  const parentOf = new Map<string, Set<string>>();
  for (const e of input.edges) {
    (parentOf.get(e.child_claim_id) ?? parentOf.set(e.child_claim_id, new Set()).get(e.child_claim_id)!).add(e.parent_claim_id);
  }

  for (const c of input.claims) {
    const t = ms(c.created_at);
    if (!isFree("claim", c.id) || !inWindow(t)) continue;
    take("claim", c.id);
    const ev = credit(t, naturalAuthors(c.created_by), (e) => e.run!.claim_id !== null && (parentOf.get(c.id)?.has(e.run!.claim_id) ?? false));
    if (!ev) {
      orphans.push(claimCreated(c));
      continue;
    }
    // The ingest instance written next to a top-level claim rides with it.
    const inst = freeInstances(ev, (i) => i.claim_id === c.id && (i.created_by ?? "extractor") === "extractor")[0];
    if (inst) take("instance", inst.id);
    windowDeltas.push({ ev, t, delta: claimCreated(c, inst?.source_id ?? null) });
  }
  for (const i of input.instances) {
    const t = ms(i.created_at);
    if (!isFree("instance", i.id) || !inWindow(t)) continue;
    take("instance", i.id);
    const ev = credit(t, naturalAuthors(i.created_by ?? "extractor"), (e) => e.run!.claim_id === i.claim_id);
    const delta: ReplayDelta = { op: "instance_added", claimId: i.claim_id, sourceId: i.source_id, stance: i.stance };
    if (ev) windowDeltas.push({ ev, t, delta });
    else orphans.push(delta);
  }
  for (const e of input.edges) {
    const t = ms(e.created_at);
    if (!isFree("edge", e.id) || !inWindow(t)) continue;
    take("edge", e.id);
    const ev = credit(t, naturalAuthors(e.created_by ?? "decomposer"), (x) => x.run!.claim_id === e.parent_claim_id || x.run!.claim_id === e.child_claim_id);
    if (ev) windowDeltas.push({ ev, t, delta: edgeDelta(e) });
    else orphans.push(edgeDelta(e));
  }
  for (const a of input.assessments) {
    const t = ms(a.assessed_at);
    if (!isFree("assessment", a.id) || !inWindow(t)) continue;
    take("assessment", a.id);
    const ev = credit(t, ["steward"], (x) => x.run!.claim_id === a.claim_id);
    if (ev) windowDeltas.push({ ev, t, delta: assessmentDelta(a) });
    else orphans.push(assessmentDelta(a));
  }
  for (const r of input.reviews ?? []) {
    const t = ms(r.reviewed_at);
    if (!isFree("review", r.id) || !inWindow(t)) continue;
    take("review", r.id);
    const claimId = contributionsById.get(r.contribution_id)?.claim_id ?? null;
    const ev = credit(t, ["contribution_reviewer"], (x) => claimId !== null && x.run!.claim_id === claimId);
    if (ev) windowDeltas.push({ ev, t, delta: reviewDelta(r) });
    else orphans.push(reviewDelta(r));
  }
  for (const r of input.arbitrations ?? []) {
    const t = ms(r.arbitrated_at);
    if (!isFree("arbitration", r.id) || !inWindow(t)) continue;
    take("arbitration", r.id);
    const claimId = contributionsById.get(r.contribution_id)?.claim_id ?? null;
    const ev = credit(t, ["dispute_arbitrator"], (x) => claimId !== null && x.run!.claim_id === claimId);
    if (ev) windowDeltas.push({ ev, t, delta: arbitrationDelta(r) });
    else orphans.push(arbitrationDelta(r));
  }
  windowDeltas.sort((a, b) => a.t - b.t);
  for (const { ev, delta } of windowDeltas) emit(ev, delta, "window");

  // ---- 3. Causality: enqueue events ---------------------------------------
  const enqueues = input.enqueueEvents
    .filter((e) => inWindow(ms(e.created_at)))
    .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const creatorOf = new Map<string, Ev>();
  for (const ev of evs) {
    for (const d of ev.event.deltas) if (d.op === "claim_created") creatorOf.set(d.claimId, ev);
  }
  for (const q of enqueues) {
    if (q.queue !== "steward" || !q.claim_id) continue;
    const delta: ReplayDelta = { op: "steward_notified", claimId: q.claim_id, trigger: q.trigger ?? "?", coalesced: q.coalesced };
    const target = (q.source_run_id && byRunId.get(q.source_run_id)) || creatorOf.get(q.claim_id) || null;
    if (target) target.event.deltas.push(delta);
    else orphans.push(delta);
  }
  // Each queued run is caused by the enqueue that created its slot (the
  // earliest unconsumed one on its queue and claim before it started); the
  // later ones before it started were coalesced into the same run.
  const consumedEnqueue = new Set<string>();
  for (const ev of evs) {
    if (!ev.run) continue;
    const queue = QUEUE_OF_AGENT[ev.run.agent];
    if (!queue) continue;
    const mine = enqueues.filter(
      (q) =>
        q.queue === queue &&
        !consumedEnqueue.has(q.id) &&
        ms(q.created_at) <= ev.start + PRE_RUN_SLACK_MS &&
        (queue === "steward" || queue === "curator" ? q.claim_id === ev.run!.claim_id : true)
    );
    if (!mine.length) continue;
    for (const q of mine) consumedEnqueue.add(q.id);
    const first = mine[0]!;
    ev.event.trigger =
      mine.find((q) => q.trigger === "structure_and_assess")?.trigger ?? first.trigger ?? null;
    const source = mine.map((q) => (q.source_run_id ? byRunId.get(q.source_run_id) : undefined)).find((x) => x && x !== ev);
    if (source) ev.event.causedBy = source.event.seq;
  }
  // A run inside another agent's run (the Steward's match_claim spawns a
  // Matcher) was caused by the enclosing run; a run on a claim that an
  // earlier event created (the claim pipeline queues the Steward outside
  // any agent run, so the enqueue names no source) was caused by that.
  for (const ev of evs) {
    if (!ev.run || ev.event.causedBy !== null) continue;
    const enclosing = runEvs
      .filter((o) => o !== ev && o.run!.agent !== ev.run!.agent && o.start <= ev.start && ev.end <= o.end)
      .sort((a, b) => b.start - a.start)[0];
    if (enclosing) {
      ev.event.causedBy = enclosing.event.seq;
      continue;
    }
    const creator = ev.run.claim_id ? creatorOf.get(ev.run.claim_id) : undefined;
    if (creator && creator !== ev && creator.event.seq < ev.event.seq) ev.event.causedBy = creator.event.seq;
  }

  // ---- 4. Titles, sources, attribution ------------------------------------
  const latestSourceBefore = (t: number): SourceRow | undefined =>
    armSources.filter((s) => ms(s.retrieved_at) <= t).at(-1);
  for (const ev of evs) {
    if (!ev.run) continue;
    const e = ev.event;
    const run = ev.run;
    const nested = e.causedBy !== null && evs[e.causedBy]?.run?.agent !== undefined && evs[e.causedBy]!.run!.agent !== run.agent && run.agent === "matcher";
    const firstOf = <T extends ReplayDelta["op"]>(op: T) => e.deltas.find((d) => d.op === op) as Extract<ReplayDelta, { op: T }> | undefined;
    switch (run.agent) {
      case "extractor": {
        const s = latestSourceBefore(ev.start);
        e.sourceId = s?.id ?? null;
        e.title = s ? `Extractor reads ${quote(s.title)}` : "Extractor reads a source";
        break;
      }
      case "matcher": {
        const created = firstOf("claim_created");
        const matched = firstOf("claim_matched");
        const decision = [...ev.decisions].reverse().find((d) => d.tool === "submit_match_decision" && d.applied);
        e.sourceId = created?.sourceId ?? matched?.sourceId ?? (nested ? null : (latestSourceBefore(ev.start)?.id ?? null));
        if (matched) {
          e.claimId = matched.claimId;
          e.claimText = claimText(matched.claimId);
          e.title = `Matcher decides: matches ${quote(e.claimText)}` + (matched.stance !== "affirms" ? ` (${matched.stance})` : "");
        } else if (created) {
          e.claimId = created.claimId;
          e.claimText = created.text;
          e.title = `Matcher decides: new claim ${quote(created.text)}`;
        } else if (decision && decision.input.is_match === false) {
          e.claimText = typeof decision.input.new_canonical_form === "string" ? decision.input.new_canonical_form : null;
          e.title = `Matcher decides: new claim ${quote(e.claimText)}`;
        } else if (decision && decision.input.is_match === true) {
          e.claimId = typeof decision.input.matched_claim_id === "string" ? decision.input.matched_claim_id : null;
          e.claimText = claimText(e.claimId);
          e.title = `Matcher decides: matches ${quote(e.claimText)}`;
        } else {
          e.title = "Matcher: no decision recorded";
        }
        break;
      }
      case "steward": {
        const text = quote(e.claimText ?? claimText(run.claim_id));
        e.title =
          e.trigger === "structure_and_assess" || e.trigger === null
            ? `Steward: structure and assess ${text}`
            : `Steward: re-assess ${text} (${words(e.trigger)})`;
        break;
      }
      case "curator":
        e.title = `Curator: ${e.trigger ? words(e.trigger) : "review"}` + (run.claim_id ? ` on ${quote(claimText(run.claim_id))}` : "");
        break;
      case "contribution_reviewer": {
        const r = firstOf("review_decided");
        const c = r ? contributionsById.get(r.contributionId) : undefined;
        if (c && !e.claimId) {
          e.claimId = c.claim_id;
          e.claimText = claimText(c.claim_id);
        }
        e.title = r
          ? `Reviewer: ${words(c?.contribution_type ?? "contribution")} by ${contributorName(c)} → ${r.decision}` + (r.badFaith ? " (bad faith)" : "")
          : "Reviewer: review";
        break;
      }
      case "dispute_arbitrator": {
        const r = firstOf("arbitration_decided");
        const c = r ? contributionsById.get(r.contributionId) : undefined;
        if (c && !e.claimId) {
          e.claimId = c.claim_id;
          e.claimText = claimText(c.claim_id);
        }
        e.title = r
          ? `Arbitrator: ${words(c?.contribution_type ?? "contribution")} by ${contributorName(c)} → ${words(r.outcome)}`
          : "Arbitrator: arbitration";
        break;
      }
      default:
        e.title = `${capitalize(words(run.agent))} run` + (run.claim_id ? ` on ${quote(claimText(run.claim_id))}` : "");
    }
    e.attribution = ev.window > 0 ? "run-window" : "exact";
  }

  if (orphans.length) {
    const at = Number.isFinite(lastStamp) ? lastStamp : (evs.at(-1)?.start ?? (Number.isFinite(since) ? since : Date.now()));
    const ev = harness(at + 1, "system", `Graph rows no agent run accounts for (${orphans.length})`);
    ev.event.deltas.push(...orphans);
    evs.forEach((e, i) => (e.event.seq = i));
  }

  // ---- 5. Data flow and prompts ------------------------------------------
  for (const ev of evs) {
    ev.event.dataFlow = dataFlowOf(ev.event, claimsById, sourcesById);
  }
  const prompts = new Map<string, ReplayPromptUse>();
  for (const ev of evs) {
    if (ev.promptSystem === null || ev.promptStepSeq === null) continue;
    const sha256 = createHash("sha256").update(ev.promptSystem).digest("hex");
    const use = prompts.get(sha256);
    if (use) {
      use.count++;
      if (!use.agents.includes(ev.event.agent)) use.agents.push(ev.event.agent);
    } else {
      prompts.set(sha256, {
        sha256,
        chars: ev.promptSystem.length,
        agents: [ev.event.agent],
        count: 1,
        firstEventSeq: ev.event.seq,
        firstStepSeq: ev.promptStepSeq,
      });
    }
  }

  // ---- 6. Final graph ------------------------------------------------------
  const current = new Map<string, AssessmentRow>();
  for (const a of input.assessments) if (a.is_current) current.set(a.claim_id, a);
  const activeClaims = input.claims.filter((c) => (c.state ?? "active") === "active");
  const activeIds = new Set(activeClaims.map((c) => c.id));
  const finalClaims: ReplayClaim[] = activeClaims.map((c) => {
    const a = current.get(c.id);
    return {
      id: c.id,
      text: c.text,
      claimType: c.claim_type,
      createdBy: c.created_by,
      createdAt: iso(c.created_at) ?? "",
      importance: c.importance,
      stewardState: c.steward_state,
      status: a?.status ?? null,
      credence: a?.claim_credence ?? null,
      confidence: a?.confidence ?? null,
      topLevel: isTopLevel(c.id),
      sourceIds: [...new Set((instancesByClaim.get(c.id) ?? []).map((i) => i.source_id))],
    };
  });
  const finalEdges: ReplayEdge[] = input.edges
    .filter((e) => activeIds.has(e.parent_claim_id) && activeIds.has(e.child_claim_id))
    .map((e) => ({
      id: e.id,
      parentId: e.parent_claim_id,
      childId: e.child_claim_id,
      relation: e.relation_type,
      argumentId: e.argument_id ?? null,
      createdAt: iso(e.created_at) ?? "",
    }));

  return {
    key: input.meta.key,
    label: input.meta.label,
    variation: input.meta.variation,
    fingerprint: input.meta.fingerprint,
    sources,
    events: evs.map((e) => e.event),
    final: { claims: finalClaims, edges: finalEdges },
    costMicroUsd: input.usage.length ? Math.round(armCost) : null,
    capped: input.meta.capped ?? false,
    database: input.meta.database ?? null,
    promptsUsed: [...prompts.values()],
  };
}

/** What an event read (ids its tool results mention) and wrote (its deltas, by id). */
export function dataFlowOf(
  event: ReplayEvent,
  claims: ReadonlyMap<string, unknown>,
  sources: ReadonlyMap<string, unknown>
): ReplayDataFlow {
  const reads: ReplayDataFlow["reads"] = [];
  for (const s of event.steps) {
    if (s.kind !== "tool_result") continue;
    const text = typeof s.output === "string" ? s.output : safeStringify(s.output ?? "");
    const claimIds = new Set<string>();
    const sourceIds = new Set<string>();
    for (const id of text.match(UUID_RE) ?? []) {
      const lower = id.toLowerCase();
      if (claims.has(lower)) claimIds.add(lower);
      else if (sources.has(lower)) sourceIds.add(lower);
    }
    reads.push({ tool: s.tool ?? "?", claimIds: [...claimIds], sourceIds: [...sourceIds] });
  }
  const writes: ReplayDataFlow["writes"] = event.deltas.map((d) => {
    const w: ReplayDataFlow["writes"][number] = { op: d.op };
    if ("claimId" in d && d.claimId) w.claimId = d.claimId;
    if ("sourceId" in d && d.sourceId) w.sourceId = d.sourceId;
    if ("contributionId" in d && d.contributionId) w.contributionId = d.contributionId;
    return w;
  });
  return { reads, writes };
}

// ---------------------------------------------------------------------------
// The two layouts
// ---------------------------------------------------------------------------

export interface ReplayLayouts {
  /** replay.json: everything but the verbatim step content, which `sizes` and `detailPath` point to. */
  index: Replay;
  /** replay-events/<arm>/<seq>.json: the full events. */
  details: Array<{ path: string; event: ReplayEvent }>;
}

/**
 * Split a replay into its index and its per-event detail files. The index
 * keeps every event, delta, matching and final graph and each step's gist;
 * the verbatim `input` / `output` / `full` of every step move to the
 * event's detail file, which `detailPath` names relative to the
 * replay-events directory ("a/12.json").
 */
export function splitReplay(replay: Replay): ReplayLayouts {
  const details: ReplayLayouts["details"] = [];
  const arms = replay.arms.map((arm) => ({
    ...arm,
    events: arm.events.map((event) => {
      const path = `${arm.key}/${event.seq}.json`;
      details.push({ path, event });
      return {
        ...event,
        detailPath: path,
        steps: event.steps.map((s) => {
          const { input, output, full, ...rest } = s;
          const sizes: NonNullable<ReplayStep["sizes"]> = {};
          if (input !== undefined) sizes.input = chars(input);
          if (output !== undefined) sizes.output = chars(output);
          if (full !== undefined) sizes.full = chars(full);
          return { ...rest, sizes };
        }),
      };
    }),
  }));
  return { index: { ...replay, arms }, details };
}
