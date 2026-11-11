/**
 * The run log's hash chain (#552): the arithmetic, with no database in it,
 * so the writer (trace-service.ts), the verifier (run-view-service.ts) and
 * anyone outside can compute the same thing.
 *
 * Every step of a run carries `prev_hash` and `hash`:
 *
 *   genesis   = sha256("minerval-run-log/1\n" + run id)
 *   step hash = sha256(prev_hash + "\n" + seq + "\n" + kind + "\n" + canonical content)
 *
 * where the first step's prev_hash is the genesis and each later step's is
 * the hash of the step before it. Starting from the run's id keeps a step
 * from being moved to another run. When the run closes with every step
 * written, it is sealed: `agent_runs.log_hash` is the last step's hash (the
 * genesis, for a run with no steps) and `sealed_at` is when. So a step that
 * is altered, removed, reordered or added after the seal shows: the chain
 * no longer reaches the sealed hash.
 *
 * Canonical content is the step's content as stored, written as JSON with
 * object keys sorted (by UTF-16 code unit, as JavaScript compares strings),
 * no whitespace, and scalars as JSON.stringify writes them. That is what
 * survives a round trip through a jsonb column, which keeps neither key
 * order nor spacing.
 *
 * What the chain shows is that the log is whole and unaltered since it was
 * sealed, against the sealed hash. It does not by itself show that the
 * sealed hash is the original one: whoever can rewrite every row can
 * rewrite the seal too. That takes the hash being held somewhere else, as a
 * published page's record will hold it.
 */
import { createHash } from "node:crypto";

export const RUN_LOG_FORMAT = 1;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A value as JSON with sorted keys and no whitespace. Takes JSON values only. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The content as a jsonb column will hold it: what JSON.stringify keeps,
 * parsed back. Undefined members are gone, dates are strings, and so on, so
 * hashing this is hashing what a reader of the row will see.
 */
export function asStored(content: unknown): unknown {
  return JSON.parse(JSON.stringify(content ?? null));
}

/** Canonical JSON of a step's content. `content` must already be as stored. */
export function canonicalContent(content: unknown): string {
  return sortedJson(content);
}

export function genesisHash(runId: string): string {
  return sha256(`minerval-run-log/${RUN_LOG_FORMAT}\n${runId.toLowerCase()}`);
}

export function stepHash(prevHash: string, seq: number, kind: string, content: unknown): string {
  return sha256(`${prevHash}\n${seq}\n${kind}\n${canonicalContent(content)}`);
}

export interface ChainedStep {
  seq: number;
  kind: string;
  content: unknown;
  prev_hash: string | null;
  hash: string | null;
}

export type ChainProblem =
  /** No step has this sequence number. */
  | { seq: number; reason: "missing" }
  /** The step does not follow from the one before it. */
  | { seq: number; reason: "prev_hash_mismatch" }
  /** The step's content, kind or position is not what its hash was taken over. */
  | { seq: number; reason: "hash_mismatch" }
  /** The step was recorded before steps were chained. */
  | { seq: number; reason: "not_chained" }
  /** The chain is whole but does not end at the sealed hash. */
  | { seq: null; reason: "seal_mismatch" }
  /** The run counted more steps at its close than are recorded. */
  | { seq: number; reason: "fewer_steps_than_counted" };

export interface ChainCheck {
  /** Steps checked before the first problem (all of them, when there is none). */
  steps_checked: number;
  /** The hash the chain reaches: the last step's, or the genesis with no steps. */
  head: string;
  problem: ChainProblem | null;
}

/**
 * Recompute a run's chain a step at a time, in order of seq, so a long run
 * need not be held in memory. `push` returns false once something is wrong;
 * `finish` compares the chain with the seal, when the run has one.
 */
export function chainChecker(runId: string): {
  push: (step: ChainedStep) => boolean;
  finish: (sealed: { logHash: string; stepsCounted: number } | null) => ChainCheck;
} {
  let head = genesisHash(runId);
  let checked = 0;
  let problem: ChainProblem | null = null;
  return {
    push(step) {
      if (problem) return false;
      if (step.seq !== checked) problem = { seq: checked, reason: "missing" };
      else if (step.hash == null || step.prev_hash == null) problem = { seq: step.seq, reason: "not_chained" };
      else if (step.prev_hash !== head) problem = { seq: step.seq, reason: "prev_hash_mismatch" };
      else if (stepHash(head, step.seq, step.kind, step.content) !== step.hash) {
        problem = { seq: step.seq, reason: "hash_mismatch" };
      }
      if (problem) return false;
      head = step.hash!;
      checked++;
      return true;
    },
    finish(sealed) {
      if (!problem && sealed) {
        if (checked < sealed.stepsCounted) problem = { seq: checked, reason: "fewer_steps_than_counted" };
        else if (head !== sealed.logHash) problem = { seq: null, reason: "seal_mismatch" };
      }
      return { steps_checked: checked, head, problem };
    },
  };
}

/**
 * Recompute a run's chain from its steps and compare it with what is stored
 * and, when the run is sealed, with the sealed hash. `stepsCounted` is the
 * number of steps the run counted at its close.
 */
export function checkChain(
  runId: string,
  steps: readonly ChainedStep[],
  sealed: { logHash: string; stepsCounted: number } | null
): ChainCheck {
  const checker = chainChecker(runId);
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (!checker.push(step)) break;
  }
  return checker.finish(sealed);
}
