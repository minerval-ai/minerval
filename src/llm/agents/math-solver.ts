/**
 * The solver (docs/mathematics.md §7): the platform's own prover, an
 * instrument rather than an administrator.
 *
 * It runs one bounded attempt on one published statement through the
 * long-run seam (client.ts longRunToolLoop): the strong model at the
 * variant's effort, fallbacks off, tools declared at run start and never
 * changed, a dollar ceiling read from the usage meter each turn, the
 * operator's kill switches polled each turn, and a terminal `report` tool
 * whose claims the harness verifies against the `lean_checks` rows the
 * server wrote. It writes the attempt's notebook, its check rows, and its
 * report, and nothing else: no claim, assessment, argument, relationship,
 * instance, contribution, or money table is touched here, and a unit test
 * holds that line. The Steward decides what a result means.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../config.js";
import { longRunToolLoop, type LongRunLoopState, type ToolCompletionResult } from "../client.js";
import { LlmRefusalError } from "../errors.js";
import { getUsageContext, withAgent } from "../usage-context.js";
import { getSkill, getSkillToolDefinitions } from "../prompts/skills.js";
import {
  buildMathSolverTaskMessage,
  getMathSolverSystemPromptBlocks,
  type SolverPriorAttemptInput,
} from "../prompts/math-solver.js";
import {
  getLeanCheckerClient,
  leanUsageCostMicroUsd,
  leanUsageModel,
  summarizeCheck,
  waitForCheck,
  LeanCheckerCapExceeded,
  LeanCheckerUnavailable,
  type CheckRecord,
  type LeanCheckerClient,
} from "../../services/lean-checker-client.js";
import { meterExternalUsage } from "../../services/usage-service.js";
import {
  findAttemptLeanCheck,
  findStoredAttemptCheck,
  readAttemptStatus,
  readSolverPaused,
  recordAttemptLeanCheck,
  stampAttemptRun,
  updateAttemptProgress,
  writeNotebookSection,
  readNotebook,
  NOTEBOOK_MAX_SECTION_CHARS,
  NOTEBOOK_MAX_SECTIONS,
  type AttemptRow,
  type FormalizationRow,
} from "../../services/attempt-service.js";
import type { AttemptOutcome } from "../../services/claim-extras-types.js";

type Tool = Anthropic.Tool;
type ToolUnion = Anthropic.Messages.ToolUnion;

export const SOLVER_AGENT = "math_solver";

/** Why the harness stopped the loop, as `hookStop` reports it. */
export const SOLVER_STOP_CEILING = "ceiling";
export const SOLVER_STOP_PAUSED = "paused";
export const SOLVER_STOP_CANCELLED = "cancelled";

/** The reminder fraction (§7.3): the wrap-up notice goes out at 85 percent of the ceiling. */
export const SOLVER_REMINDER_FRACTION = 0.85;

/** Model-facing pacing signal per variant (§7.3); the dollar ceiling binds either way. */
export const SOLVER_TASK_BUDGET_TOKENS: Record<"standard" | "max", number> = {
  standard: 800_000,
  max: 2_500_000,
};

/**
 * The published container rate for the code-execution tool, past the free
 * allowance: $0.05 per container-hour. The allowance is not tracked here,
 * so the meter errs on the side of counting it.
 */
export const CODE_EXECUTION_USD_PER_HOUR = 0.05;

export const WRAP_UP_NOTICE =
  "Harness notice: about fifteen percent of this attempt's budget remains. " +
  "Stop exploring. If you have a candidate proof or disproof, run lean_check on " +
  "it now; then write your notebook entry and call report. The harness stops " +
  "the attempt at the ceiling whether or not you have reported.";

export const REPORT_OUTCOMES: readonly string[] = [
  "proof",
  "disproof",
  "partial",
  "reduction",
  "negative",
];

/** The terminal tool's strict schema (§7.1). */
export const REPORT_TOOL: Tool = {
  name: "report",
  description:
    "End the attempt with your report. Call it exactly once: when you have a " +
    "checked proof or disproof, when you have exhausted the routes you can see, " +
    "or when the harness says the budget is nearly spent. A proof or disproof " +
    "outcome must name the lean_check_id of an accepted check from this attempt; " +
    "without one it is recorded as partial.",
  input_schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["proof", "disproof", "partial", "reduction", "negative"],
        description: "What the attempt produced.",
      },
      lean_proof: {
        type: ["string", "null"],
        description: "The Lean source of the accepted proof or disproof; null otherwise.",
      },
      lean_check_id: {
        type: ["string", "null"],
        description: "The lean_check_id of the accepted check; null otherwise.",
      },
      informal_argument: {
        type: "string",
        description: "The argument in prose a mathematician could follow.",
      },
      reduction_statement: {
        type: ["string", "null"],
        description: "The precise statement you reduced the problem to, if any.",
      },
      counterexample: {
        type: ["object", "null"],
        properties: {
          description: { type: "string" },
          verification_code: { type: "string" },
        },
        required: ["description", "verification_code"],
        additionalProperties: false,
        description: "A counterexample you found but could not formalize, with the code that verifies it.",
      },
      approaches_tried: {
        type: "array",
        items: { type: "string" },
        description: "One line per approach.",
      },
      obstruction: {
        type: "string",
        description: "The specific thing that stopped you.",
      },
      what_would_help: {
        type: "string",
        description: "The lemma, definition, or computation that would unblock the next attempt.",
      },
      confidence: {
        type: "number",
        description: "Your confidence in your own outcome, from 0 to 1.",
      },
    },
    required: [
      "outcome",
      "lean_proof",
      "lean_check_id",
      "informal_argument",
      "reduction_statement",
      "counterexample",
      "approaches_tried",
      "obstruction",
      "what_would_help",
      "confidence",
    ],
    additionalProperties: false,
  },
};

const NOTEBOOK_WRITE_TOOL: Tool = {
  name: "notebook_write",
  description:
    "Record your work under a section name (an approach, a lemma, a dead end). " +
    "Writing a section that exists replaces it. The notebook persists with the " +
    "attempt and is what the next attempt reads.",
  input_schema: {
    type: "object",
    properties: {
      section: { type: "string", description: "A short section name." },
      content: { type: "string", description: "The section's content." },
    },
    required: ["section", "content"],
    additionalProperties: false,
  },
};

const NOTEBOOK_READ_TOOL: Tool = {
  name: "notebook_read",
  description: "Return everything you have written to the notebook, by section.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

/**
 * The code-execution server tool: the computer-algebra toolkit (sympy and
 * mpmath are preinstalled; one CPU, no network, and it cannot run Lean).
 * The installed SDK types it on the Messages endpoint.
 */
export const CODE_EXECUTION_TOOL: Anthropic.Messages.CodeExecutionTool20260120 = {
  type: "code_execution_20260120",
  name: "code_execution",
};

// ---------------------------------------------------------------------------
// The report validator
// ---------------------------------------------------------------------------

export interface CheckLookupResult {
  id: string;
  verdict: string;
  kind: string;
  submissionSource: string;
}

export interface ValidatedReport {
  outcome: AttemptOutcome;
  /** The normalized report, with a `validation` block when anything was changed. */
  report: Record<string, unknown>;
  leanCheckId: string | null;
  leanProof: string | null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = asString(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Validate the report against the check rows this attempt wrote (§7.1): a
 * `proof` or `disproof` outcome needs a `lean_check_id` naming a row from
 * this attempt with `verdict = accepted` and the matching kind; without
 * one the outcome is downgraded to `partial` and the discrepancy recorded
 * on the report. The narrative is untrusted; the check rows are the record.
 */
export async function validateSolverReport(
  raw: Record<string, unknown>,
  lookupCheck: (leanCheckId: string) => Promise<CheckLookupResult | null>
): Promise<ValidatedReport> {
  const validation: Record<string, unknown> = {};
  let outcome = asString(raw.outcome).trim();
  if (!REPORT_OUTCOMES.includes(outcome)) {
    validation.invalid_outcome = outcome;
    outcome = "partial";
  }
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : 0;
  const approaches = Array.isArray(raw.approaches_tried)
    ? raw.approaches_tried.map((a) => asString(a))
    : [];
  const ce = raw.counterexample;
  const counterexample =
    ce && typeof ce === "object"
      ? {
          description: asString((ce as Record<string, unknown>).description),
          verification_code: asString((ce as Record<string, unknown>).verification_code),
        }
      : null;

  const report: Record<string, unknown> = {
    outcome,
    lean_proof: asNullableString(raw.lean_proof),
    lean_check_id: asNullableString(raw.lean_check_id),
    informal_argument: asString(raw.informal_argument),
    reduction_statement: asNullableString(raw.reduction_statement),
    counterexample,
    approaches_tried: approaches,
    obstruction: asString(raw.obstruction),
    what_would_help: asString(raw.what_would_help),
    confidence,
  };

  let leanCheckId: string | null = null;
  let leanProof: string | null = null;
  if (outcome === "proof" || outcome === "disproof") {
    const claimedId = report.lean_check_id as string | null;
    const check = claimedId ? await lookupCheck(claimedId) : null;
    let reason: string | null = null;
    if (!claimedId) reason = "no lean_check_id was given";
    else if (!check) reason = `lean_check_id ${claimedId} names no check this attempt wrote`;
    else if (check.verdict !== "accepted") reason = `check ${claimedId} has verdict ${check.verdict}`;
    else if (check.kind !== outcome) reason = `check ${claimedId} is a ${check.kind}, not a ${outcome}`;
    if (reason) {
      validation.downgraded_from = outcome;
      validation.reason = reason;
      if (claimedId) validation.claimed_lean_check_id = claimedId;
      outcome = "partial";
      report.outcome = outcome;
      report.lean_check_id = null;
    } else {
      leanCheckId = check!.id;
      leanProof = (report.lean_proof as string | null) ?? check!.submissionSource;
      report.lean_proof = leanProof;
    }
  }
  if (Object.keys(validation).length > 0) report.validation = validation;
  return { outcome: outcome as AttemptOutcome, report, leanCheckId, leanProof };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type MathSolverStatus = "completed" | "cancelled" | "refused" | "budget";

export interface MathSolverResult {
  status: MathSolverStatus;
  outcome: AttemptOutcome | null;
  report: Record<string, unknown> | null;
  leanProof: string | null;
  leanCheckId: string | null;
  turns: number;
  /** The loop's stop reason, or "refusal". */
  stopReason: string;
  hookStop?: string;
  servedModels: string[];
  error: string | null;
}

export interface MathSolverInput {
  attempt: Pick<
    AttemptRow,
    "id" | "claim_id" | "formalization_id" | "action_id" | "variant" | "effort" | "model" | "is_calibration"
  >;
  claim: { id: string; text: string };
  formalization: FormalizationRow;
  priorAttempts?: SolverPriorAttemptInput[];
  variant: "standard" | "max";
  effort: "high" | "max";
  ceilingMicroUsd: number;
  model?: string;
  /** Test seam: a checker client instead of the configured one (null = no checker). */
  checker?: LeanCheckerClient | null;
  /** Test seam: a clock. */
  now?: () => number;
}

interface TurnAccounting {
  reminded: boolean;
  servedModels: Set<string>;
  lastTurnEndedAt: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function meterMicroUsd(): number {
  return getUsageContext().meter?.billedMicroUsd ?? 0;
}

/** Cap the diagnostics a tool result carries; the full record stays on the row. */
const MAX_DIAGNOSTICS = 25;
const MAX_DIAGNOSTIC_CHARS = 600;
function trimDiagnostics(diagnostics: unknown): { diagnostics: unknown[]; truncated: boolean } {
  if (!Array.isArray(diagnostics)) return { diagnostics: [], truncated: false };
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => {
    if (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string") {
      const message = (d as { message: string }).message;
      return message.length > MAX_DIAGNOSTIC_CHARS
        ? { ...(d as object), message: `${message.slice(0, MAX_DIAGNOSTIC_CHARS)} […]` }
        : d;
    }
    return d;
  });
  return { diagnostics: shown, truncated: diagnostics.length > shown.length };
}

/** Container time metered from a turn's wall clock when it used code execution. */
function turnUsedCodeExecution(result: ToolCompletionResult): boolean {
  return result.rawContent.some((block) => {
    const type = (block as { type?: string }).type ?? "";
    const name = (block as { name?: string }).name ?? "";
    return (
      (type === "server_tool_use" && name === "code_execution") ||
      type === "code_execution_tool_result" ||
      type === "bash_code_execution_tool_result" ||
      type === "text_editor_code_execution_tool_result"
    );
  });
}

/**
 * Run one attempt. Enter through withAgent("math_solver") so every LLM,
 * Lean, and container row carries the agent, the run, and the attempt's
 * claim and job. Returns what the attempt produced; the worker closes the
 * row and completes the action.
 */
export async function runMathSolver(input: MathSolverInput): Promise<MathSolverResult> {
  return withAgent(SOLVER_AGENT, () => runMathSolverImpl(input));
}

async function runMathSolverImpl(input: MathSolverInput): Promise<MathSolverResult> {
  const config = loadConfig();
  const now = input.now ?? Date.now;
  const attempt = input.attempt;
  const model = input.model ?? attempt.model ?? config.solverModel;
  const runId = getUsageContext().runId ?? null;
  await stampAttemptRun(attempt.id, runId);

  const checker = input.checker === undefined ? getLeanCheckerClient() : input.checker;

  // Tools, declared once. The skill's definitions for lean_search and
  // lean_elaborate travel verbatim; lean_check is bound to this attempt's
  // statement, so the solver cannot check against another one.
  const skill = getSkill("mathematics");
  const skillTools = getSkillToolDefinitions(skill, "math-solver");
  const leanTools: Tool[] = checker
    ? skillTools
        .filter((t) => t.name === "lean_search" || t.name === "lean_elaborate" || t.name === "lean_check")
        .map((t) =>
          t.name === "lean_check"
            ? {
                name: "lean_check",
                description:
                  "Run a full cold-lane check of a candidate proof or disproof against " +
                  "this attempt's published statement (the statement is fixed; you " +
                  "cannot check against another). Returns the verdict, the gate that " +
                  "failed if any, and diagnostics. A timeout is a result (verdict " +
                  "\"error\"), not an exception. This is the only thing that counts as " +
                  "verification; the returned lean_check_id is what your report names.",
                input_schema: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["proof", "disproof"],
                      description: "Whether the artifact proves the statement or its negation.",
                    },
                    proof: { type: "string", description: "The full Lean source of the proof." },
                    replay: {
                      type: "string",
                      enum: ["module", "fresh"],
                      description: "\"module\" (default) replays against the compiled module; \"fresh\" rebuilds from the pinned toolchain.",
                    },
                    force: {
                      type: "boolean",
                      description: "Re-run even when a stored result for the identical proof exists.",
                    },
                  },
                  required: ["kind", "proof"],
                  additionalProperties: false,
                },
              }
            : t
        )
    : [];
  const tools: ToolUnion[] = [
    ...leanTools,
    CODE_EXECUTION_TOOL,
    NOTEBOOK_WRITE_TOOL,
    NOTEBOOK_READ_TOOL,
    REPORT_TOOL,
  ];

  const maxIterations = config.attemptMaxIterations;
  const maxWallMs = config.attemptMaxWallHours * 3_600_000;
  const taskMessage = buildMathSolverTaskMessage({
    canonicalForm: input.claim.text,
    statement: {
      id: input.formalization.id,
      version: input.formalization.version,
      namespace: input.formalization.namespace,
      statementSource: input.formalization.statement_source,
      pinId: input.formalization.pin_id,
      leanToolchain: input.formalization.lean_toolchain,
      mathlibRev: input.formalization.mathlib_rev,
      mathlibTag: input.formalization.mathlib_tag,
      sourceHash: input.formalization.source_hash,
      exprHash: input.formalization.expr_hash,
      correspondence: input.formalization.correspondence,
    },
    variant: input.variant,
    effort: input.effort,
    budget: { hours: config.attemptMaxWallHours, turns: maxIterations },
    priorAttempts: input.priorAttempts ?? [],
    toolsNote: checker
      ? null
      : "The formal tools (lean_search, lean_elaborate, lean_check) are unavailable " +
        "this run: no checker is configured. No outcome can be verified, so any proof " +
        "you find will be recorded as partial; report it with its full Lean source.",
  });

  // Per-attempt state the tools and hooks share.
  const notebook: Record<string, string> = await readNotebook(attempt.id);
  const checksThisAttempt = new Map<string, CheckLookupResult>();
  let leanChecks = 0;
  let leanElaborations = 0;
  let reportInput: Record<string, unknown> | null = null;
  const accounting: TurnAccounting = {
    reminded: false,
    servedModels: new Set<string>(),
    lastTurnEndedAt: now(),
  };
  const ceiling = Math.max(1, input.ceilingMicroUsd);

  const lookupCheck = async (leanCheckId: string): Promise<CheckLookupResult | null> => {
    const local = checksThisAttempt.get(leanCheckId);
    if (local) return local;
    const row = await findAttemptLeanCheck(attempt.id, leanCheckId);
    return row
      ? { id: row.id, verdict: row.verdict, kind: row.kind, submissionSource: row.submission_source }
      : null;
  };

  const leanUnavailable = (what: string, err: unknown): string =>
    JSON.stringify({
      success: false,
      message:
        `${what} failed (${err instanceof Error ? err.message : String(err)}). The checker ` +
        `is unavailable right now; continue with what you have, record the gap in your ` +
        `notebook, and try again later in the attempt.`,
    });

  const executeLeanSearch = async (toolInput: Record<string, unknown>): Promise<string> => {
    if (!checker) return JSON.stringify({ success: false, message: "No checker is configured." });
    const query = asString(toolInput.query).trim();
    if (!query) return JSON.stringify({ success: false, message: "query is required." });
    const backend = toolInput.backend === "natural" ? "natural" : "pattern";
    const limitRaw = Number(toolInput.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 10;
    try {
      const res = await checker.search({ query, backend, limit });
      await meterExternalUsage({
        provider: "lean",
        model: leanUsageModel(res.pin_id ?? input.formalization.pin_id),
        units: 1,
        unitKind: "call",
        costMicroUsd: leanUsageCostMicroUsd(undefined, config),
      });
      return JSON.stringify({
        success: res.ok,
        backend: res.backend ?? backend,
        hits: res.hits ?? [],
        note:
          res.note ??
          "A hosted index may run ahead of the pin; confirm a name with lean_elaborate before relying on it.",
        ...(res.message ? { message: res.message } : {}),
        ...(res.error ? { error: res.error } : {}),
      });
    } catch (err) {
      return leanUnavailable("lean_search", err);
    }
  };

  const executeLeanElaborate = async (toolInput: Record<string, unknown>): Promise<string> => {
    if (!checker) return JSON.stringify({ success: false, message: "No checker is configured." });
    const cap = config.solverLeanMaxElaborations;
    if (cap > 0 && leanElaborations >= cap) {
      return JSON.stringify({
        success: false,
        message:
          `This attempt has already elaborated ${leanElaborations} fragments, its cap (${cap}). ` +
          `Commit to a route with what you have checked, or run lean_check on a candidate.`,
      });
    }
    const source = asString(toolInput.statement);
    if (!source.trim()) return JSON.stringify({ success: false, message: "statement is required." });
    leanElaborations++;
    try {
      // The warm lane's scratch route: diagnostics for an arbitrary fragment
      // beside the attempt's statement, never a verdict.
      const res = await checker.scratch({
        source,
        statement_source: input.formalization.statement_source,
      });
      await meterExternalUsage({
        provider: "lean",
        model: leanUsageModel(res.pin?.pin_id ?? input.formalization.pin_id),
        units: res.resource?.wall_ms ?? 0,
        unitKind: "wall_ms",
        costMicroUsd: leanUsageCostMicroUsd(res.resource, config),
      });
      const { diagnostics, truncated } = trimDiagnostics(res.diagnostics);
      return JSON.stringify({
        success: true,
        ok: res.ok,
        error_count: res.error_count ?? (Array.isArray(res.diagnostics) ? res.diagnostics.length : 0),
        diagnostics,
        truncated: truncated || res.truncated === true,
        timed_out: res.timed_out === true,
        ...(res.error ? { error: res.error } : {}),
        elaborations_remaining: cap > 0 ? cap - leanElaborations : null,
      });
    } catch (err) {
      return leanUnavailable("lean_elaborate", err);
    }
  };

  const recordCheck = async (
    record: CheckRecord,
    kind: "proof" | "disproof",
    proof: string,
    cost: number
  ): Promise<CheckLookupResult> => {
    const verdict = record.verdict ?? "error";
    const row = await recordAttemptLeanCheck({
      attemptId: attempt.id,
      formalizationId: input.formalization.id,
      runId,
      kind,
      submissionSha256: record.submission_sha256 || sha256(proof),
      submissionSource: proof,
      verdict,
      checks: record.checks,
      diagnostics: record.diagnostics,
      truncated: record.truncated,
      resource: record.resource,
      pinId: record.pin_id,
      imageDigest: record.image_digest,
      checkerVersion: record.checker_version,
      costMicroUsd: cost,
      finishedAt: record.finished_at,
    });
    const info = { id: row.id, verdict: row.verdict, kind: row.kind, submissionSource: proof };
    checksThisAttempt.set(row.id, info);
    return info;
  };

  const executeLeanCheck = async (toolInput: Record<string, unknown>): Promise<string> => {
    if (!checker) return JSON.stringify({ success: false, message: "No checker is configured." });
    const cap = config.solverLeanMaxChecks;
    if (cap > 0 && leanChecks >= cap) {
      return JSON.stringify({
        success: false,
        message:
          `This attempt has used ${leanChecks} of its ${cap} proof checks. No further check ` +
          `can run: write your report on the checks already recorded.`,
      });
    }
    const kind = toolInput.kind === "disproof" ? "disproof" : toolInput.kind === "proof" ? "proof" : null;
    const proof = asString(toolInput.proof);
    if (!kind) return JSON.stringify({ success: false, message: 'kind must be "proof" or "disproof".' });
    if (!proof.trim()) return JSON.stringify({ success: false, message: "proof is required." });
    const replay = toolInput.replay === "fresh" ? "fresh" : "module";
    const force = toolInput.force === true;
    const hash = sha256(proof);

    if (!force) {
      const stored = await findStoredAttemptCheck(input.formalization.id, hash);
      if (stored && stored.kind === kind) {
        const info = {
          id: stored.id,
          verdict: stored.verdict,
          kind: stored.kind,
          submissionSource: stored.submission_source,
        };
        if (stored.attempt_id === attempt.id) checksThisAttempt.set(stored.id, info);
        const { diagnostics, truncated } = trimDiagnostics(stored.diagnostics);
        return JSON.stringify({
          success: true,
          lean_check_id: stored.id,
          verdict: stored.verdict,
          stored: true,
          own: stored.attempt_id === attempt.id,
          checks: stored.checks,
          diagnostics,
          truncated: truncated || stored.truncated,
          message:
            "An identical proof was checked before; this is the stored result. Pass " +
            "force: true to re-run it.",
        });
      }
    }

    leanChecks++;
    try {
      const submitted = await checker.submitCheck({
        mode: "attempt",
        kind,
        statement_source: input.formalization.statement_source,
        submission_source: proof,
        replay,
        force,
      });
      const record = submitted.status === "done" ? submitted : await waitForCheck(checker, submitted.check_id);
      const cost = leanUsageCostMicroUsd(record.resource, config);
      await meterExternalUsage({
        provider: "lean",
        model: leanUsageModel(record.pin_id),
        units: record.resource?.wall_ms ?? 0,
        unitKind: "wall_ms",
        costMicroUsd: cost,
      });
      const info = await recordCheck(record, kind, proof, cost);
      const { diagnostics, truncated } = trimDiagnostics(record.diagnostics);
      return JSON.stringify({
        success: true,
        lean_check_id: info.id,
        verdict: record.verdict,
        failed_gate: record.failed_gate,
        summary: summarizeCheck(record),
        checks: record.checks,
        diagnostics,
        truncated: truncated || record.truncated,
        resource: record.resource,
        checks_remaining: cap > 0 ? cap - leanChecks : null,
      });
    } catch (err) {
      if (err instanceof LeanCheckerCapExceeded) {
        return JSON.stringify({
          success: false,
          message:
            `The checker refused the job for the day (${err.message}). No check can run ` +
            `until tomorrow; write your report with the proof source and say it is unchecked.`,
        });
      }
      if (err instanceof LeanCheckerUnavailable) return leanUnavailable("lean_check", err);
      return leanUnavailable("lean_check", err);
    }
  };

  const executeNotebookWrite = async (toolInput: Record<string, unknown>): Promise<string> => {
    const section = asString(toolInput.section).trim().slice(0, 200);
    const content = asString(toolInput.content);
    if (!section) return JSON.stringify({ success: false, message: "section is required." });
    if (content.length > NOTEBOOK_MAX_SECTION_CHARS) {
      return JSON.stringify({
        success: false,
        message: `A section holds at most ${NOTEBOOK_MAX_SECTION_CHARS} characters; split it.`,
      });
    }
    if (!(section in notebook) && Object.keys(notebook).length >= NOTEBOOK_MAX_SECTIONS) {
      return JSON.stringify({
        success: false,
        message: `The notebook holds at most ${NOTEBOOK_MAX_SECTIONS} sections; rewrite one.`,
      });
    }
    notebook[section] = content;
    await writeNotebookSection(attempt.id, section, content);
    return JSON.stringify({ success: true, section, sections: Object.keys(notebook) });
  };

  const executeNotebookRead = async (): Promise<string> =>
    JSON.stringify({ success: true, notebook });

  const executeTool = async (name: string, toolInput: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "lean_search":
        return executeLeanSearch(toolInput);
      case "lean_elaborate":
        return executeLeanElaborate(toolInput);
      case "lean_check":
        return executeLeanCheck(toolInput);
      case "notebook_write":
        return executeNotebookWrite(toolInput);
      case "notebook_read":
        return executeNotebookRead();
      case "report":
        // The loop stops on the final tool before executing it; a second
        // report in the same turn is answered, not acted on.
        return JSON.stringify({ success: false, message: "report was already received." });
      default:
        return JSON.stringify({ success: false, message: `Unknown tool: ${name}` });
    }
  };

  const beforeTurn = async (_state: LongRunLoopState): Promise<{ stop?: string } | void> => {
    if (meterMicroUsd() >= ceiling) return { stop: SOLVER_STOP_CEILING };
    if (await readSolverPaused()) return { stop: SOLVER_STOP_PAUSED };
    const status = await readAttemptStatus(attempt.id);
    if (status === "cancelling") return { stop: SOLVER_STOP_CANCELLED };
    return undefined;
  };

  const reminder = (_state: LongRunLoopState): string | null => {
    if (accounting.reminded) return null;
    if (meterMicroUsd() < SOLVER_REMINDER_FRACTION * ceiling) return null;
    accounting.reminded = true;
    return WRAP_UP_NOTICE;
  };

  const afterTurn = async (state: LongRunLoopState, result: ToolCompletionResult): Promise<void> => {
    const served = result.servedModel ?? result.model;
    if (served) accounting.servedModels.add(served);
    const endedAt = now();
    if (turnUsedCodeExecution(result)) {
      const seconds = Math.max(0, (endedAt - accounting.lastTurnEndedAt) / 1000);
      await meterExternalUsage({
        provider: "anthropic_code_execution",
        model: "anthropic/code_execution",
        units: seconds,
        unitKind: "container_seconds",
        costMicroUsd: (seconds / 3600) * CODE_EXECUTION_USD_PER_HOUR * 1_000_000,
      });
    }
    accounting.lastTurnEndedAt = endedAt;
    await updateAttemptProgress({
      attemptId: attempt.id,
      actionId: attempt.action_id,
      turns: state.turn,
      spentMicroUsd: meterMicroUsd(),
      servedModels: [...accounting.servedModels],
    });
  };

  const base = {
    turns: 0,
    servedModels: [] as string[],
    leanProof: null,
    leanCheckId: null,
    report: null,
    outcome: null,
    error: null,
  };

  let loop;
  try {
    loop = await longRunToolLoop({
      initialMessages: [{ role: "user", content: taskMessage }],
      tools,
      system: getMathSolverSystemPromptBlocks(),
      model,
      effort: input.effort,
      taskBudgetTokens: SOLVER_TASK_BUDGET_TOKENS[input.variant],
      fallbacks: "none",
      maxIterations,
      maxWallMs,
      executeTool,
      onFinalTool: (name, toolInput) => {
        if (name !== "report") return null;
        reportInput = toolInput;
        return toolInput;
      },
      beforeTurn,
      afterTurn,
      reminder,
    });
  } catch (err) {
    if (err instanceof LlmRefusalError) {
      return {
        ...base,
        status: "refused",
        stopReason: "refusal",
        servedModels: [...accounting.servedModels],
        error: err.message,
      };
    }
    throw err;
  }

  const servedModels = [...accounting.servedModels];
  const turns = loop.turns;

  if (reportInput) {
    const validated = await validateSolverReport(reportInput, lookupCheck);
    return {
      status: "completed",
      outcome: validated.outcome,
      report: { ...validated.report, harness: { stop_reason: loop.stopReason, turns } },
      leanProof: validated.leanProof,
      leanCheckId: validated.leanCheckId,
      turns,
      stopReason: loop.stopReason,
      servedModels,
      error: null,
    };
  }

  if (loop.stopReason === "hook") {
    const hookStop = loop.hookStop ?? "";
    if (hookStop === SOLVER_STOP_CEILING) {
      return {
        ...base,
        status: "budget",
        turns,
        stopReason: loop.stopReason,
        hookStop,
        servedModels,
        error: "the attempt reached its cost ceiling before reporting",
      };
    }
    return {
      ...base,
      status: "cancelled",
      turns,
      stopReason: loop.stopReason,
      hookStop,
      servedModels,
      error:
        hookStop === SOLVER_STOP_PAUSED
          ? "the solver was paused by the operator"
          : "the attempt was cancelled by the operator",
    };
  }

  // The model stopped (end of turn, the iteration or wall cap, or a doubly
  // truncated turn) without a report: a closed attempt with nothing to show.
  return {
    ...base,
    status: "completed",
    outcome: "none",
    report: {
      outcome: "none",
      harness: { stop_reason: loop.stopReason, turns, note: "the solver ended without calling report" },
    },
    turns,
    stopReason: loop.stopReason,
    servedModels,
    error: `the solver ended (${loop.stopReason}) without calling report`,
  };
}
