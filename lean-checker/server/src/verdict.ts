/**
 * The verdict rule of design section 5.2, as one pure function over the raw
 * step results a runner returns.
 *
 * Gates, in order:
 *   1. static_policy and compile (the source passes the static policy and
 *      compiles with zero `error` diagnostics),
 *   2. target (exists, is a theorem, no universe parameters, type
 *      alpha-equivalent to the statement constant or its negation),
 *   3. axioms (closure within propext, Classical.choice, Quot.sound; no new
 *      axiomInfo or opaqueInfo),
 *   4. declarations (no unsafe, partial, implemented_by, extern, csimp),
 *   5. replay (the new declarations replay through the kernel).
 *
 * `accepted` needs every gate to pass. `rejected` is the first gate that
 * failed on the merits; the gates after the first failure that were still
 * evaluated keep their own results so a rejection can say everything wrong
 * at once, and the ones that were not are `skipped`. `error` is any
 * failure to decide (timeout, memory, a tool that would not start, output
 * that could not be parsed) and is never evidence about the proof.
 */
import type {
  CheckAnalysis,
  CompileStep,
  Diagnostic,
  ProcessOutcome,
  RawCheckResult,
  Resource,
} from "./runner.js";
import type { Violation } from "./static-policy.js";

export type GateName = "static_policy" | "compile" | "target" | "axioms" | "declarations" | "replay";

export const GATE_ORDER: readonly GateName[] = [
  "static_policy",
  "compile",
  "target",
  "axioms",
  "declarations",
  "replay",
];

export type GateStatus = "pass" | "fail" | "skipped" | "error";

export interface GateRecord {
  status: GateStatus;
  detail: string;
  [extra: string]: unknown;
}

export type ChecksRecord = Record<GateName, GateRecord>;

export type Verdict = "accepted" | "rejected" | "error";

export interface VerdictOutcome {
  verdict: Verdict;
  /** The gate whose failure decided a `rejected` verdict. */
  failed_gate: GateName | null;
  /** Why an `error` verdict could not decide. */
  error_reason: string | null;
  checks: ChecksRecord;
  diagnostics: Diagnostic[];
  truncated: boolean;
  resource: Resource;
}

const skipped = (detail = "not evaluated"): GateRecord => ({ status: "skipped", detail });

export function emptyChecks(): ChecksRecord {
  return {
    static_policy: skipped(),
    compile: skipped(),
    target: skipped(),
    axioms: skipped(),
    declarations: skipped(),
    replay: skipped(),
  };
}

export const ZERO_RESOURCE: Resource = {
  wall_ms: 0,
  cpu_ms: 0,
  max_rss_mb: 0,
  exit_code: null,
  killed: false,
};

/** Gate 1 failed before any Lean process ran. */
export function staticRejection(violations: Violation[]): VerdictOutcome {
  const checks = emptyChecks();
  const first = violations[0];
  checks.static_policy = {
    status: "fail",
    detail: first
      ? `\`${first.token}\` at line ${first.line}: ${first.reason}`
      : "the static policy rejected the submission",
    violations,
  };
  return {
    verdict: "rejected",
    failed_gate: "static_policy",
    error_reason: null,
    checks,
    diagnostics: violations.map((v) => ({
      severity: "error",
      message: `${v.token}: ${v.reason}`,
      line: v.line,
      column: v.column,
      file: "submission",
    })),
    truncated: false,
    resource: { ...ZERO_RESOURCE },
  };
}

/** A process that did not run to a decision, in words. */
function infraFailure(p: ProcessOutcome): string | null {
  if (p.spawn_error) return `could not start: ${p.spawn_error}`;
  if (p.timed_out) return `timed out after ${Math.round(p.resource.wall_ms / 1000)} s`;
  if (p.killed) return "killed before finishing (memory limit or signal)";
  if (p.exit_code === null) return "ended without an exit code";
  return null;
}

function firstErrorMessage(step: CompileStep): string {
  const e = step.diagnostics.find((d) => d.severity === "error");
  if (!e) return "";
  const where = e.in_header ? "checker header" : `line ${e.line}`;
  return ` The first is at ${where}: ${e.message.split("\n")[0]}`;
}

function compileGate(step: CompileStep): { record: GateRecord; error: string | null } {
  const infra = infraFailure(step);
  if (infra) return { record: { status: "error", detail: `lean ${infra}` }, error: infra };
  if (step.error_count > 0) {
    return {
      record: {
        status: "fail",
        detail: `${step.error_count} error diagnostic(s).${firstErrorMessage(step)}`,
        error_count: step.error_count,
      },
      error: null,
    };
  }
  if (step.exit_code !== 0) {
    const reason = `lean exited with code ${step.exit_code} without an error diagnostic`;
    return { record: { status: "error", detail: reason }, error: reason };
  }
  return {
    record: {
      status: "pass",
      detail: step.cached ? "compiled (cached olean)" : "compiled with zero error diagnostics",
    },
    error: null,
  };
}

function sumResource(steps: Array<ProcessOutcome | undefined>, exitFrom: ProcessOutcome | undefined): Resource {
  let wall = 0;
  let cpu: number | null = 0;
  let rss: number | null = null;
  let killed = false;
  for (const s of steps) {
    if (!s) continue;
    wall += s.resource.wall_ms;
    if (cpu !== null) cpu = s.resource.cpu_ms === null ? null : cpu + s.resource.cpu_ms;
    if (s.resource.max_rss_mb !== null) rss = Math.max(rss ?? 0, s.resource.max_rss_mb);
    killed = killed || s.killed;
  }
  return {
    wall_ms: wall,
    cpu_ms: cpu,
    max_rss_mb: rss,
    exit_code: exitFrom ? exitFrom.exit_code : null,
    killed,
  };
}

function gateFromAnalysis(a: CheckAnalysis, name: "target" | "axioms" | "declarations"): GateRecord {
  const g = a.gates[name];
  const { status, detail, ...extra } = g;
  return { status: status === "pass" ? "pass" : "fail", detail, ...extra };
}

export function computeVerdict(raw: RawCheckResult): VerdictOutcome {
  const checks = emptyChecks();
  checks.static_policy = { status: "pass", detail: "no forbidden tokens or options" };
  const diagnostics: Diagnostic[] = [];
  let truncated = raw.statement_compile.truncated || raw.statement_compile.diagnostics_truncated;
  const resource = sumResource(
    [raw.statement_compile, raw.compile, raw.analysis_process, raw.replay],
    raw.compile ?? raw.statement_compile
  );
  const finish = (verdict: Verdict, failed: GateName | null, reason: string | null): VerdictOutcome => ({
    verdict,
    failed_gate: failed,
    error_reason: reason,
    checks,
    diagnostics,
    truncated,
    resource,
  });

  // The statement is the server's. Whatever goes wrong with it is never
  // the submission's fault, so it is always `error`.
  const stmt = compileGate(raw.statement_compile);
  if (stmt.record.status !== "pass") {
    diagnostics.push(...raw.statement_compile.diagnostics);
    checks.compile = {
      status: "error",
      detail: `the statement module did not compile: ${stmt.record.detail}`,
    };
    return finish("error", null, `statement_compile: ${stmt.error ?? stmt.record.detail}`);
  }

  if (!raw.compile) {
    checks.compile = { status: "error", detail: "the submission was never compiled" };
    return finish("error", null, "compile_missing");
  }
  diagnostics.push(...raw.compile.diagnostics);
  truncated = truncated || raw.compile.truncated || raw.compile.diagnostics_truncated;
  const sub = compileGate(raw.compile);
  checks.compile = sub.record;
  if (sub.record.status === "error") return finish("error", null, `compile: ${sub.error}`);
  if (sub.record.status === "fail") return finish("rejected", "compile", null);

  if (raw.analysis_process) {
    truncated = truncated || raw.analysis_process.truncated;
    const infra = infraFailure(raw.analysis_process);
    if (infra) {
      checks.target = { status: "error", detail: `minerval_check ${infra}` };
      return finish("error", null, `analysis: ${infra}`);
    }
  }
  if (!raw.analysis) {
    checks.target = { status: "error", detail: "minerval_check produced no result" };
    return finish("error", null, "analysis_missing");
  }
  if (raw.analysis.ok === false) {
    checks.target = { status: "error", detail: `minerval_check: ${raw.analysis.error}` };
    return finish("error", null, `analysis: ${raw.analysis.error}`);
  }
  checks.target = gateFromAnalysis(raw.analysis, "target");
  checks.axioms = gateFromAnalysis(raw.analysis, "axioms");
  checks.declarations = gateFromAnalysis(raw.analysis, "declarations");
  const firstFailed = (["target", "axioms", "declarations"] as const).find(
    (g) => checks[g].status === "fail"
  );
  if (firstFailed) return finish("rejected", firstFailed, null);

  if (!raw.replay) {
    checks.replay = {
      status: "error",
      detail: "the kernel replay did not run; a proof is never accepted without it",
    };
    return finish("error", null, "replay_not_run");
  }
  truncated = truncated || raw.replay.truncated;
  const replayInfra = infraFailure(raw.replay);
  if (replayInfra) {
    checks.replay = { status: "error", detail: `leanchecker ${replayInfra}` };
    return finish("error", null, `replay: ${replayInfra}`);
  }
  if (raw.replay.exit_code !== 0) {
    const tail = (raw.replay.stderr || raw.replay.stdout).trim().split("\n").slice(-5).join("\n");
    checks.replay = {
      status: "fail",
      detail: `the kernel refused a declaration on replay (${raw.replay.mode}): ${tail}`,
      mode: raw.replay.mode,
    };
    return finish("rejected", "replay", null);
  }
  checks.replay = {
    status: "pass",
    detail: `every new declaration replayed through the kernel (${raw.replay.mode})`,
    mode: raw.replay.mode,
  };
  return finish("accepted", null, null);
}
