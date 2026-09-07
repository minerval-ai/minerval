import { describe, expect, it } from "vitest";
import {
  compileOk,
  compileTimedOut,
  elaborateErrors,
  elaborateOk,
  FakeLeanRunner,
  rawAccepted,
  rawCompileRejected,
  rawGateRejected,
} from "../src/runner-fake.js";
import { exprHash, sourceHash, submissionSha256 } from "../src/hashes.js";
import { app, auth, NS, STATEMENT, VALID_PROOF } from "./helpers.js";

describe("POST /v1/elaborate", () => {
  it("returns the elaborated form with both hashes and the pin", async () => {
    const runner = new FakeLeanRunner().onElaborate(elaborateOk());
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.namespace).toBe(NS);
    expect(body.pp_type).toBe("∀ (n : ℕ), n + 0 = n");
    expect(body.expr_hash).toBe(exprHash(elaborateOk().analysis!.ok ? (elaborateOk().analysis as { pp_all: string }).pp_all : ""));
    expect(body.source_hash).toBe(sourceHash(STATEMENT, "mathlib-v4.33.0"));
    expect(body.constants).toContain("Nat");
    expect(body.definitions_axioms).toEqual({});
    expect(body.witness_present).toBe(false);
    expect(body.warnings.some((w: string) => /no witness/.test(w))).toBe(true);
    expect(body.pin.pin_id).toBe("mathlib-v4.33.0");
    expect(runner.calls.elaborate[0]).toMatchObject({ kind: "statement", namespace: NS, header_lines: 0 });
    expect(runner.calls.elaborate[0]!.limits.timeout_s).toBe(180);
  });

  it("returns convention errors with positions before running Lean", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT.replace("set_option autoImplicit false\n", "") } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().errors[0].message).toMatch(/autoImplicit/);
    expect(runner.calls.elaborate).toHaveLength(0);
  });

  it("returns compile errors with positions", async () => {
    const runner = new FakeLeanRunner().onElaborate(elaborateErrors(["unknown identifier 'ℕ'"]));
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT } });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual([{ message: "unknown identifier 'ℕ'", line: 1, column: 0 }]);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.expr_hash).toBeUndefined();
  });

  it("reports a timeout as not ok without a hash", async () => {
    const runner = new FakeLeanRunner().onElaborate({ compile: compileTimedOut() });
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT } });
    expect(res.json().ok).toBe(false);
    expect(res.json().timed_out).toBe(true);
  });

  it("warns about introduced definitions and their axioms", async () => {
    const runner = new FakeLeanRunner().onElaborate(elaborateOk({ definitions: [`${NS}.Prime`], definitions_axioms: { [`${NS}.Prime`]: ["Classical.choice"] } }));
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT } });
    const warnings: string[] = res.json().warnings;
    expect(warnings.some((w) => /introduces its own definitions/.test(w))).toBe(true);
    expect(warnings.some((w) => /Classical.choice/.test(w))).toBe(true);
  });

  it("rejects a malformed body", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement: "x" } });
    expect(res.statusCode).toBe(400);
  });

  it("clamps requested limits to the ceiling", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    await a.inject({ method: "POST", url: "/v1/elaborate", headers: auth, payload: { statement_source: STATEMENT, limits: { timeout_s: 9999, memory_mb: 100 } } });
    expect(runner.calls.elaborate[0]!.limits).toEqual({ timeout_s: 180, memory_mb: 100, max_heartbeats: 400000 });
  });
});

describe("POST /v1/scratch", () => {
  it("compiles a scratch file with a Mathlib header and never returns a verdict", async () => {
    const runner = new FakeLeanRunner().onElaborate({ compile: compileOk() });
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/scratch", headers: auth, payload: { source: "example : True := by sorry" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().verdict).toBeNull();
    const input = runner.calls.elaborate[0]!;
    expect(input.kind).toBe("scratch");
    expect(input.source.startsWith("import Mathlib\n")).toBe(true);
    expect(input.header_lines).toBe(2);
  });

  it("compiles against a statement when one is given", async () => {
    const runner = new FakeLeanRunner().onElaborate({ statement_compile: compileOk({ cached: true }), compile: compileOk() });
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/scratch", headers: auth, payload: { source: `example : ${NS}.Statement := by sorry`, statement_source: STATEMENT } });
    expect(res.json().ok).toBe(true);
    expect(runner.calls.elaborate[0]!.source.startsWith("import MinervalCheck.Statement\n")).toBe(true);
    expect(runner.calls.elaborate[0]!.statement_source).toBe(STATEMENT);
  });

  it("refuses imports and elaboration-time execution but allows sorry", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/scratch", headers: auth, payload: { source: "import Mathlib.Tactic\n#eval 1" } });
    expect(res.json().ok).toBe(false);
    expect(res.json().policy_violations.map((v: { token: string }) => v.token)).toEqual(["import", "#eval"]);
    expect(runner.calls.elaborate).toHaveLength(0);
  });
});

describe("POST /v1/search", () => {
  it("says plainly when no Loogle is configured", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "POST", url: "/v1/search", headers: auth, payload: { query: "Nat.add_zero" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("search_unconfigured");
    expect(res.json().message).toMatch(/LOOGLE_URL/);
    const nat = await a.inject({ method: "POST", url: "/v1/search", headers: auth, payload: { query: "x", backend: "natural" } });
    expect(nat.statusCode).toBe(503);
  });

  it("proxies to the configured Loogle and trims to the limit", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ header: "Found 3", count: 3, hits: [{ name: "a", type: "t", module: "M" }, { name: "b", type: "t", module: "M", doc: "d" }, { name: "c", type: "t", module: "M" }], suggestions: [] }),
        text: async () => "",
      };
    };
    const { app: a } = app({ fetchImpl }, { loogleUrl: "http://loogle.internal:8088/" });
    const res = await a.inject({ method: "POST", url: "/v1/search", headers: auth, payload: { query: "?a + 0 = ?a", limit: 2 } });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toBe("http://loogle.internal:8088/json?q=%3Fa%20%2B%200%20%3D%20%3Fa");
    expect(res.json().hits).toHaveLength(2);
    expect(res.json().count).toBe(3);
    expect(res.json().pin_id).toBe("mathlib-v4.33.0");
  });

  it("reports an unreachable Loogle as a clear error", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { app: a } = app({ fetchImpl }, { loogleUrl: "http://loogle.internal:8088" });
    const res = await a.inject({ method: "POST", url: "/v1/search", headers: auth, payload: { query: "x" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/ECONNREFUSED/);
  });
});

describe("POST /v1/check and GET /v1/checks/:id", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    mode: "attempt",
    kind: "proof",
    statement_source: STATEMENT,
    submission_source: VALID_PROOF,
    ...over,
  });

  it("queues a job with 202, then the record moves to done with the verdict", async () => {
    const runner = new FakeLeanRunner().onCheck(rawAccepted());
    let release!: () => void;
    runner.hold = new Promise<void>((r) => (release = r));
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    expect(res.statusCode).toBe(202);
    const rec = res.json();
    expect(["queued", "running"]).toContain(rec.status);
    expect(rec.verdict).toBeNull();
    expect(rec.check_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.submission_sha256).toBe(submissionSha256(VALID_PROOF));
    expect(rec.statement_source_hash).toBe(sourceHash(STATEMENT, "mathlib-v4.33.0"));
    expect(rec.target).toBe(`${NS}.proof`);
    expect(rec.lane).toBe("warm");

    await new Promise((r) => setTimeout(r, 1));
    const running = await a.inject({ method: "GET", url: `/v1/checks/${rec.check_id}`, headers: auth });
    expect(running.json().status).toBe("running");
    release();
    await new Promise((r) => setTimeout(r, 10));
    const done = await a.inject({ method: "GET", url: `/v1/checks/${rec.check_id}`, headers: auth });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("done");
    expect(done.json().verdict).toBe("accepted");
    expect(done.json().checks.replay.status).toBe("pass");
    expect(done.json().resource.wall_ms).toBeGreaterThan(0);
    expect(done.json().pin_id).toBe("mathlib-v4.33.0");
    expect(done.json().checker_version).toBe("0.1.0");

    const input = runner.calls.check[0]!;
    expect(input.submission_file.startsWith("import MinervalCheck.Statement\n")).toBe(true);
    expect(input.submission_file.endsWith(VALID_PROOF)).toBe(true);
    expect(input.header_lines).toBe(3);
    expect(input.limits).toEqual({ timeout_s: 600, memory_mb: 12288, max_heartbeats: 400000 });
  });

  it("decides a static rejection at once with 200 and records it", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    const res = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ submission_source: "theorem x : True := by sorry" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("done");
    expect(res.json().verdict).toBe("rejected");
    expect(res.json().failed_gate).toBe("static_policy");
    expect(res.json().checks.static_policy.violations[0].token).toBe("sorry");
    expect(runner.calls.check).toHaveLength(0);
    const again = await a.inject({ method: "GET", url: `/v1/checks/${res.json().check_id}`, headers: auth });
    expect(again.json().verdict).toBe("rejected");
  });

  it("maps a compile failure and a gate failure into rejected records", async () => {
    const runner = new FakeLeanRunner().onCheck(rawCompileRejected()).onCheck(rawGateRejected("axioms", "sorryAx"));
    const { app: a } = app({ runner });
    const r1 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ submission_source: VALID_PROOF + "-- v1\n" }) });
    const r2 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ submission_source: VALID_PROOF + "-- v2\n" }) });
    await new Promise((r) => setTimeout(r, 20));
    const d1 = (await a.inject({ method: "GET", url: `/v1/checks/${r1.json().check_id}`, headers: auth })).json();
    const d2 = (await a.inject({ method: "GET", url: `/v1/checks/${r2.json().check_id}`, headers: auth })).json();
    expect(d1.failed_gate).toBe("compile");
    expect(d1.diagnostics[0].message).toMatch(/Nat.foo/);
    expect(d2.failed_gate).toBe("axioms");
    expect(d2.checks.target.status).toBe("pass");
  });

  it("refuses prize mode on the warm lane and accepts it on the cold lane", async () => {
    const { app: warm } = app();
    const res = await warm.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ mode: "prize" }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("prize_requires_cold_lane");

    const { app: cold } = app({}, { lane: "cold" });
    const ok = await cold.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ mode: "prize" }) });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().lane).toBe("cold");
  });

  it("refuses a statement that breaks the convention with 400, not a verdict", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ statement_source: "def Statement : Prop := True" }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_statement");
  });

  it("dedupes identical checks and honours force", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    const r1 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    const r2 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    expect(r2.json().check_id).toBe(r1.json().check_id);
    expect(r2.json().deduplicated).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const r3 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().status).toBe("done");
    const r4 = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ force: true }) });
    expect(r4.statusCode).toBe(202);
    expect(r4.json().check_id).not.toBe(r1.json().check_id);
  });

  it("uses the disproof target for kind disproof and passes replay through", async () => {
    const runner = new FakeLeanRunner();
    const { app: a } = app({ runner });
    await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ kind: "disproof", replay: "fresh", submission_source: `theorem ${NS}.disproof : ¬ ${NS}.Statement := by\n  intro h\n  exact absurd (h 0) (by decide)\n` }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.calls.check[0]!.target).toBe(`${NS}.disproof`);
    expect(runner.calls.check[0]!.replay).toBe("fresh");
  });

  it("returns 404 for an unknown id", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "GET", url: "/v1/checks/00000000-0000-0000-0000-000000000000", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("answers 429 once the daily CPU cap is spent", async () => {
    const runner = new FakeLeanRunner().defaultCheck(() => {
      const r = rawAccepted();
      r.compile = { ...r.compile!, resource: { ...r.compile!.resource, cpu_ms: 2 * 3_600_000 } };
      return r;
    });
    const { app: a } = app({ runner }, { dailyCpuHours: 1 });
    await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    await new Promise((r) => setTimeout(r, 10));
    const res = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload({ submission_source: VALID_PROOF + "-- again\n" }) });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("daily_cpu_cap");
    const health = await a.inject({ method: "GET", url: "/health" });
    expect(health.json().queue.cpu_ms_today).toBeGreaterThanOrEqual(2 * 3_600_000);
  });

  it("on the cold lane, signals completion once the finished record was fetched", async () => {
    let completed = 0;
    const { app: a } = app({ onColdComplete: () => completed++ }, { lane: "cold", coldMaxChecks: 1 });
    const res = await a.inject({ method: "POST", url: "/v1/check", headers: auth, payload: payload() });
    await new Promise((r) => setTimeout(r, 10));
    expect(completed).toBe(0);
    await a.inject({ method: "GET", url: `/v1/checks/${res.json().check_id}`, headers: auth });
    await new Promise((r) => setTimeout(r, 5));
    expect(completed).toBe(1);
    await a.close();
  });
});
