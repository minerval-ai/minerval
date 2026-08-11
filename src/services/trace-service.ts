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
 * Like metering, every write here is fire-and-forget and swallows its own
 * errors: tracing must never fail or slow an agent run. Consumers therefore
 * tolerate incomplete traces (a run with missing steps, a run never
 * finished). Single-shot completions outside a tool-use loop are not recorded
 * as steps in this first cut — their llm_usage row plus the domain artifact
 * they produced still describe them.
 *
 * TRACE_LEVEL: "full" records runs + steps; "off" records nothing. Unset, it
 * defaults to full everywhere except vitest (unit tests must not attempt DB
 * writes). Production traced by default only once a retention job existed to
 * bound the growth — workers/trace-retention.ts is that job, so the old
 * production-off default is gone. An operator who wants the firehose closed
 * sets TRACE_LEVEL=off; one who wants it cheaper shortens
 * TRACE_STEP_RETENTION_DAYS, which sheds the bulk without losing the run rows
 * that per-claim cost attribution joins against.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agentRuns, agentSteps } from "../db/schema.js";
import { loadConfig } from "../config.js";

/** Mutable trace handle carried on the usage context for the run's duration. */
export interface AgentTrace {
  runId: string;
  /** Next step sequence number; mutated by recordAgentStep. */
  seq: { n: number };
}

export interface RunAttribution {
  userId?: string | null;
  jobId?: string | null;
  claimId?: string | null;
  requestId?: string | null;
  /**
   * This work reads content that is private to the user, so its transcript
   * must never be persisted. Set by the browser-extension ingestion path
   * (#72): the Extractor and Matcher there run over whatever page the user
   * happens to be looking at — webmail, an internal wiki, a medical portal —
   * and agent_steps would capture that text verbatim.
   *
   * Suppression happens at RECORDING, not retention, and the distinction is
   * the whole point: writing private browsing to a table and deleting it a
   * fortnight later is still collecting it, still in every backup taken in
   * between, and still discoverable. The same runs invoked by the SYSTEM —
   * corpus ingestion, a Steward's decomposition, /sources submissions — are
   * traced normally, because their inputs are the public documents the graph
   * is made of.
   *
   * llm_usage and enqueue_events are unaffected: they record token counts,
   * cost, and ids, never content, so extension work stays fully accounted for
   * financially while its text is never written down.
   */
  sensitive?: boolean;
}

/**
 * Whether a run should be recorded at all. Pure and exported so the policy is
 * testable without a database or a live config — the suppression path is
 * exactly the one that must not regress silently.
 */
export function shouldRecordRun(
  level: "off" | "full",
  attribution: RunAttribution
): boolean {
  if (level === "off") return false;
  return attribution.sensitive !== true;
}

export function traceLevel(): "off" | "full" {
  const config = loadConfig();
  if (config.traceLevel) return config.traceLevel;
  if (process.env.VITEST) return "off";
  return "full";
}

// A step's content is capped so a pathological tool output can't bloat the
// table; the cap is generous because whole-transcript fidelity is the point.
const MAX_STEP_CONTENT_CHARS = 200_000;

/**
 * Open a run for `agent`, snapshotting the ambient attribution. Returns null
 * when tracing is off (callers skip all trace work on null).
 */
export function startAgentRun(
  agent: string,
  attribution: RunAttribution
): AgentTrace | null {
  // No trace handle means withAgent records no run AND toolUseLoop records no
  // steps — one check suppresses the whole transcript, rather than leaving a
  // headless run row or a half-written one.
  if (!shouldRecordRun(traceLevel(), attribution)) return null;
  const runId = randomUUID();
  void (async () => {
    try {
      await getDb().insert(agentRuns).values({
        id: runId,
        agent,
        userId: attribution.userId ?? null,
        jobId: attribution.jobId ?? null,
        claimId: attribution.claimId ?? null,
        requestId: attribution.requestId ?? null,
      });
    } catch (err) {
      console.error(
        "[trace] failed to record agent run:",
        err instanceof Error ? err.message : err
      );
    }
  })();
  return { runId, seq: { n: 0 } };
}

/** Stamp the run finished. Fire-and-forget; safe to call exactly once. */
export function finishAgentRun(
  trace: AgentTrace,
  outcome: "ok" | "error",
  error?: unknown
): void {
  void (async () => {
    try {
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
        })
        .where(eq(agentRuns.id, trace.runId));
    } catch (err) {
      console.error(
        "[trace] failed to finish agent run:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

/** Append one step to the run. Sequence is claimed synchronously. */
export function recordAgentStep(
  trace: AgentTrace,
  kind: "assistant" | "tool_results",
  content: unknown
): void {
  const seq = trace.seq.n++;
  void (async () => {
    try {
      await getDb().insert(agentSteps).values({
        runId: trace.runId,
        seq,
        kind,
        content: capContent(content),
      });
    } catch (err) {
      console.error(
        "[trace] failed to record agent step:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

function capContent(content: unknown): unknown {
  try {
    const serialized = JSON.stringify(content);
    if (serialized.length <= MAX_STEP_CONTENT_CHARS) return content;
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAX_STEP_CONTENT_CHARS),
    };
  } catch {
    // Circular or otherwise unserializable content: record that it existed.
    return { unserializable: true };
  }
}
