import { describe, expect, it } from "vitest";
import {
  analysisAllPass,
  compileErrors,
  compileOk,
  gateFail,
  processKilled,
  processOk,
  processSpawnError,
  processTimedOut,
  rawAccepted,
  rawCompileRejected,
  rawGateRejected,
  rawTimedOut,
} from "../src/runner-fake.js";
import { computeVerdict, GATE_ORDER, staticRejection } from "../src/verdict.js";

describe("the verdict rule", () => {
  it("accepts only when every gate passes, in order", () => {
    const v = computeVerdict(rawAccepted());
    expect(v.verdict).toBe("accepted");
    expect(v.failed_gate).toBeNull();
    for (const g of GATE_ORDER) expect(v.checks[g].status, g).toBe("pass");
    expect(v.resource.cpu_ms).toBe(1400 * 3);
    expect(v.resource.max_rss_mb).toBe(900);
    expect(v.resource.killed).toBe(false);
  });

  it("static rejection fails gate 1 and skips the rest", () => {
    const v = staticRejection([{ token: "sorry", line: 3, column: 2, reason: "no" }]);
    expect(v.verdict).toBe("rejected");
    expect(v.failed_gate).toBe("static_policy");
    expect(v.checks.static_policy.status).toBe("fail");
    for (const g of GATE_ORDER.slice(1)) expect(v.checks[g].status).toBe("skipped");
    expect(v.diagnostics[0]).toMatchObject({ line: 3, column: 2, severity: "error" });
  });

  it("a compile error is rejected at `compile` and later gates are skipped", () => {
    const v = computeVerdict(rawCompileRejected(["unknown identifier 'x'", "type mismatch"]));
    expect(v.verdict).toBe("rejected");
    expect(v.failed_gate).toBe("compile");
    expect(v.checks.compile.status).toBe("fail");
    expect(v.checks.compile.detail).toMatch(/2 error diagnostic/);
    expect(v.checks.target.status).toBe("skipped");
    expect(v.diagnostics).toHaveLength(2);
  });

  it("a timeout is an error, never evidence", () => {
    const v = computeVerdict(rawTimedOut());
    expect(v.verdict).toBe("error");
    expect(v.failed_gate).toBeNull();
    expect(v.error_reason).toMatch(/timed out/);
    expect(v.checks.compile.status).toBe("error");
    expect(v.resource.killed).toBe(true);
  });

  it("a kill, a missing binary, and an exit without diagnostics are errors", () => {
    const killed = computeVerdict({ statement_compile: compileOk(), compile: { ...compileOk(), ...processKilled() } });
    expect(killed.verdict).toBe("error");
    const spawn = computeVerdict({ statement_compile: compileOk(), compile: { ...compileOk(), ...processSpawnError("ENOENT lake") } });
    expect(spawn.verdict).toBe("error");
    expect(spawn.error_reason).toMatch(/ENOENT/);
    const silent = computeVerdict({ statement_compile: compileOk(), compile: compileOk({ exit_code: 2 }) });
    expect(silent.verdict).toBe("error");
    expect(silent.error_reason).toMatch(/code 2/);
  });

  it("a statement that does not compile is an error, not the submission's rejection", () => {
    const v = computeVerdict({ statement_compile: compileErrors(["bad statement"], "statement") });
    expect(v.verdict).toBe("error");
    expect(v.error_reason).toMatch(/statement_compile/);
    expect(v.diagnostics[0]!.file).toBe("statement");
  });

  it("names the first failing gate in order when several fail at once", () => {
    const raw = rawGateRejected("declarations", "unsafe def");
    raw.analysis = analysisAllPass({
      target: gateFail("wrong type"),
      axioms: gateFail("sorryAx"),
      declarations: gateFail("unsafe def"),
    });
    const v = computeVerdict(raw);
    expect(v.verdict).toBe("rejected");
    expect(v.failed_gate).toBe("target");
    expect(v.checks.axioms.status).toBe("fail");
    expect(v.checks.declarations.status).toBe("fail");
    expect(v.checks.replay.status).toBe("skipped");
  });

  it.each(["target", "axioms", "declarations"] as const)("rejects at gate %s", (gate) => {
    const v = computeVerdict(rawGateRejected(gate, `failed ${gate}`, { axioms: ["sorryAx"] }));
    expect(v.verdict).toBe("rejected");
    expect(v.failed_gate).toBe(gate);
    expect(v.checks[gate].detail).toBe(`failed ${gate}`);
    if (gate === "target") expect(v.checks.axioms.status).toBe("pass");
  });

  it("carries the analysis's extra fields into the record", () => {
    const v = computeVerdict(rawGateRejected("axioms", "used sorryAx", { axioms: ["sorryAx"], disallowed: ["sorryAx"] }));
    expect(v.checks.axioms.disallowed).toEqual(["sorryAx"]);
  });

  it("is an error when the analysis did not run, crashed, or printed nothing", () => {
    const missing = computeVerdict({ statement_compile: compileOk(), compile: compileOk() });
    expect(missing.verdict).toBe("error");
    expect(missing.error_reason).toBe("analysis_missing");
    const crashed = computeVerdict({ statement_compile: compileOk(), compile: compileOk(), analysis: { ok: false, error: "boom" }, analysis_process: processOk({ exit_code: 3 }) });
    expect(crashed.verdict).toBe("error");
    expect(crashed.error_reason).toMatch(/boom/);
    const timed = computeVerdict({ statement_compile: compileOk(), compile: compileOk(), analysis: { ok: false, error: "x" }, analysis_process: processTimedOut() });
    expect(timed.verdict).toBe("error");
    expect(timed.checks.target.status).toBe("error");
  });

  it("never accepts without the kernel replay", () => {
    const raw = rawAccepted();
    delete raw.replay;
    const v = computeVerdict(raw);
    expect(v.verdict).toBe("error");
    expect(v.error_reason).toBe("replay_not_run");
    expect(v.checks.declarations.status).toBe("pass");
    expect(v.checks.replay.status).toBe("error");
  });

  it("rejects at replay when the kernel refuses, errors when the replay tool fails to run", () => {
    const refused = rawAccepted();
    refused.replay = { ...processOk({ exit_code: 1, stderr: "declaration has metavariables" }), mode: "module" };
    const v1 = computeVerdict(refused);
    expect(v1.verdict).toBe("rejected");
    expect(v1.failed_gate).toBe("replay");
    expect(v1.checks.replay.detail).toMatch(/metavariables/);

    const absent = rawAccepted();
    absent.replay = { ...processSpawnError("ENOENT leanchecker"), mode: "module" };
    const v2 = computeVerdict(absent);
    expect(v2.verdict).toBe("error");
    expect(v2.error_reason).toMatch(/ENOENT/);

    const fresh = rawAccepted("fresh");
    expect(computeVerdict(fresh).checks.replay.mode).toBe("fresh");
  });

  it("propagates the truncated flag from any step", () => {
    const raw = rawAccepted();
    raw.compile = compileOk({ diagnostics_truncated: true });
    expect(computeVerdict(raw).truncated).toBe(true);
    const raw2 = rawAccepted();
    raw2.replay = { ...processOk({ truncated: true }), mode: "module" };
    expect(computeVerdict(raw2).truncated).toBe(true);
  });
});
