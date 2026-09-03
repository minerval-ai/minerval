/**
 * The seam between the HTTP service and Lean.
 *
 * Everything above this interface (routes, static policy, the statement
 * convention, the verdict rule, the job queue) is pure TypeScript and is
 * unit-tested against `FakeLeanRunner`. The one real implementation,
 * `ProcessLeanRunner`, shells out to `lake env lean`, `minerval_check`, and
 * `leanchecker` and is exercised only where a pinned toolchain exists.
 *
 * A runner returns RAW step results and never a verdict: which gate failed
 * and whether the outcome is `rejected` or `error` is decided by
 * `computeVerdict` in verdict.ts from the record below, so the rule lives
 * in one testable place.
 */

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based line in the file the client sent (header lines subtracted). */
  line: number;
  /** 0-based column, as Lean reports it. */
  column: number;
  end_line?: number;
  end_column?: number;
  file: "statement" | "submission" | "scratch";
  /** Set when the position fell inside the checker-supplied header. */
  in_header?: boolean;
}

/** `wall_ms, cpu_ms, max_rss_mb, exit_code, killed` (section 5.1). */
export interface Resource {
  wall_ms: number;
  cpu_ms: number | null;
  max_rss_mb: number | null;
  exit_code: number | null;
  killed: boolean;
}

export interface ProcessOutcome {
  exit_code: number | null;
  /** Killed by the wall-clock limit, the memory limit, or a signal. */
  killed: boolean;
  timed_out: boolean;
  /** The command could not be started at all (missing binary, EACCES). */
  spawn_error?: string;
  resource: Resource;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface CompileStep extends ProcessOutcome {
  diagnostics: Diagnostic[];
  diagnostics_truncated: boolean;
  error_count: number;
  /** The statement olean was already in the cache; no process ran. */
  cached?: boolean;
}

export interface Limits {
  timeout_s: number;
  memory_mb: number;
  max_heartbeats: number;
}

export interface ElaborateInput {
  kind: "statement" | "scratch";
  /** For `statement`: the whole statement file. For `scratch`: the body after the header. */
  source: string;
  /** Required for `statement`; for `scratch`, set when `statement_source` is. */
  namespace?: string;
  /** `scratch` only: a statement to compile first and import from the scratch file. */
  statement_source?: string;
  /** Lines of checker header prepended to `source` before compilation. */
  header_lines: number;
  limits: Limits;
}

/** What `minerval_check elaborate` prints. */
export interface ElaborateAnalysis {
  ok: true;
  statement: string;
  pp_type: string;
  pp_all: string;
  constants: string[];
  definitions: string[];
  definitions_axioms: Record<string, string[]>;
  statement_axioms: string[];
}

export interface AnalysisFailure {
  ok: false;
  error: string;
}

export interface RawElaborateResult {
  /** For `scratch` with a statement: the statement's compilation. */
  statement_compile?: CompileStep;
  compile: CompileStep;
  /** Present only for `statement` inputs that compiled without errors. */
  analysis?: ElaborateAnalysis | AnalysisFailure;
  analysis_process?: ProcessOutcome;
}

export interface CheckInput {
  check_id: string;
  statement_source: string;
  namespace: string;
  /** The assembled file: checker header plus the submission. */
  submission_file: string;
  header_lines: number;
  kind: "proof" | "disproof";
  target: string;
  replay: "module" | "fresh";
  limits: Limits;
}

export interface GateReport {
  status: "pass" | "fail";
  detail: string;
  [extra: string]: unknown;
}

/** What `minerval_check check` prints. */
export interface CheckAnalysis {
  ok: true;
  kind: string;
  target: string;
  statement: string;
  gates: {
    target: GateReport;
    axioms: GateReport;
    declarations: GateReport;
  };
  all_pass: boolean;
  new_constants: string[];
  new_constants_total: number;
}

export interface RawCheckResult {
  statement_compile: CompileStep;
  /** Absent when the statement did not compile. */
  compile?: CompileStep;
  /** Absent unless the submission compiled with zero errors. */
  analysis?: CheckAnalysis | AnalysisFailure;
  analysis_process?: ProcessOutcome;
  /** Absent unless every gate of the analysis passed. */
  replay?: ProcessOutcome & { mode: "module" | "fresh" };
}

export interface LeanRunner {
  elaborate(input: ElaborateInput): Promise<RawElaborateResult>;
  check(input: CheckInput): Promise<RawCheckResult>;
}
