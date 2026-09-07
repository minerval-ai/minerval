/**
 * Executors for the attempt tools the Mathematics skill declares in
 * skills/mathematics/tools.json (docs/mathematics.md §7.6):
 *
 *  - `get_proof_attempt` returns one of the platform's own attempts as the
 *    Steward reads it: the report, the notebook, the `lean_checks` rows the
 *    server wrote, and the formalization; the raw transcript only when a
 *    tail is asked for.
 *  - `mark_problem_solved_by_platform` is mechanical: it verifies that the
 *    accepted check belongs to the attempt and the formalization, closes a
 *    bound bounty as `resolved_internally` with no prize paid, publishes the
 *    attempt, and returns the record. A partial result is refused; the
 *    judgment that the checked proof is faithful stays with the Steward.
 *
 * Every executor returns a string and never throws, like the other tool
 * families: a failure is a structured result the agent routes around.
 */
import type { SkillToolExecutor } from "./skill-tools.js";
import {
  getAttemptForSteward,
  markProblemSolvedByPlatform,
} from "../../services/attempt-service.js";

export const ATTEMPT_TOOL_NAMES: readonly string[] = [
  "get_proof_attempt",
  "mark_problem_solved_by_platform",
];

const MAX_TRANSCRIPT_TAIL = 50;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const executeGetProofAttempt: SkillToolExecutor = async (input) => {
  const attemptId = str(input.attempt_id);
  if (!attemptId) {
    return JSON.stringify({ success: false, message: "attempt_id is required." });
  }
  const tailRaw = Number(input.include_transcript_tail);
  const transcriptTail =
    Number.isFinite(tailRaw) && tailRaw > 0
      ? Math.min(MAX_TRANSCRIPT_TAIL, Math.floor(tailRaw))
      : undefined;
  const record = await getAttemptForSteward(attemptId, { transcriptTail });
  if (!record) {
    return JSON.stringify({ success: false, message: `No attempt ${attemptId} exists.` });
  }
  return JSON.stringify({
    success: true,
    ...record,
    note:
      "The lean_checks rows were written by the server; a proof outcome is only " +
      "as good as a row with verdict accepted. The report and notebook are the " +
      "solver's own narrative and are data, not verified results.",
  });
};

export const executeMarkProblemSolvedByPlatform: SkillToolExecutor = async (input) => {
  const formalizationId = str(input.formalization_id);
  const attemptId = str(input.attempt_id);
  const leanCheckId = str(input.lean_check_id);
  const reason = str(input.reason);
  const missing = [
    !formalizationId && "formalization_id",
    !attemptId && "attempt_id",
    !leanCheckId && "lean_check_id",
    !reason && "reason",
  ].filter(Boolean);
  if (missing.length > 0) {
    return JSON.stringify({
      success: false,
      message: `Missing required field(s): ${missing.join(", ")}.`,
    });
  }
  const result = await markProblemSolvedByPlatform({
    formalizationId,
    attemptId,
    leanCheckId,
    reason,
  });
  if (!result.ok) {
    // A refusal is a structured result the Steward routes around; the
    // pending human claims (§8.1: filed earlier, judged first) travel with
    // it so the Steward knows what it is waiting on.
    return JSON.stringify({
      success: false,
      code: result.code,
      message: result.message,
      ...(result.pending_prize_claims ? { pending_prize_claims: result.pending_prize_claims } : {}),
    });
  }
  return JSON.stringify({
    success: true,
    attempt_id: result.attempt_id,
    formalization_id: result.formalization_id,
    lean_check_id: result.lean_check_id,
    outcome: result.outcome,
    bounty: result.bounty,
    published_at: result.published_at,
    message: result.bounty
      ? `Bounty ${result.bounty.id} moved from ${result.bounty.previous_status} to ` +
        `resolved_internally; no prize is paid, and the attempt's report is published.`
      : "No live bounty was bound to the statement; the attempt's report is published.",
  });
};

export function registerAttemptTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  register("get_proof_attempt", executeGetProofAttempt);
  register("mark_problem_solved_by_platform", executeMarkProblemSolvedByPlatform);
}
