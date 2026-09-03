/**
 * Executors for the Lean tools the Mathematics skill declares in
 * skills/mathematics/tools.json (docs/mathematics.md §6.1): lean_search,
 * lean_elaborate, lean_check, and publish_formalization, over the checker
 * client. The contract mirrors the Elicit adapter's: always a JSON string,
 * a checker that cannot be reached is a structured result the agent routes
 * around (§20), and a check that times out is a verdict of `error`, never
 * an exception that kills the run.
 *
 * Every call meters real money (§6.3) from the checker's own wall time, so
 * the cost lands on the action that asked.
 */
import { loadConfig } from "../../config.js";
import { rawQuery } from "../../db/client.js";
import {
  getLeanCheckerClient,
  LeanCheckerUnavailable,
  leanUsageCostMicroUsd,
  leanUsageModel,
  summarizeCheck,
  waitForCheck,
  type CheckKind,
  type CheckMode,
  type CheckRecord,
  type LeanCheckerClient,
  type PinInfo,
} from "../../services/lean-checker-client.js";
import { meterExternalUsage } from "../../services/usage-service.js";
import {
  findLeanCheck,
  formalizationSummary,
  getFormalizationById,
  nextFormalizationVersion,
  normalizeStatementSource,
  publishFormalization,
  recordLeanCheck,
  returnFormalizationToDraft,
  sha256,
  storeElaboratedFormalization,
  type LeanCheckRow,
} from "../../services/formalization-service.js";
import { getUsageContext } from "../usage-context.js";
import type { SkillToolContext, SkillToolExecutor } from "./skill-tools.js";

export const LEAN_TOOL_NAMES = [
  "lean_search",
  "lean_elaborate",
  "lean_check",
  "publish_formalization",
] as const;

export type LeanToolName = (typeof LEAN_TOOL_NAMES)[number];

export function isLeanTool(name: string): name is LeanToolName {
  return (LEAN_TOOL_NAMES as readonly string[]).includes(name);
}

/** The trigger whose run is the fresh-context reviewer (§5.4, layer 2). */
export const FORMALIZATION_REVIEW_TRIGGER = "formalization_review";

/**
 * How lean_check polls a cold-lane job. Mutable so a test can shorten the
 * wait; production keeps the checker client's defaults.
 */
export const leanCheckPolling: { pollMs: number; timeoutMs: number } = {
  pollMs: 2_000,
  timeoutMs: 20 * 60_000,
};

const NOT_CONFIGURED = JSON.stringify({
  success: false,
  message: "Lean tools are not configured in this deployment.",
});

/** How many diagnostics a tool result carries; the row keeps them all. */
const MAX_DIAGNOSTICS_IN_RESULT = 50;

function unavailable(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return JSON.stringify({
    success: false,
    unavailable: true,
    message:
      `The Lean checker is unavailable (${detail}). Assess on the informal ` +
      `evidence, and record in your reasoning trace that formal verification ` +
      `was unavailable for this run.`,
  });
}

function refuse(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: false, message, ...extra });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function meterLean(
  pinId: string,
  resource: { wall_ms?: number } | undefined,
  fallbackWallMs: number
): Promise<void> {
  const wallMs = Math.max(0, resource?.wall_ms ?? fallbackWallMs);
  await meterExternalUsage({
    provider: "lean",
    model: leanUsageModel(pinId),
    units: wallMs,
    unitKind: "wall_ms",
    costMicroUsd: leanUsageCostMicroUsd({ ...(resource ?? {}), wall_ms: wallMs }),
  });
}

function actorFor(ctx: SkillToolContext): { submittedBy: string; mode: CheckMode } {
  return ctx.role === "math-solver"
    ? { submittedBy: "math_solver", mode: "attempt" }
    : { submittedBy: "claim_steward", mode: "steward" };
}

function storedCheckResult(row: LeanCheckRow, deduplicated: boolean): string {
  const checks = (row.checks ?? {}) as Record<string, { status?: string; detail?: string }>;
  const failedGate =
    row.verdict === "rejected"
      ? (Object.entries(checks).find(([, g]) => g?.status === "fail")?.[0] ?? null)
      : null;
  const summary =
    row.verdict === "accepted"
      ? "accepted: every gate passed"
      : row.verdict === "rejected"
        ? `rejected at the ${failedGate ?? "unknown"} gate${
            failedGate && checks[failedGate]?.detail ? `: ${checks[failedGate]!.detail}` : ""
          }`
        : "error: the checker could not decide";
  return JSON.stringify({
    success: true,
    lean_check_id: row.id,
    verdict: row.verdict,
    summary,
    failed_gate: failedGate,
    checks,
    kind: row.kind,
    mode: row.mode,
    pin_id: row.pin_id,
    checker_version: row.checker_version,
    submission_sha256: row.submission_sha256,
    deduplicated,
    message: deduplicated
      ? `An identical submission was already checked under this checker version and mode; ` +
        `this is the stored verdict (recorded ${
          (row.finished_at ?? row.created_at).toISOString()
        }). Pass force: true to run it again.` +
        (row.verdict === "error"
          ? " The stored verdict is an error, which is no evidence at all; re-run with force before relying on it."
          : "")
      : "Verdict recorded.",
  });
}

async function pinFor(
  client: LeanCheckerClient,
  pinId: string
): Promise<PinInfo> {
  try {
    const { pins } = await client.pins();
    const match = pins.find((p) => p.pin_id === pinId);
    if (match) return match;
  } catch {
    // Fall through to the health pin; an older checker may not serve /v1/pins.
  }
  const health = await client.health();
  return health.pin;
}

function checkResult(record: CheckRecord, leanCheckId: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    lean_check_id: leanCheckId,
    check_id: record.check_id,
    verdict: record.verdict ?? "error",
    summary: summarizeCheck(record),
    failed_gate: record.failed_gate,
    error_reason: record.error_reason,
    checks: record.checks,
    diagnostics: (record.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS_IN_RESULT),
    truncated:
      Boolean(record.truncated) ||
      (record.diagnostics?.length ?? 0) > MAX_DIAGNOSTICS_IN_RESULT,
    resource: record.resource,
    kind: record.kind,
    mode: record.mode,
    replay: record.replay,
    pin_id: record.pin_id,
    checker_version: record.checker_version,
    submission_sha256: record.submission_sha256,
    deduplicated: Boolean(record.deduplicated),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// lean_search
// ---------------------------------------------------------------------------

async function leanSearch(input: Record<string, unknown>): Promise<string> {
  const client = getLeanCheckerClient();
  if (!client) return NOT_CONFIGURED;
  const query = str(input.query);
  if (!query) return refuse("lean_search needs a query.");
  const backend = input.backend === "natural" ? "natural" : "pattern";
  const limitRaw = Number(input.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 10;
  const started = Date.now();
  try {
    const res = await client.search({ query, backend, limit });
    const pinId = res.pin_id ?? (await client.health()).pin.pin_id;
    await meterLean(pinId, undefined, Date.now() - started);
    if (!res.ok) {
      return refuse(
        `Mathlib search is not available for backend "${backend}" ` +
          `(${res.error ?? res.message ?? "no detail"}). Work from the names you know, ` +
          `and confirm each with lean_elaborate before relying on it.`,
        { backend }
      );
    }
    return JSON.stringify({
      success: true,
      backend: res.backend ?? backend,
      hits: res.hits.slice(0, limit),
      pin_id: pinId,
      note:
        res.note ??
        "A hosted index may run ahead of the pin; a name that appears here exists at the pin only if lean_elaborate accepts it.",
    });
  } catch (err) {
    if (err instanceof LeanCheckerUnavailable) return unavailable(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// lean_elaborate
// ---------------------------------------------------------------------------

async function leanElaborate(input: Record<string, unknown>): Promise<string> {
  const client = getLeanCheckerClient();
  if (!client) return NOT_CONFIGURED;
  const statement = typeof input.statement === "string" ? input.statement : "";
  if (!statement.trim()) return refuse("lean_elaborate needs the statement source.");
  try {
    const res = await client.elaborate({ statement_source: statement });
    await meterLean(res.pin.pin_id, res.resource, 0);
    const note = str(input.note) || undefined;
    if (!res.ok) {
      return JSON.stringify({
        success: false,
        ok: false,
        errors: res.errors,
        diagnostics: (res.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS_IN_RESULT),
        truncated: res.truncated,
        timed_out: Boolean(res.timed_out),
        warnings: res.warnings ?? [],
        pin_id: res.pin.pin_id,
        note,
        message:
          "The statement did not elaborate. Fix the errors at the positions given and elaborate again; " +
          "nothing that fails here can be recorded.",
      });
    }
    return JSON.stringify({
      success: true,
      ok: true,
      namespace: res.namespace,
      pp_type: res.pp_type,
      expr_hash: res.expr_hash,
      source_hash: res.source_hash,
      constants: res.constants ?? [],
      definitions: res.definitions ?? [],
      definitions_axioms: res.definitions_axioms ?? {},
      statement_axioms: res.statement_axioms ?? [],
      witness_present: res.witness_present,
      warnings: res.warnings ?? [],
      diagnostics: (res.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS_IN_RESULT),
      truncated: res.truncated,
      pin: res.pin,
      note,
      message:
        "The statement type-checks at the pin. Elaboration says nothing about fidelity: " +
        "read it against the vacuity checklist before recording it with publish_formalization.",
    });
  } catch (err) {
    if (err instanceof LeanCheckerUnavailable) return unavailable(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// lean_check
// ---------------------------------------------------------------------------

async function resolveSubmission(
  input: Record<string, unknown>,
  formalizationId: string
): Promise<{ source: string; kind: CheckKind | null; attemptId: string | null } | { error: string }> {
  const proof = typeof input.proof === "string" ? input.proof : "";
  if (proof.trim()) return { source: proof, kind: null, attemptId: null };

  const leanCheckId = str(input.lean_check_id);
  if (leanCheckId) {
    const [row] = await rawQuery<{
      submission_source: string;
      kind: CheckKind;
      formalization_id: string;
      attempt_id: string | null;
    }>(
      `SELECT submission_source, kind, formalization_id, attempt_id
         FROM lean_checks WHERE id = $1`,
      [leanCheckId]
    );
    if (!row) return { error: `No lean_checks row ${leanCheckId} exists.` };
    if (row.formalization_id !== formalizationId) {
      return {
        error:
          `lean_checks row ${leanCheckId} was checked against formalization ` +
          `${row.formalization_id}, not ${formalizationId}.`,
      };
    }
    return { source: row.submission_source, kind: row.kind, attemptId: row.attempt_id };
  }

  const attemptId = str(input.attempt_id);
  if (attemptId) {
    const [row] = await rawQuery<{
      lean_proof: string | null;
      formalization_id: string;
      outcome: string | null;
    }>(
      `SELECT lean_proof, formalization_id, outcome FROM proof_attempts WHERE id = $1`,
      [attemptId]
    );
    if (!row) return { error: `No proof attempt ${attemptId} exists.` };
    if (row.formalization_id !== formalizationId) {
      return {
        error:
          `Attempt ${attemptId} ran against formalization ${row.formalization_id}, ` +
          `not ${formalizationId}.`,
      };
    }
    if (!row.lean_proof || !row.lean_proof.trim()) {
      return {
        error:
          `Attempt ${attemptId} left no Lean artifact to check` +
          (row.outcome ? ` (its outcome was ${row.outcome})` : "") +
          `.`,
      };
    }
    return {
      source: row.lean_proof,
      kind: row.outcome === "disproof" ? "disproof" : null,
      attemptId,
    };
  }
  return { error: "lean_check needs the proof text, a lean_check_id, or an attempt_id." };
}

async function leanCheck(
  input: Record<string, unknown>,
  ctx: SkillToolContext
): Promise<string> {
  const client = getLeanCheckerClient();
  if (!client) return NOT_CONFIGURED;
  const formalizationId = str(input.formalization_id);
  if (!formalizationId) return refuse("lean_check needs the formalization_id of the stored statement.");
  const kindInput = str(input.kind);
  if (kindInput && kindInput !== "proof" && kindInput !== "disproof") {
    return refuse(`kind must be "proof" or "disproof", not "${kindInput}".`);
  }
  const replay = input.replay === "fresh" ? "fresh" : "module";
  const force = input.force === true;

  const formalization = await getFormalizationById(formalizationId);
  if (!formalization) return refuse(`No formalization ${formalizationId} exists.`);
  if (ctx.claimId && formalization.claim_id !== ctx.claimId) {
    return refuse(
      `Formalization ${formalizationId} belongs to claim ${formalization.claim_id}, ` +
        `not the claim this run serves.`
    );
  }

  const submission = await resolveSubmission(input, formalizationId);
  if ("error" in submission) return refuse(submission.error);
  const kind = (kindInput || submission.kind || "proof") as CheckKind;
  const { submittedBy, mode } = actorFor(ctx);
  const submissionSha = sha256(submission.source);
  const runId = getUsageContext().runId ?? null;

  try {
    // Dedup by hash under the statement's pin (§6.1): an identical
    // submission under the same checker version and mode is the stored row.
    const pin = await pinFor(client, formalization.pin_id);
    if (!force) {
      const stored = await findLeanCheck({
        formalizationId,
        submissionSha256: submissionSha,
        checkerVersion: pin.checker_version,
        mode,
      });
      if (stored) return storedCheckResult(stored, true);
    }

    let record = await client.submitCheck({
      mode,
      kind,
      statement_source: formalization.statement_source,
      submission_source: submission.source,
      replay,
      force,
    });
    if (record.status !== "done") {
      try {
        record = await waitForCheck(client, record.check_id, {
          pollMs: leanCheckPolling.pollMs,
          timeoutMs: leanCheckPolling.timeoutMs,
        });
      } catch (err) {
        if (!(err instanceof LeanCheckerUnavailable)) throw err;
        // A timeout is a result, not an exception (§6.2): no verdict, no
        // row (an error row would be returned as "stored" by the next
        // identical call), and the checker keeps the job so the same call
        // later returns the finished record.
        await meterLean(record.pin_id, record.resource, 0);
        return JSON.stringify({
          success: true,
          lean_check_id: null,
          check_id: record.check_id,
          verdict: "error",
          summary: `error: ${err.message}`,
          error_reason: err.message,
          kind,
          mode,
          replay,
          pin_id: record.pin_id,
          submission_sha256: submissionSha,
          message:
            "The check did not finish in time. An error is no evidence either way; " +
            "assess on what is already recorded, and note in your reasoning that " +
            "the check was not completed. The same call later returns the verdict " +
            "once the checker finishes.",
        });
      }
    }

    await meterLean(record.pin_id, record.resource, 0);
    const row = await recordLeanCheck({
      formalizationId,
      record,
      submissionSource: submission.source,
      submittedBy,
      attemptId: submission.attemptId,
      runId,
    });
    return checkResult(record, row.id, {
      second_opinion:
        input.second_opinion === true
          ? "no outside checker is configured in this deployment; the verdict rests on the platform checker alone"
          : null,
      message:
        record.verdict === "accepted"
          ? "The kernel accepted the submission against the stored statement. Fidelity of the statement to the claim remains your judgment."
          : record.verdict === "rejected"
            ? "The submission was rejected on the merits; a rejected disproof is not evidence for the statement."
            : "The checker could not decide; an error is no evidence at all.",
    });
  } catch (err) {
    if (err instanceof LeanCheckerUnavailable) return unavailable(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// publish_formalization
// ---------------------------------------------------------------------------

async function publishFormalizationTool(
  input: Record<string, unknown>,
  ctx: SkillToolContext
): Promise<string> {
  const client = getLeanCheckerClient();
  if (!client) return NOT_CONFIGURED;
  const claimId = str(input.claim_id) || ctx.claimId || "";
  if (!claimId) return refuse("publish_formalization needs the claim_id.");
  if (ctx.claimId && claimId !== ctx.claimId) {
    return refuse(`This run serves claim ${ctx.claimId}; it cannot record a statement for ${claimId}.`);
  }
  const statementSource = typeof input.statement_source === "string" ? input.statement_source : "";
  const correspondence = str(input.correspondence);
  const reviewNotes = str(input.review_notes);
  const runId = getUsageContext().runId ?? null;
  const model = ctx.run?.model ?? null;

  if (input.confirm !== undefined || str(input.formalization_id)) {
    return confirmFormalization(input, ctx, client, {
      claimId,
      statementSource,
      reviewNotes,
      runId,
    });
  }

  if (!correspondence) {
    return refuse(
      "The correspondence note is required: say, in the graph's voice, how the formal " +
        "and informal statements relate and what the formal one leaves out."
    );
  }
  if (!reviewNotes) {
    return refuse("The review notes are required: what you checked for vacuity and fidelity, and what you found.");
  }
  if (!statementSource.trim()) return refuse("The statement source is required.");

  const [claim] = await rawQuery<{ id: string; state: string }>(
    `SELECT id, state FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!claim) return refuse(`No claim ${claimId} exists.`);
  if (claim.state !== "active") {
    return refuse(`Claim ${claimId} is ${claim.state}; only an active claim carries a formal statement.`);
  }

  const version = await nextFormalizationVersion(claimId);
  const normalized = normalizeStatementSource(statementSource, { claimId, version });
  if (!normalized.ok) return refuse(normalized.error);

  try {
    const elaboration = await client.elaborate({ statement_source: normalized.source });
    await meterLean(elaboration.pin.pin_id, elaboration.resource, 0);
    if (!elaboration.ok) {
      return JSON.stringify({
        success: false,
        errors: elaboration.errors,
        diagnostics: (elaboration.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS_IN_RESULT),
        warnings: elaboration.warnings ?? [],
        statement_source: normalized.source,
        message:
          "Refused: the statement does not elaborate as it would be stored, so nothing was recorded. " +
          "Fix the errors, elaborate again with lean_elaborate, and call publish_formalization with the corrected source.",
      });
    }
    const row = await storeElaboratedFormalization({
      claimId,
      statementSource: normalized.source,
      version,
      elaboration,
      correspondence,
      reviewNotes,
      authoredBy: "claim_steward",
      model,
      runId,
      status: "reviewed",
    });
    return JSON.stringify({
      success: true,
      formalization_id: row.id,
      version: row.version,
      status: row.status,
      namespace: row.namespace,
      pin_id: row.pin_id,
      pp_type: row.pp_type,
      source_hash: row.source_hash,
      expr_hash: row.expr_hash,
      witness_present: row.witness_present,
      warnings: elaboration.warnings ?? [],
      statement_source: row.statement_source,
      message:
        `Recorded version ${row.version} as reviewed (${row.namespace}). It is not published: ` +
        `a second Steward pass in a fresh context reviews it and either publishes it or returns it ` +
        `to draft with notes. Log your decision; do not call publish_formalization again in this run.`,
    });
  } catch (err) {
    if (err instanceof LeanCheckerUnavailable) return unavailable(err);
    throw err;
  }
}

async function confirmFormalization(
  input: Record<string, unknown>,
  ctx: SkillToolContext,
  client: LeanCheckerClient,
  args: { claimId: string; statementSource: string; reviewNotes: string; runId: string | null }
): Promise<string> {
  const formalizationId = str(input.formalization_id);
  if (!formalizationId) {
    return refuse("confirm needs the formalization_id of the reviewed row.");
  }
  if (ctx.run?.trigger !== FORMALIZATION_REVIEW_TRIGGER) {
    return refuse(
      `Publication is decided by the fresh-context review pass (trigger ${FORMALIZATION_REVIEW_TRIGGER}); ` +
        `this run's trigger is ${ctx.run?.trigger ?? "unknown"}. Record the statement without confirm ` +
        `and leave publication to that pass.`
    );
  }
  const row = await getFormalizationById(formalizationId);
  if (!row) return refuse(`No formalization ${formalizationId} exists.`);
  if (row.claim_id !== args.claimId) {
    return refuse(`Formalization ${formalizationId} belongs to claim ${row.claim_id}, not ${args.claimId}.`);
  }
  if (row.status !== "reviewed") {
    return refuse(
      `Formalization ${formalizationId} is ${row.status}; only a reviewed statement is published or returned to draft.`
    );
  }

  if (input.confirm === false) {
    if (!args.reviewNotes) {
      return refuse("Returning a statement to draft needs review_notes saying what is wrong with it.");
    }
    const updated = await returnFormalizationToDraft(formalizationId, {
      reviewNotes: args.reviewNotes,
      runId: args.runId,
    });
    return JSON.stringify({
      success: true,
      formalization_id: updated.id,
      version: updated.version,
      status: updated.status,
      message:
        `Version ${updated.version} returned to draft with your notes. A later formalize pass ` +
        `starts from them; nothing is published.`,
    });
  }
  if (input.confirm !== true) {
    return refuse("confirm must be true (publish) or false (return to draft with review_notes).");
  }

  // The reviewer may pass the statement back; it must be the reviewed text.
  if (args.statementSource.trim()) {
    const normalized = normalizeStatementSource(args.statementSource, {
      claimId: args.claimId,
      version: row.version,
    });
    if (!normalized.ok || normalized.source !== row.statement_source) {
      return refuse(
        "The statement you passed is not the reviewed text. The review pass publishes the " +
          "reviewed statement as recorded or returns it to draft with notes; it does not " +
          "publish an edited one. Call again with confirm: false and review_notes if it needs changing."
      );
    }
  }

  try {
    // Re-elaborate the stored text under the pin before it goes public: a
    // statement that no longer elaborates, or elaborates differently, is
    // not the one that was reviewed.
    const elaboration = await client.elaborate({ statement_source: row.statement_source });
    await meterLean(elaboration.pin.pin_id, elaboration.resource, 0);
    if (!elaboration.ok) {
      return JSON.stringify({
        success: false,
        errors: elaboration.errors,
        message:
          "Refused: the reviewed statement no longer elaborates under the pin, so it cannot be published. " +
          "Return it to draft with notes (confirm: false).",
      });
    }
    if (elaboration.expr_hash !== row.expr_hash) {
      return refuse(
        "Refused: the statement elaborates to a different proposition than when it was reviewed " +
          `(expr_hash ${elaboration.expr_hash} vs ${row.expr_hash}). Return it to draft with notes.`
      );
    }
    const { published, retired } = await publishFormalization(formalizationId, {
      runId: args.runId,
      reviewNotes: args.reviewNotes || null,
    });
    const summary = formalizationSummary(published);
    return JSON.stringify({
      success: true,
      ...summary,
      formalization_id: published.id,
      retired: retired.map((r) => ({ id: r.id, version: r.version })),
      message:
        `Version ${published.version} is published; its review period ends ${summary.review_period_ends_at}. ` +
        (retired.length > 0
          ? `Version ${retired.map((r) => r.version).join(", ")} was retired as superseded. `
          : "") +
        `No bounty binds to it before the period ends.`,
    });
  } catch (err) {
    if (err instanceof LeanCheckerUnavailable) return unavailable(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EXECUTORS: Record<LeanToolName, SkillToolExecutor> = {
  lean_search: (input) => leanSearch(input),
  lean_elaborate: (input) => leanElaborate(input),
  lean_check: (input, ctx) => leanCheck(input, ctx),
  publish_formalization: (input, ctx) => publishFormalizationTool(input, ctx),
};

/** Run one Lean tool by name; the registry's error wrapping applies on top. */
export async function executeLeanTool(
  name: LeanToolName,
  input: Record<string, unknown>,
  ctx: SkillToolContext
): Promise<string> {
  return EXECUTORS[name](input, ctx);
}

export function registerLeanTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  for (const name of LEAN_TOOL_NAMES) {
    register(name, EXECUTORS[name]);
  }
}

/** Whether the deployment's checker is set up, for callers that gate a toolset. */
export function leanToolsAvailable(): boolean {
  return getLeanCheckerClient(loadConfig()) !== null;
}
