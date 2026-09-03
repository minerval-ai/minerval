/**
 * The real runner: one process per step, every process wrapped as design
 * section 5.3 says.
 *
 *   timeout --kill-after=<K>s <T>s /usr/bin/time -o <rusage> -f "%e %U %S %M" \
 *     lake env lean --json --root=<dir> -DmaxHeartbeats=<H> --memory=<M> -o <olean> <file>
 *
 * `timeout` enforces the wall limit outside Lean (exit 124 when it fires;
 * SIGKILL after the grace); `--memory` makes Lean abort at the memory
 * limit from the inside, before the cgroup does; `-DmaxHeartbeats` sets the
 * default heartbeat budget a submission may raise only within the static
 * policy's ceiling; GNU `time` reports CPU seconds and peak RSS, which the
 * verdict record carries as `cpu_ms` and `max_rss_mb`. Output is capped at
 * 64 KB per stream while it streams so a chatty process cannot fill
 * memory, and the environment handed to every child is an explicit
 * allowlist: the bearer token never reaches a Lean process.
 *
 * Module layout in the work directory (design section 5.4):
 *
 *   <work>/statements/<sha256>/MinervalCheck/Statement.{lean,olean}   cached per statement
 *   <work>/checks/<id>/MinervalCheck/Submission.{lean,olean}           one per check
 *
 * Both roots are put on LEAN_PATH (Lake appends the inherited LEAN_PATH
 * after its own entries) and passed to minerval_check as --search-path.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parseCheckerJson, parseLeanMessages, parseTimeOutput } from "./lean-output.js";
import { STATEMENT_MODULE, SUBMISSION_MODULE, SCRATCH_MODULE } from "./statement.js";
import { sha256Hex } from "./hashes.js";
import { DIAGNOSTICS_CAP, OUTPUT_CAP_BYTES, OutputCollector, capList } from "./truncate.js";
import type {
  CheckAnalysis,
  CheckInput,
  CompileStep,
  Diagnostic,
  ElaborateAnalysis,
  ElaborateInput,
  LeanRunner,
  Limits,
  ProcessOutcome,
  RawCheckResult,
  RawElaborateResult,
} from "./runner.js";

export interface ProcessRunnerOptions {
  projectDir: string;
  workRoot: string;
  checkerBin: string;
  replayTool: "leanchecker" | "none";
  killAfterS: number;
  lakeBin?: string;
  timeBin?: string;
  timeoutBin?: string;
  outputCapBytes?: number;
  diagnosticsCap?: number;
  /** Keep the per-check directory after the run (debugging). */
  keepWork?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface RunOptions {
  cwd: string;
  timeoutS: number;
  extraLeanPath: string[];
}

export class ProcessLeanRunner implements LeanRunner {
  private readonly lakeBin: string;
  private readonly timeBin: string;
  private readonly timeoutBin: string;
  private readonly outputCap: number;
  private readonly diagnosticsCap: number;
  private readonly childEnv: Record<string, string>;
  private readonly inFlightStatements = new Map<string, Promise<CompileStep>>();

  constructor(private readonly opts: ProcessRunnerOptions) {
    this.lakeBin = opts.lakeBin ?? "lake";
    this.timeBin = opts.timeBin ?? "/usr/bin/time";
    this.timeoutBin = opts.timeoutBin ?? "timeout";
    this.outputCap = opts.outputCapBytes ?? OUTPUT_CAP_BYTES;
    this.diagnosticsCap = opts.diagnosticsCap ?? DIAGNOSTICS_CAP;
    const src = opts.env ?? process.env;
    // The allowlist. Nothing else from the service's environment, and in
    // particular not LEAN_CHECKER_TOKEN, is visible to a Lean process.
    this.childEnv = {
      PATH: src.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: join(opts.workRoot, "home"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: join(opts.workRoot, "tmp"),
      ...(src.ELAN_HOME ? { ELAN_HOME: src.ELAN_HOME } : {}),
      ...(src.ELAN_TOOLCHAIN ? { ELAN_TOOLCHAIN: src.ELAN_TOOLCHAIN } : {}),
      ...(src.LEAN_PATH ? { LEAN_PATH: src.LEAN_PATH } : {}),
    };
  }

  private statementRoot(source: string): { root: string; key: string } {
    const key = sha256Hex(source);
    return { root: join(this.opts.workRoot, "statements", key), key };
  }

  private async runProcess(argv: string[], run: RunOptions): Promise<ProcessOutcome> {
    await mkdir(this.childEnv.TMPDIR!, { recursive: true });
    await mkdir(this.childEnv.HOME!, { recursive: true });
    const rusageFile = join(this.childEnv.TMPDIR!, `rusage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const wrapped = [
      this.timeoutBin,
      `--kill-after=${this.opts.killAfterS}s`,
      "--signal=TERM",
      `${run.timeoutS}s`,
      this.timeBin,
      "-o",
      rusageFile,
      "-f",
      "%e %U %S %M",
      ...argv,
    ];
    const env = { ...this.childEnv };
    const inherited = env.LEAN_PATH ? [env.LEAN_PATH] : [];
    env.LEAN_PATH = [...run.extraLeanPath, ...inherited].join(":");

    const started = Date.now();
    const stdout = new OutputCollector(this.outputCap);
    const stderr = new OutputCollector(this.outputCap);
    return new Promise<ProcessOutcome>((resolve) => {
      let settled = false;
      const finish = (o: Omit<ProcessOutcome, "stdout" | "stderr" | "truncated" | "resource"> & { resource?: Partial<ProcessOutcome["resource"]> }) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        void (async () => {
          let cpu_ms: number | null = null;
          let max_rss_mb: number | null = null;
          try {
            const parsed = parseTimeOutput(await readFile(rusageFile, "utf8"));
            cpu_ms = parsed.cpu_ms;
            max_rss_mb = parsed.max_rss_mb;
          } catch {
            // No rusage file: the wrapper never started or was killed first.
          }
          await rm(rusageFile, { force: true }).catch(() => undefined);
          resolve({
            ...o,
            stdout: stdout.text(),
            stderr: stderr.text(),
            truncated: stdout.truncated || stderr.truncated,
            resource: {
              wall_ms: Date.now() - started,
              cpu_ms,
              max_rss_mb,
              exit_code: o.exit_code,
              killed: o.killed,
              ...o.resource,
            },
          });
        })();
      };

      let child: ReturnType<typeof spawn>;
      try {
        // A new process group so the last-resort kill below reaches every
        // descendant, not just `timeout`.
        child = spawn(wrapped[0]!, wrapped.slice(1), { cwd: run.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        finish({ exit_code: null, killed: false, timed_out: false, spawn_error: e instanceof Error ? e.message : String(e) });
        return;
      }
      // `timeout` owns the wall limit; this fires only if it failed to.
      const watchdog = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, (run.timeoutS + this.opts.killAfterS + 15) * 1000);
      child.stdout?.on("data", (c: Buffer) => stdout.append(c));
      child.stderr?.on("data", (c: Buffer) => stderr.append(c));
      child.on("error", (e) => finish({ exit_code: null, killed: false, timed_out: false, spawn_error: e.message }));
      child.on("close", (code, signal) => {
        // GNU timeout: 124 when the limit fired, 137 when it had to SIGKILL
        // after the grace, 128+n when the child died of signal n.
        const timedOut = code === 124 || code === 137;
        const killed = timedOut || signal !== null || (code !== null && code > 128);
        finish({ exit_code: code, killed, timed_out: timedOut });
      });
    });
  }

  private async compile(
    file: string,
    root: string,
    olean: string | null,
    limits: Limits,
    extraLeanPath: string[],
    which: Diagnostic["file"],
    headerLines: number
  ): Promise<CompileStep> {
    const argv = [
      this.lakeBin,
      "env",
      "lean",
      "--json",
      `--root=${root}`,
      `-DmaxHeartbeats=${limits.max_heartbeats}`,
      `--memory=${limits.memory_mb}`,
      ...(olean ? ["-o", olean] : []),
      file,
    ];
    const outcome = await this.runProcess(argv, { cwd: this.opts.projectDir, timeoutS: limits.timeout_s, extraLeanPath });
    const all = parseLeanMessages(outcome.stdout, outcome.stderr, which, headerLines);
    const { items, truncated } = capList(all, this.diagnosticsCap);
    return {
      ...outcome,
      diagnostics: items,
      diagnostics_truncated: truncated,
      error_count: all.filter((d) => d.severity === "error").length,
    };
  }

  /** Compile the statement once per distinct source; concurrent requests share the run. */
  private async ensureStatement(source: string, limits: Limits): Promise<{ step: CompileStep; root: string }> {
    const { root, key } = this.statementRoot(source);
    const done = join(root, ".done");
    const dir = join(root, "MinervalCheck");
    const exists = await access(done).then(() => true, () => false);
    if (exists) {
      return {
        root,
        step: {
          exit_code: 0,
          killed: false,
          timed_out: false,
          resource: { wall_ms: 0, cpu_ms: 0, max_rss_mb: 0, exit_code: 0, killed: false },
          stdout: "",
          stderr: "",
          truncated: false,
          diagnostics: [],
          diagnostics_truncated: false,
          error_count: 0,
          cached: true,
        },
      };
    }
    let inFlight = this.inFlightStatements.get(key);
    if (!inFlight) {
      inFlight = (async () => {
        await mkdir(dir, { recursive: true });
        const file = join(dir, "Statement.lean");
        await writeFile(file, source, "utf8");
        const step = await this.compile(file, root, join(dir, "Statement.olean"), limits, [], "statement", 0);
        if (step.error_count === 0 && step.exit_code === 0) await writeFile(done, new Date().toISOString());
        return step;
      })().finally(() => this.inFlightStatements.delete(key));
      this.inFlightStatements.set(key, inFlight);
    }
    return { root, step: await inFlight };
  }

  private async analyze<T extends { ok: boolean }>(args: string[], timeoutS: number, extraLeanPath: string[]): Promise<{ process: ProcessOutcome; result: T | { ok: false; error: string } }> {
    const argv = [this.lakeBin, "env", this.opts.checkerBin, ...args, ...extraLeanPath.flatMap((p) => ["--search-path", p])];
    const process_ = await this.runProcess(argv, { cwd: this.opts.projectDir, timeoutS, extraLeanPath });
    if (process_.spawn_error || process_.timed_out || process_.killed) {
      return { process: process_, result: { ok: false, error: process_.spawn_error ?? "minerval_check did not finish" } };
    }
    return { process: process_, result: parseCheckerJson<T>(process_.stdout) };
  }

  async elaborate(input: ElaborateInput): Promise<RawElaborateResult> {
    if (input.kind === "statement") {
      const { root, step } = await this.ensureStatement(input.source, input.limits);
      if (step.error_count > 0 || step.exit_code !== 0) return { compile: step };
      const { process: p, result } = await this.analyze<ElaborateAnalysis>(
        ["elaborate", "--statement-module", STATEMENT_MODULE, "--namespace", input.namespace ?? ""],
        input.limits.timeout_s,
        [root]
      );
      return { compile: step, analysis: result, analysis_process: p };
    }
    // Scratch: compile the statement first when one was given, then the
    // scratch file with the statement root on the path.
    const extra: string[] = [];
    let statementStep: CompileStep | undefined;
    if (input.statement_source) {
      const ensured = await this.ensureStatement(input.statement_source, input.limits);
      statementStep = ensured.step;
      if (statementStep.error_count > 0 || statementStep.exit_code !== 0) {
        return { statement_compile: statementStep, compile: statementStep };
      }
      extra.push(ensured.root);
    }
    const id = `scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const root = join(this.opts.workRoot, "scratch", id);
    const dir = join(root, "MinervalCheck");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${SCRATCH_MODULE.split(".").pop()}.lean`);
    await writeFile(file, input.source, "utf8");
    try {
      const step = await this.compile(file, root, null, input.limits, extra, "scratch", input.header_lines);
      return statementStep ? { statement_compile: statementStep, compile: step } : { compile: step };
    } finally {
      if (!this.opts.keepWork) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async check(input: CheckInput): Promise<RawCheckResult> {
    const { root: stmtRoot, step: statement_compile } = await this.ensureStatement(input.statement_source, input.limits);
    if (statement_compile.error_count > 0 || statement_compile.exit_code !== 0) return { statement_compile };

    const root = join(this.opts.workRoot, "checks", input.check_id);
    const dir = join(root, "MinervalCheck");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "Submission.lean");
    await writeFile(file, input.submission_file, "utf8");
    try {
      const compile = await this.compile(file, root, join(dir, "Submission.olean"), input.limits, [stmtRoot], "submission", input.header_lines);
      if (compile.error_count > 0 || compile.exit_code !== 0) return { statement_compile, compile };

      const { process: analysis_process, result: analysis } = await this.analyze<CheckAnalysis>(
        [
          "check",
          "--statement-module", STATEMENT_MODULE,
          "--submission-module", SUBMISSION_MODULE,
          "--namespace", input.namespace,
          "--target", input.target,
          "--kind", input.kind,
        ],
        input.limits.timeout_s,
        [stmtRoot, root]
      );
      if (analysis.ok === false || !analysis.all_pass) return { statement_compile, compile, analysis, analysis_process };

      if (this.opts.replayTool === "none") return { statement_compile, compile, analysis, analysis_process };
      // Gate 5: `lake env leanchecker [--fresh] MinervalCheck.Submission`.
      // `--fresh` replays every import too (Mathlib included: hours), which
      // is why it is an escalation the Steward requests, not the default.
      const replayArgv = [this.lakeBin, "env", "leanchecker", ...(input.replay === "fresh" ? ["--fresh"] : []), SUBMISSION_MODULE];
      const replayTimeout = input.replay === "fresh" ? input.limits.timeout_s * 24 : input.limits.timeout_s;
      const replay = await this.runProcess(replayArgv, { cwd: this.opts.projectDir, timeoutS: replayTimeout, extraLeanPath: [stmtRoot, root] });
      return { statement_compile, compile, analysis, analysis_process, replay: { ...replay, mode: input.replay } };
    } finally {
      if (!this.opts.keepWork) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
