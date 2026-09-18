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
  | "adversarial";  // attack arms + benign control against one snapshot

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
  | "completion";   // single-shot output (Extractor, judge)

export interface ReplayStep {
  seq: number;
  kind: ReplayStepKind;
  at: string | null;
  /** Short text for the reader: the thought, the tool name + gist, the result gist. */
  text: string;
  tool?: string;
  /** Trimmed JSON of the tool input / output; `truncated` when cut. */
  input?: unknown;
  output?: unknown;
  truncated?: boolean;
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
