/**
 * The replay: a recording of one eval episode that a person can play back
 * (#334, the evals page's "show me" half). Every driver that runs the real
 * agents — corpus:run, corpus:property, corpus:swap, corpus:contributions,
 * corpus:adversarial — emits one, built after the drain from the trace
 * substrate (agent_runs / agent_steps / enqueue_events / llm_usage) and the
 * graph tables, so what is shown is what the agents did, step by step, not a
 * narration of it. The web player (web/lib/replay.ts mirrors these types)
 * renders the events in order and rebuilds the graph as they land.
 *
 * Design rules:
 *   - Everything in a replay is DERIVED from records the run wrote; nothing
 *     is authored by hand. Where attribution is a heuristic (a graph delta
 *     is credited to the agent run whose window contains it and whose claim
 *     it touches), the field says so (`attribution`).
 *   - Steps are trimmed for the reader (tool inputs and outputs cut to a few
 *     hundred characters) but never paraphrased; `truncated` marks a cut.
 *   - A two-arm episode carries both arms and the matching between them,
 *     so the player can show the same source landing in two graphs side by
 *     side and link the claims the agreement metric paired.
 *   - The schema is versioned; the player refuses a version it does not know.
 */

export const REPLAY_VERSION = 1 as const;

export type ReplayKind =
  | "ingest"        // one corpus run: sources → graph
  | "property"      // two arms of one cluster (idempotency, path-independence, dup-flood, …)
  | "swap"          // two arms, one agent's model changed
  | "contributions" // a contribution scenario against a drained graph
  | "adversarial"   // attack arms + benign control against one snapshot
  | "personas"      // simulated users against a drained graph (S8)
  | "redteam";      // the adaptive attacker's episodes (S4 cell 2)

/** The agent vocabulary, same as llm_usage.agent / agent_runs.agent. */
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
  | "grantmaker"
  | "judge"
  | "redteam"      // the adversarial attacker (S4 cell 2)
  | "persona"      // a simulated contributor (S8)
  | "system"       // intake, queue plumbing, the harness itself
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
  id: string;             // sources.id
  key: string | null;     // corpus post id (manifest), when known
  title: string | null;
  url: string | null;
  /** 0-based position in the ingest order of the arm. */
  order: number;
  words?: number | null;
}

/** A claim as it stands at the end of the arm (the player also derives interim states from deltas). */
export interface ReplayClaim {
  id: string;
  text: string;
  claimType: string;
  createdBy: string | null;   // claims.created_by
  createdAt: string;
  importance: number;
  stewardState: string;
  status: string | null;      // current assessment status
  credence: number | null;    // current assessment credence
  confidence: number | null;  // verdict confidence
  /** Top-level = has at least one instance from a source in this arm. */
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
  | "thought"       // assistant text (reasoning shown to the reader)
  | "tool_call"     // a tool the agent called
  | "tool_result"   // what it got back
  | "decision"      // the load-bearing submission (match decision, assessment, review, ruling)
  | "completion"    // single-shot output (Extractor, judge)
  | "prompt";       // the setup the model was given: system prompt, initial messages, tools

/**
 * Nothing in a step is paraphrased or cut by the exporter. `text` is a
 * one-line gist the exporter derives for the timeline; `input` / `output` /
 * `full` carry the verbatim content (a tool's input and output, a thought's
 * whole text, the prompt step's whole setup). `truncated` is set only when
 * the trace itself capped the content (trace-service's per-step cap), never
 * by the replay. The index layout (replay.json) drops the verbatim fields
 * and keeps `sizes`; the detail layout (replay-events/<arm>/<seq>.json)
 * carries everything.
 */
export interface ReplayStep {
  seq: number;
  kind: ReplayStepKind;
  at: string | null;
  /** Short text for the reader: the thought, the tool name + gist, the result gist. */
  text: string;
  tool?: string;
  /** Verbatim tool input / output (detail layout only). */
  input?: unknown;
  output?: unknown;
  /** Verbatim content that is neither an input nor an output: a thought's whole text, a prompt step's setup, a completion's record (detail layout only). */
  full?: unknown;
  /** Set only when the trace itself capped this step's content. */
  truncated?: boolean;
  /** Character sizes of the verbatim fields, so the index can say "12,400 chars, open" (index layout). */
  sizes?: { input?: number; output?: number; full?: number };
}

/**
 * Information movement, per event: what the agent read (each tool result,
 * with the claim and source ids its output mentioned that the arm knows)
 * and what it wrote (its deltas, by op and id), so the player can draw the
 * flow between agents without re-deriving it from the steps.
 */
export interface ReplayDataFlow {
  reads: Array<{ tool: string; claimIds: string[]; sourceIds: string[] }>;
  writes: Array<{ op: ReplayDelta["op"]; claimId?: string | null; sourceId?: string | null; contributionId?: string | null }>;
}

/** One distinct system prompt an arm's agents were given, by content hash. */
export interface ReplayPromptUse {
  sha256: string;
  chars: number;
  agents: string[];
  /** Runs that were given this prompt. */
  count: number;
  /** Where the full text is: the first event and step (a "prompt" step) carrying it. */
  firstEventSeq: number;
  firstStepSeq: number;
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
  /** agent_runs.id when the event is an agent run; null for harness events. */
  runId: string | null;
  claimId: string | null;
  /** The claim's text at the time, for the event title. */
  claimText?: string | null;
  sourceId: string | null;
  /** StewardMessage.trigger, CuratorMessage.trigger, etc. */
  trigger: string | null;
  /** Which event caused this one (enqueue_events.source_run_id → the event with that runId). */
  causedBy: number | null;
  title: string;
  outcome: "ok" | "error" | "running" | null;
  error?: string | null;
  steps: ReplayStep[];
  deltas: ReplayDelta[];
  costMicroUsd: number | null;
  durationMs: number | null;
  /** "run-window" when deltas were credited by time window + claim; "exact" when a tool call names them. */
  attribution: "exact" | "run-window" | "harness";
  /** Index layout: where the full event lives, relative to the replay-events directory ("a/12.json"). */
  detailPath?: string;
  dataFlow?: ReplayDataFlow;
}

export interface ReplayArm {
  key: string;               // "a" | "b" | "pro" | "con" | "benign" | "run"
  label: string;
  /** What differs in this arm, in words (e.g. "sources in shuffled order, seed 3"). */
  variation: string | null;
  fingerprint: ReplayFingerprint;
  sources: ReplaySource[];
  events: ReplayEvent[];
  final: {
    claims: ReplayClaim[];
    edges: ReplayEdge[];
  };
  costMicroUsd: number | null;
  capped: boolean;
  /** Where the arm's graph lives, for whoever wants to dig (snapshot name / db). */
  database: string | null;
  /** The distinct system prompts the arm's agents were given, each once. */
  promptsUsed?: ReplayPromptUse[];
}

/** The pairing the agreement metric found between two arms' claims. */
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
  /** Personas / contributors, by key. */
  actors: Array<{ key: string; displayName: string; note?: string | null; tier?: string | null; role?: "attacker" | "benign" | "persona" | null }>;
  /** Targets (adversarial): the claim under attack per arm. */
  targets?: Array<{ key: string; claimId: string | null; text: string | null; direction?: "up" | "down" | null }>;
}

export interface Replay {
  version: typeof REPLAY_VERSION;
  kind: ReplayKind;
  /** Stable name; the file is corpus/replays/<name>.json. */
  name: string;
  title: string;
  cluster: string | null;
  generatedAt: string;
  /** What this recording is meant to show, in a sentence or two (from the driver, not hand-written per run). */
  about: string;
  arms: ReplayArm[];
  matching: ReplayMatching[] | null;
  scenario: ReplayScenario | null;
  /** Headline result of the episode, as the driver summarised it (property summary, contribution summary, adversarial summary). */
  summary: Record<string, unknown> | null;
  /** The eval_runs row this recording belongs to, when registered. */
  evalRunId: string | null;
  /** Total metered cost across arms. */
  costMicroUsd: number | null;
}
