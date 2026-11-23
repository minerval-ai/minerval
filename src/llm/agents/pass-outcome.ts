/**
 * What a Steward pass concluded, said from the task's own definition of
 * concluding (#1027). The ledger records "what it spent and what came of it"
 * (§19); this is the second half, computed when the pass ends, and stored on
 * the ledger row that paid for it (actions.outcome, assessment_orders.outcome).
 *
 * Five outcomes:
 * - recorded: the task's judgment tool succeeded (an assessment, an
 *   estimate, a list's judgment, a formal statement, a prize decision).
 * - stood: the pass logged a decision that the judgment in force stands
 *   (log_stewardship_decision with judgment_stands). Part VIII: "concluding
 *   that nothing needs to change is a legitimate outcome, recorded and done."
 * - left_standing: it left the judgment it reads at another label standing
 *   for its own label (leave_judgment_standing).
 * - logged: a task whose conclusion is a logged decision of another kind (a
 *   formalization that could not proceed, an attempt that settled nothing).
 * - waiting: nothing concluded yet, and the session paused on what it asked
 *   for; it resumes when that is answered.
 * - unconcluded: nothing concluded and nothing outstanding. The pass ended
 *   without a judgment, whatever it read or wrote on the way.
 *
 * A logged decision that claims a change no tool made ("reassessed" while
 * update_claim_assessment failed) is not a conclusion: it is reported as
 * unconcluded, with the log's words shown.
 */

/** A tool call that succeeded this pass, with what it was given and what it returned. */
export interface DoneCall {
  input: Record<string, unknown>;
  output: string;
}

/** Every tool that succeeded this pass, by name, in call order. */
export type PassDone = ReadonlyMap<string, readonly DoneCall[]>;

export const LOG_TOOL = "log_stewardship_decision";

/**
 * The logged decision that the judgment in force stands, if the pass made
 * one: judgment_stands true, or, where the Steward left that field out,
 * action_taken no_action_needed. The last such call wins.
 */
export function standsLog(done: PassDone): DoneCall | null {
  const calls = done.get(LOG_TOOL) ?? [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const input = calls[i]!.input;
    const explicit = input.judgment_stands;
    if (explicit === true) return calls[i]!;
    if (explicit === false) continue;
    if (String(input.action_taken ?? "").trim().toLowerCase() === "no_action_needed") return calls[i]!;
  }
  return null;
}

/** How a pass that concluded nothing ended. */
export type PassEndedBy =
  /** The Steward ended its turn (after its one nudge) without concluding. */
  | "stopped"
  /** The runaway backstop on turns ran out. */
  | "turn_guard"
  /** A turn was cut off at the output limit and could not be resumed. */
  | "output_limit";

/** The judgment in force when the pass began. */
export interface PriorJudgment {
  id: string;
  status: string | null;
  at: string | null;
}

interface OutcomeBase {
  /** The judgment in force when the pass began; null when the node had none. */
  before: PriorJudgment | null;
  /** The pass's run on the run log, when one was kept. */
  run_id?: string | null;
}

export type PassOutcome = OutcomeBase &
  (
    | { kind: "recorded"; tool: string; status_after: string | null; also_waiting?: boolean }
    | { kind: "stood"; logged: string; audit_log_id: string | null; also_waiting?: boolean }
    | { kind: "left_standing"; also_waiting?: boolean }
    | { kind: "logged"; logged: string; audit_log_id: string | null; also_waiting?: boolean }
    | { kind: "waiting" }
    | {
        kind: "unconcluded";
        ended_by: PassEndedBy;
        /** The pass spent its whole budget (or went past it). */
        spent_all: boolean;
        /**
         * The pass stopped for a reason on the platform's side, not the
         * Steward's judgment: it was cut off at the output limit, or a tool
         * it called to conclude failed with an error of the platform's own.
         * A person who paid for such a pass is refunded (order-pipeline.ts).
         */
        platform_side: boolean;
        /** Concluding tools that failed with the platform's error, and the error. */
        failed?: Array<{ tool: string; error: string }>;
        /** What it did write on the way (tool name and count), reads left out. */
        wrote: Array<{ tool: string; n: number }>;
        /** The words of a logged decision that did not conclude the pass. */
        logged?: string;
      }
  );

/** Tools that only read: left out of what an unconcluded pass wrote. */
const READ_TOOL = /^(get_|search_|list_|read_|view_|load_|query_|lean_search|lean_elaborate|web_search|elicit_|pangram_|match_claim|code_execution|check_|resolve_identifier)/;

/** Whether a tool's output is the error a thrown exception became: the platform's fault, not the agent's input. */
export function isThrownError(output: string): boolean {
  return output.startsWith("Error: ");
}

export function classifyPass(input: {
  /** The tools whose success is the pass's judgment, for this task. */
  judgmentTools: readonly string[];
  /** Whether the pass still owes its conclusion (the task's own predicate). */
  owed: (done: PassDone) => boolean;
  done: PassDone;
  /** Calls to the judgment tools (and the log) that failed with a thrown error. */
  thrown: ReadonlyArray<{ tool: string; error: string }>;
  /** The session's status after the pass (session-service.ts suspendSession). */
  sessionStatus: string | null;
  /** The loop's last stop reason. */
  stopReason: string | null;
  budget: { spentMicroUsd: number; ceilingMicroUsd: number } | null;
  before: PriorJudgment | null;
  runId?: string | null;
}): PassOutcome {
  const { done } = input;
  const base: OutcomeBase = { before: input.before, ...(input.runId ? { run_id: input.runId } : {}) };
  const waiting = input.sessionStatus === "waiting" || input.sessionStatus === "ready";
  const also = waiting ? { also_waiting: true } : {};
  const logId = (c: DoneCall): string | null => {
    try {
      const id = (JSON.parse(c.output) as { audit_log_id?: unknown }).audit_log_id;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  };

  // The task's judgment tool, the last of them that succeeded.
  for (const tool of input.judgmentTools) {
    const calls = done.get(tool);
    if (calls && calls.length > 0) {
      const last = calls[calls.length - 1]!.input;
      const after = last.status ?? last.standing ?? last.fidelity ?? last.decision ?? null;
      return { ...base, kind: "recorded", tool, status_after: after == null ? null : String(after), ...also };
    }
  }
  if ((done.get("leave_judgment_standing") ?? []).length > 0) {
    return { ...base, kind: "left_standing", ...also };
  }
  if (!input.owed(done)) {
    const stands = standsLog(done);
    if (stands) {
      return { ...base, kind: "stood", logged: String(stands.input.action_taken ?? ""), audit_log_id: logId(stands), ...also };
    }
    const log = (done.get(LOG_TOOL) ?? []).at(-1);
    if (log) {
      return { ...base, kind: "logged", logged: String(log.input.action_taken ?? ""), audit_log_id: logId(log), ...also };
    }
  }
  if (waiting) return { ...base, kind: "waiting" };

  const endedBy: PassEndedBy =
    input.stopReason === "max_tokens" ? "output_limit" : input.stopReason === "end_turn" || input.stopReason === null ? "stopped" : "turn_guard";
  const spentAll = input.budget ? input.budget.spentMicroUsd >= input.budget.ceilingMicroUsd : false;
  const wrote = [...done.entries()]
    .filter(([tool]) => !READ_TOOL.test(tool) && tool !== LOG_TOOL)
    .map(([tool, calls]) => ({ tool, n: calls.length }));
  const lastLog = (done.get(LOG_TOOL) ?? []).at(-1);
  return {
    ...base,
    kind: "unconcluded",
    ended_by: endedBy,
    spent_all: spentAll,
    platform_side: endedBy === "output_limit" || input.thrown.length > 0,
    ...(input.thrown.length > 0 ? { failed: [...input.thrown] } : {}),
    wrote,
    ...(lastLog ? { logged: String(lastLog.input.action_taken ?? "") } : {}),
  };
}

const ENDED_BY_WORDS: Record<PassEndedBy, string> = {
  stopped: "it stopped",
  turn_guard: "it reached the turn guard",
  output_limit: "it was cut off at the output limit",
};

/** The judgment in force before the pass, in a reader's words. */
function priorWords(before: PriorJudgment | null): string {
  if (!before) return "The node still has no assessment.";
  const date = before.at ? ` of ${before.at.slice(0, 10)}` : "";
  return `The assessment${date} is unchanged by this pass.`;
}

/**
 * One plain clause on what a pass concluded, for the run_settled summary,
 * the order and the briefing: "recorded a new assessment (supported →
 * doubtful)", "concluded the assessment stands", "ended without recording
 * a conclusion (...)".
 */
export function outcomeClause(o: PassOutcome): string {
  const waitingToo = "also_waiting" in o && o.also_waiting ? " It is also waiting on what it asked for." : "";
  switch (o.kind) {
    case "recorded": {
      const what =
        o.tool === "publish_formalization"
          ? "recorded its decision on the formal statement"
          : o.tool === "decide_prize_claim"
            ? "decided the prize claim"
            : "recorded a new assessment";
      const from = o.before?.status ?? null;
      const move = o.status_after
        ? from
          ? from === o.status_after
            ? ` (${o.status_after}, as before)`
            : ` (${from} → ${o.status_after})`
          : ` (${o.status_after})`
        : "";
      return `${what}${move}.${waitingToo}`;
    }
    case "stood":
      return `concluded the assessment stands (logged: ${o.logged || "no_action_needed"}).${waitingToo}`;
    case "left_standing":
      return `left the assessment it reads at another label standing for this label.${waitingToo}`;
    case "logged":
      return `concluded with a logged decision (${o.logged}).${waitingToo}`;
    case "waiting":
      return "paused, waiting on what it asked for; it resumes when that is answered.";
    case "unconcluded":
      return `ended without recording a conclusion (${unconcludedWhy(o)}). ${priorWords(o.before)}`;
  }
}

/** How a pass that concluded nothing ended, and what it did on the way, in a reader's words. */
export function unconcludedWhy(o: Extract<PassOutcome, { kind: "unconcluded" }>): string {
  const why = [ENDED_BY_WORDS[o.ended_by]];
  if (o.failed && o.failed.length > 0) why.push(`${o.failed.map((f) => f.tool).join(", ")} failed with an error on the platform's side`);
  if (o.spent_all) why.push("budget fully spent");
  if (o.wrote.length > 0) why.push(`it wrote ${o.wrote.map((w) => `${w.tool} ×${w.n}`).join(", ")}`);
  if (o.logged) why.push(`its log says "${o.logged}", but nothing was recorded`);
  return why.join("; ");
}

/** Whether a person who paid for this pass gets their money back: the pass concluded nothing for a reason on the platform's side. */
export function refundsPayer(o: PassOutcome | null | undefined): boolean {
  return o?.kind === "unconcluded" && o.platform_side;
}
