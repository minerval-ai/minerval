/**
 * Agent trace persistence (#334 L0, from #274).
 *
 * Records one agent_runs row per agent invocation and one agent_steps row per
 * turn of the tool-use loop, so the full transcript — model messages, tool
 * calls and results, the reasoning that produced a verdict — survives the
 * process instead of dying with it. The eval harness, debugging, and the
 * production monitors all read from here; llm_usage joins in via run_id for
 * exact per-run cost.
 *
 * Wiring (all existing seams, no new ones):
 *   - withAgent() (src/llm/usage-context.ts) opens the run and closes it when
 *     the wrapped work settles; the trace handle rides the usage context.
 *   - toolUseLoop() (src/llm/client.ts) appends steps via recordAgentStep.
 *   - meterLlmUsage() (usage-service) stamps run_id on every usage row.
 *
 * By default every write here is fire-and-forget and swallows its own
 * errors: tracing does not fail or slow an agent run. Consumers therefore
 * tolerate incomplete traces (a run with missing steps, a run never
 * finished). Single-shot completions outside a tool-use loop (the Extractor,
 * the judge) are recorded as one "assistant" step carrying the prompt and
 * the output, so a run is never a bare row.
 *
 * The log is a hash chain (#552; the arithmetic is in run-log.ts). A run's
 * steps are appended one at a time, in the order they were claimed, each
 * carrying the hash of the step before it; when the run closes with every
 * step written, the run row is sealed with the last hash. A run that lost a
 * step closes unsealed, so "sealed" means the log is whole. With
 * RUN_LOG_MODE=record the run depends on its log instead of the other way
 * round: see sealAgentRun and withAgent (llm/usage-context.ts).
 *
 * TRACE_LEVEL: "full" records runs + steps; "off" records nothing. Unset, it
 * defaults off under vitest (unit tests must not attempt DB writes) and full
 * everywhere else, production included: the retention sweep
 * (workers/trace-retention.ts, TRACE_RETENTION_DAYS) bounds what production
 * keeps, which is what "off until a retention job exists" was waiting for.
 * Runs that wrote to the graph are exempt and kept for good: the statement
 * observer marks them (markRunWroteGraph, db/graph-writes.ts).
 *
 * What is traced is a privacy decision, not a size one (#356). A transcript
 * is verbatim: the document the Extractor read, the span the Matcher was
 * handed, the question a reader typed. That is exactly right for the work
 * the graph does on public sources — a submitted URL becomes provenance, and
 * its transcript is how the eval harness and the monitors see the agents
 * think — and exactly wrong for content a user never published: the page
 * open in their browser, a chat about it, a passage pasted into an MCP
 * client. Two rules keep the second kind out, independent of TRACE_LEVEL:
 *   - untraced() (usage-context.ts) marks a stretch of work as transient;
 *     withAgent opens no run inside it. The extension service and the MCP's
 *     on-demand analysis tools run their whole pipeline under it.
 *   - NEVER_TRACED lists agents whose entire input is such content, so they
 *     stay untraced whoever calls them.
 * Retention bounds how long a trace lives; these rules decide whether one
 * exists at all.
 *
 * Both rules are an exemption of the best-effort log, and record mode has
 * none: there every run is logged, a reader's own content included, because
 * a deployment that keeps its log as a record holds material whose handling
 * has to be on it (docs/run-log.md, "Record mode"). A run over such content
 * starts private (READERS_OWN_REASON), and the model seam refuses a call
 * that has no run to be logged in (llm/logged-run.ts).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { agentPrivateReason } from "../llm/run-visibility.js";
import { agentRuns, agentSteps } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { genesisHash, stepHash } from "./run-log.js";
import { PUBLIC_LABEL } from "../labels.js";

/** Mutable trace handle carried on the usage context for the run's duration. */
export interface AgentTrace {
  runId: string;
  /**
   * The label the run writes at (src/labels.ts), fixed when the run opens.
   * The run row carries it, and every step is stamped from here: a step is
   * written from a queue, later than it was claimed, and belongs to its run
   * whatever work is going on when the write lands.
   */
  label: string;
  /** Next step sequence number; mutated by recordAgentStep. */
  seq: { n: number };
  /**
   * Settles once the agent_runs row is in (or its insert failed). Step
   * writes wait on it: the first step (the prompt) is recorded the moment a
   * loop starts, and without this it raced the run row and lost to the
   * foreign key.
   */
  ready: Promise<void>;
  /**
   * Set on the run's first write to the graph (db/graph-writes.ts), so the
   * mark is written once. A run so marked is kept by the retention sweep.
   */
  wroteGraph?: boolean;
  /** Reasons already recorded on the run, so each is written once. */
  privateReasons?: Set<string>;
  /**
   * The append queue: settles when every step claimed so far has been
   * written or has failed. Steps are chained, so they are written one at a
   * time, in order of seq.
   */
  tail: Promise<void>;
  /** The hash the chain has reached: the genesis, then each step's in turn. */
  head: string;
  /** Set when the run row or any step could not be written: the run closes unsealed. */
  broken?: boolean;
}

/** Whether runs depend on their logs (RUN_LOG_MODE=record). */
export function recordMode(): boolean {
  return loadConfig().runLogMode === "record";
}

/** A run in record mode whose log could not be written whole. */
export class RunLogError extends Error {
  constructor(runId: string) {
    super(`The log of run ${runId} could not be written whole, so the run is not finished (RUN_LOG_MODE=record)`);
    this.name = "RunLogError";
  }
}

export interface RunAttribution {
  userId?: string | null;
  jobId?: string | null;
  claimId?: string | null;
  requestId?: string | null;
  /** The label the run writes at (src/labels.ts); absent means public. */
  label?: string;
  /**
   * Set by untraced() (usage-context.ts): the work is over a reader's own
   * content. Such a run is opened only in record mode, and starts private.
   */
  untraced?: true;
}

/**
 * Why a run over a reader's own content is private (llm/run-visibility.ts):
 * its transcript holds a page they had open, a passage they handed to an
 * analysis tool, or the message that opened their conversation.
 */
export const READERS_OWN_REASON = "input:readers-own-content";

/**
 * The trace level in force, optionally for one agent. TRACE_ALWAYS_AGENTS
 * (docs/mathematics.md §7.4; `math_solver` by default) forces tracing on
 * for the named agents even where TRACE_LEVEL=off has switched it off: the
 * solver's transcript is the evidence a prize review relies on. Otherwise
 * the default is full everywhere but vitest. In record mode every run is
 * traced.
 */
export function traceLevel(agent?: string): "off" | "full" {
  const config = loadConfig();
  if (config.runLogMode === "record") return "full";
  if (agent && (config.traceAlwaysAgents ?? []).includes(agent)) return "full";
  if (config.traceLevel) return config.traceLevel;
  if (process.env.VITEST) return "off";
  return "full";
}

/**
 * Agents never traced while the log is best-effort, at any TRACE_LEVEL:
 * everything they are given is a reader's own page (#356). The extension
 * agent judges the phrasings on whatever page is open in the browser, which
 * is not the public graph's to keep.
 */
const NEVER_TRACED: ReadonlySet<string> = new Set(["extension"]);

/**
 * Whether a run of `agent` may be recorded at all. In record mode every run
 * is. Otherwise never-traced wins over everything, including
 * TRACE_ALWAYS_AGENTS.
 */
export function traceable(agent: string): boolean {
  if (recordMode()) return true;
  return !NEVER_TRACED.has(agent) && traceLevel(agent) !== "off";
}

// A step's content is capped so a pathological tool output can't bloat the
// table; the cap is generous because whole-transcript fidelity is the point.
// The "prompt" step (the agent's whole setup: system prompt, initial
// messages, tool descriptors) has a cap of its own, an order of magnitude
// higher: the constitution plus a role prompt plus domain skills runs past
// 200k characters, and a replay reader must see exactly what the agent was
// given, whole, not a preview of it.
const MAX_STEP_CONTENT_CHARS = 200_000;
const MAX_PROMPT_STEP_CONTENT_CHARS = 2_000_000;

/**
 * Step kinds: "prompt" (once per tool loop or single-shot completion: the
 * setup the model was given, verbatim), "assistant" (one model turn: stop
 * reason + content blocks), "tool_results" (the executed tools of that turn:
 * name, input, output), "completion" (a single-shot call: prompt and output).
 */
export type AgentStepKind = "prompt" | "assistant" | "tool_results" | "completion";

/**
 * Open a run for `agent`, snapshotting the ambient attribution. Returns null
 * when tracing is off (callers skip all trace work on null).
 */
export function startAgentRun(
  agent: string,
  attribution: RunAttribution
): AgentTrace | null {
  if (!traceable(agent)) return null;
  return openAgentRun(agent, attribution);
}

/**
 * Open a run without asking whether `agent` is traced here. startAgentRun is
 * the way in for the agents' work. The one other caller is the preflight's
 * test of the log itself (src/preflight.ts), which has to write a run and
 * check it where TRACE_LEVEL is off too.
 */
export function openAgentRun(agent: string, attribution: RunAttribution): AgentTrace {
  const runId = randomUUID();
  const agentReason = agentPrivateReason(agent);
  const initialReasons = [
    ...(agentReason ? [agentReason] : []),
    // The agent's default covers its ordinary input (a submitted source is
    // public); a reader's own content handed to the same agent is not.
    ...(attribution.untraced ? [READERS_OWN_REASON] : []),
  ];
  // The label the run writes at, from the context that opened it, so the
  // run row, its steps and the rows the run writes carry the same one.
  const label = attribution.label ?? PUBLIC_LABEL;
  const trace: AgentTrace = {
    runId,
    label,
    seq: { n: 0 },
    ready: Promise.resolve(),
    privateReasons: new Set(initialReasons),
    tail: Promise.resolve(),
    head: genesisHash(runId),
  };
  trace.ready = (async () => {
    try {
      await getDb().insert(agentRuns).values({
        id: runId,
        agent,
        userId: attribution.userId ?? null,
        jobId: attribution.jobId ?? null,
        claimId: attribution.claimId ?? null,
        requestId: attribution.requestId ?? null,
        commitSha: loadConfig().gitSha ?? null,
        sensitivityLabel: label,
        // A run starts private when its agent's inputs are not public by
        // construction (llm/run-visibility.ts); tools can add reasons later.
        privateReasons: initialReasons,
      });
    } catch (err) {
      trace.broken = true;
      console.error(
        "[trace] failed to record agent run:",
        err instanceof Error ? err.message : err
      );
    }
  })();
  return trace;
}

/**
 * Record the domain skills a run carried (skill names) once the agent has
 * resolved them, which is after the run opened. Fire-and-forget like the
 * rest; an empty list is recorded as [] so an unskilled run reads as such
 * rather than as "unknown".
 */
export function recordAgentRunSkills(
  trace: AgentTrace,
  skills: readonly string[]
): void {
  void (async () => {
    try {
      await trace.ready;
      await getDb()
        .update(agentRuns)
        .set({ skills: [...skills] })
        .where(eq(agentRuns.id, trace.runId));
    } catch (err) {
      console.error(
        "[trace] failed to record agent run skills:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

/**
 * Mark the run as having written to the graph, so the retention sweep keeps
 * it. Called by the usage context's statement observer on the run's first
 * graph write; idempotent, and fire-and-forget like every trace write.
 */
export function markRunWroteGraph(trace: AgentTrace): void {
  if (trace.wroteGraph) return;
  trace.wroteGraph = true;
  void (async () => {
    try {
      await trace.ready;
      await getDb()
        .update(agentRuns)
        .set({ wroteToGraph: true })
        .where(eq(agentRuns.id, trace.runId));
    } catch (err) {
      console.error(
        "[trace] failed to mark agent run as a graph writer:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

/**
 * Record a reason the run's transcript is private (llm/run-visibility.ts).
 * Idempotent per reason, fire-and-forget like every trace write. The client
 * calls it for each tool a run executes that reads private data; agent code
 * calls it (through markCurrentRunPrivate) when it hands a run private input.
 */
export function markRunPrivate(trace: AgentTrace, reason: string): void {
  const seen = (trace.privateReasons ??= new Set());
  if (seen.has(reason)) return;
  seen.add(reason);
  void (async () => {
    try {
      await trace.ready;
      await rawQuery(
        `UPDATE agent_runs
            SET private_reasons = array_append(private_reasons, $2)
          WHERE id = $1 AND NOT ($2 = ANY(private_reasons))`,
        [trace.runId, reason]
      );
    } catch (err) {
      console.error(
        "[trace] failed to mark agent run private:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

/**
 * Close the run: once every step claimed has been written or has failed,
 * stamp the run finished and, when the log is whole, seal it with the hash
 * the chain reached. Resolves to whether the run was sealed; never rejects.
 * Safe to call exactly once.
 */
export function sealAgentRun(
  trace: AgentTrace,
  outcome: "ok" | "error",
  error?: unknown
): Promise<boolean> {
  return (async () => {
    try {
      await trace.tail;
      await trace.ready;
      const sealed = !trace.broken;
      await getDb()
        .update(agentRuns)
        .set({
          finishedAt: new Date(),
          outcome,
          error:
            outcome === "error"
              ? String(error instanceof Error ? error.message : error).slice(0, 2000)
              : null,
          steps: trace.seq.n,
          ...(sealed ? { logHash: trace.head, sealedAt: new Date() } : {}),
        })
        .where(eq(agentRuns.id, trace.runId));
      return sealed;
    } catch (err) {
      console.error(
        "[trace] failed to finish agent run:",
        err instanceof Error ? err.message : err
      );
      return false;
    }
  })();
}

/** Close the run without waiting on it: the best-effort close. */
export function finishAgentRun(
  trace: AgentTrace,
  outcome: "ok" | "error",
  error?: unknown
): void {
  void sealAgentRun(trace, outcome, error);
}

/**
 * Append one step to the run. Sequence is claimed synchronously; the content
 * may be a promise, for a step whose content takes a moment to assemble.
 * Steps are written one at a time in order of seq, each chained to the one
 * before it. A step that cannot be written leaves the run unsealed; the
 * chain still advances past it, so the steps after it record that one is
 * missing rather than closing over the gap.
 */
export function recordAgentStep(
  trace: AgentTrace,
  kind: AgentStepKind,
  content: unknown
): void {
  const seq = trace.seq.n++;
  trace.tail = trace.tail.then(async () => {
    try {
      await trace.ready;
      const stored = storedContent(
        await content,
        recordMode()
          ? null
          : kind === "prompt"
            ? MAX_PROMPT_STEP_CONTENT_CHARS
            : MAX_STEP_CONTENT_CHARS
      );
      const prevHash = trace.head;
      const hash = stepHash(prevHash, seq, kind, stored);
      trace.head = hash;
      await getDb().insert(agentSteps).values({
        runId: trace.runId,
        seq,
        kind,
        content: stored,
        prevHash,
        hash,
        // The run's label, not currentLabel(): this callback runs from the
        // trace's queue, and a step recorded from inside work at another
        // label (a tool that reads at a source's label, say) is still a
        // step of this run. The hash above does not cover it.
        sensitivityLabel: trace.label,
      });
    } catch (err) {
      trace.broken = true;
      console.error(
        "[trace] failed to record agent step:",
        err instanceof Error ? err.message : err
      );
    }
  });
}

/**
 * The content as it will be stored and hashed: what a jsonb column keeps of
 * it, cut to `cap` characters when there is one. Record mode passes no cap:
 * a record is not a preview.
 */
function storedContent(content: unknown, cap: number | null): unknown {
  let serialized: string;
  try {
    // A value JSON has no form for (a function, a symbol) is stored as null.
    serialized = JSON.stringify(content ?? null) ?? "null";
  } catch {
    // Circular or otherwise unserializable content: record that it existed.
    return { unserializable: true };
  }
  if (cap !== null && serialized.length > cap) {
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, cap),
    };
  }
  return JSON.parse(serialized);
}
