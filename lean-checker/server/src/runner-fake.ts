/**
 * The runner tests use. It records every call and answers from a script:
 * either a queue of canned raw results or a function of the input. The
 * builders below assemble the raw results a real run would produce, so a
 * test reads as "the compiler reported two errors" rather than as a JSON
 * blob.
 */
import type {
  CheckAnalysis,
  CheckInput,
  CompileStep,
  Diagnostic,
  ElaborateAnalysis,
  ElaborateInput,
  GateReport,
  LeanRunner,
  ProcessOutcome,
  RawCheckResult,
  RawElaborateResult,
  Resource,
} from "./runner.js";

type Script<I, R> = R | ((input: I) => R | Promise<R>);

export class FakeLeanRunner implements LeanRunner {
  public readonly calls: { elaborate: ElaborateInput[]; check: CheckInput[] } = { elaborate: [], check: [] };
  private elaborateScripts: Array<Script<ElaborateInput, RawElaborateResult>> = [];
  private checkScripts: Array<Script<CheckInput, RawCheckResult>> = [];
  private elaborateDefault: Script<ElaborateInput, RawElaborateResult> = () => elaborateOk();
  private checkDefault: Script<CheckInput, RawCheckResult> = () => rawAccepted();
  /** A hold the test can release to observe the `running` state. */
  public hold: Promise<void> | null = null;

  onElaborate(script: Script<ElaborateInput, RawElaborateResult>): this {
    this.elaborateScripts.push(script);
    return this;
  }

  onCheck(script: Script<CheckInput, RawCheckResult>): this {
    this.checkScripts.push(script);
    return this;
  }

  defaultCheck(script: Script<CheckInput, RawCheckResult>): this {
    this.checkDefault = script;
    return this;
  }

  defaultElaborate(script: Script<ElaborateInput, RawElaborateResult>): this {
    this.elaborateDefault = script;
    return this;
  }

  async elaborate(input: ElaborateInput): Promise<RawElaborateResult> {
    this.calls.elaborate.push(input);
    if (this.hold) await this.hold;
    const script = this.elaborateScripts.shift() ?? this.elaborateDefault;
    return typeof script === "function" ? script(input) : script;
  }

  async check(input: CheckInput): Promise<RawCheckResult> {
    this.calls.check.push(input);
    if (this.hold) await this.hold;
    const script = this.checkScripts.shift() ?? this.checkDefault;
    return typeof script === "function" ? script(input) : script;
  }
}

export function resource(over: Partial<Resource> = {}): Resource {
  return { wall_ms: 1500, cpu_ms: 1400, max_rss_mb: 900, exit_code: 0, killed: false, ...over };
}

export function processOk(over: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return {
    exit_code: 0,
    killed: false,
    timed_out: false,
    resource: resource(),
    stdout: "",
    stderr: "",
    truncated: false,
    ...over,
  };
}

export function processTimedOut(over: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return processOk({
    exit_code: 124,
    killed: true,
    timed_out: true,
    resource: resource({ exit_code: 124, killed: true, wall_ms: 600_000 }),
    ...over,
  });
}

export function processKilled(over: Partial<ProcessOutcome> = {}): ProcessOutcome {
  return processOk({
    exit_code: 137,
    killed: true,
    resource: resource({ exit_code: 137, killed: true }),
    ...over,
  });
}

export function processSpawnError(message: string): ProcessOutcome {
  return processOk({
    exit_code: null,
    spawn_error: message,
    resource: resource({ exit_code: null, cpu_ms: null, max_rss_mb: null, wall_ms: 5 }),
  });
}

export function compileOk(over: Partial<CompileStep> = {}): CompileStep {
  return { ...processOk(), diagnostics: [], diagnostics_truncated: false, error_count: 0, ...over };
}

export function compileErrors(messages: string[], file: Diagnostic["file"] = "submission"): CompileStep {
  const diagnostics: Diagnostic[] = messages.map((message, i) => ({
    severity: "error",
    message,
    line: i + 1,
    column: 0,
    file,
  }));
  return {
    ...processOk({ exit_code: 1, resource: resource({ exit_code: 1 }) }),
    diagnostics,
    diagnostics_truncated: false,
    error_count: diagnostics.length,
  };
}

export function compileTimedOut(): CompileStep {
  return { ...processTimedOut(), diagnostics: [], diagnostics_truncated: false, error_count: 0 };
}

export function gatePass(detail = "ok"): GateReport {
  return { status: "pass", detail };
}

export function gateFail(detail: string, extra: Record<string, unknown> = {}): GateReport {
  return { status: "fail", detail, ...extra };
}

export function analysisAllPass(over: Partial<CheckAnalysis["gates"]> = {}): CheckAnalysis {
  const gates = {
    target: gatePass("Minerval.S00000000_v1.proof : Minerval.S00000000_v1.Statement"),
    axioms: gatePass("axioms used: [propext]"),
    declarations: gatePass("1 new constant"),
    ...over,
  };
  return {
    ok: true,
    kind: "proof",
    target: "Minerval.S00000000_v1.proof",
    statement: "Minerval.S00000000_v1.Statement",
    gates,
    all_pass: Object.values(gates).every((g) => g.status === "pass"),
    new_constants: ["Minerval.S00000000_v1.proof"],
    new_constants_total: 1,
  };
}

export function rawAccepted(replay: "module" | "fresh" = "module"): RawCheckResult {
  return {
    statement_compile: compileOk({ cached: true, resource: resource({ wall_ms: 0, cpu_ms: 0, max_rss_mb: 0 }) }),
    compile: compileOk(),
    analysis: analysisAllPass(),
    analysis_process: processOk(),
    replay: { ...processOk(), mode: replay },
  };
}

export function rawCompileRejected(messages = ["unknown identifier 'Nat.foo'"]): RawCheckResult {
  return { statement_compile: compileOk({ cached: true }), compile: compileErrors(messages) };
}

export function rawGateRejected(
  gate: "target" | "axioms" | "declarations",
  detail: string,
  extra: Record<string, unknown> = {}
): RawCheckResult {
  const analysis = analysisAllPass({ [gate]: gateFail(detail, extra) });
  return {
    statement_compile: compileOk({ cached: true }),
    compile: compileOk(),
    analysis,
    analysis_process: processOk(),
  };
}

export function rawTimedOut(): RawCheckResult {
  return { statement_compile: compileOk({ cached: true }), compile: compileTimedOut() };
}

export function elaborateOk(over: Partial<ElaborateAnalysis> = {}): RawElaborateResult {
  return {
    compile: compileOk(),
    analysis: {
      ok: true,
      statement: "Minerval.S00000000_v1.Statement",
      pp_type: "∀ (n : ℕ), n + 0 = n",
      pp_all: "∀ (n : Nat), @Eq.{1} Nat (@HAdd.hAdd.{0, 0, 0} Nat Nat Nat (@instHAdd.{0} Nat instAddNat) n 0) n",
      constants: ["Eq", "HAdd.hAdd", "Nat", "instAddNat", "instHAdd"],
      definitions: [],
      definitions_axioms: {},
      statement_axioms: [],
      ...over,
    },
    analysis_process: processOk(),
  };
}

export function elaborateErrors(messages: string[]): RawElaborateResult {
  return { compile: compileErrors(messages, "statement") };
}
