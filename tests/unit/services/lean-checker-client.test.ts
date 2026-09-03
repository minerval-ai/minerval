import { describe, it, expect, vi } from "vitest";
import {
  HttpLeanCheckerClient,
  LeanCheckerCapExceeded,
  LeanCheckerUnavailable,
  leanUsageCostMicroUsd,
  leanUsageModel,
  summarizeCheck,
  waitForCheck,
  type CheckRecord,
} from "../../../src/services/lean-checker-client.js";
import { FakeLeanCheckerClient } from "../../../src/services/lean-checker-fake.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpLeanCheckerClient", () => {
  it("sends the bearer token and JSON body, and returns parsed answers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, { ok: true, namespace: "Minerval.S00000000_v1", errors: [], diagnostics: [], truncated: false, source_hash: "h", witness_present: true, warnings: [], pin: { pin_id: "p" } });
    });
    const client = new HttpLeanCheckerClient({ baseUrl: "http://checker/", token: "secret", fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await client.elaborate({ statement_source: "x" });
    expect(out.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://checker/v1/elaborate");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ statement_source: "x" });
  });

  it("turns a 429 into LeanCheckerCapExceeded and other failures into LeanCheckerUnavailable", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "daily_cpu_cap", message: "cap" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const client = new HttpLeanCheckerClient({ baseUrl: "http://checker", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.submitCheck({ mode: "prize", kind: "proof", statement_source: "s", submission_source: "p" })).rejects.toBeInstanceOf(LeanCheckerCapExceeded);
    await expect(client.getCheck("x")).rejects.toBeInstanceOf(LeanCheckerUnavailable);
    await expect(client.getCheck("x")).rejects.toThrow(/unreachable/);
  });

  it("accepts 202 for a queued check and 503 for an unconfigured search", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { check_id: "c1", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse(503, { ok: false, error: "search_unconfigured", hits: [] }));
    const client = new HttpLeanCheckerClient({ baseUrl: "http://checker", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    const rec = await client.submitCheck({ mode: "steward", kind: "proof", statement_source: "s", submission_source: "p" });
    expect(rec.status).toBe("queued");
    const search = await client.search({ query: "Nat.Prime" });
    expect(search.error).toBe("search_unconfigured");
  });
});

describe("waitForCheck", () => {
  it("polls until the record is done", async () => {
    const fake = new FakeLeanCheckerClient();
    fake.script("proof", { verdict: "rejected", failed_gate: "axioms", polls: 2 });
    const submitted = await fake.submitCheck({ mode: "prize", kind: "proof", statement_source: "namespace Minerval.S0123abcd_v1", submission_source: "proof" });
    const sleeps: number[] = [];
    const done = await waitForCheck(fake, submitted.check_id, { pollMs: 5, sleep: async (ms) => { sleeps.push(ms); } });
    expect(done.status).toBe("done");
    expect(done.verdict).toBe("rejected");
    expect(done.failed_gate).toBe("axioms");
    expect(sleeps.length).toBe(2);
    expect(summarizeCheck(done)).toMatch(/rejected at the axioms gate/);
  });

  it("gives up after the timeout", async () => {
    const never = { getCheck: async () => ({ status: "running" }) } as unknown as FakeLeanCheckerClient;
    await expect(waitForCheck(never, "x", { pollMs: 1, timeoutMs: 0, sleep: async () => {} })).rejects.toBeInstanceOf(LeanCheckerUnavailable);
  });
});

describe("the fake", () => {
  it("dedupes identical submissions per mode unless forced", async () => {
    const fake = new FakeLeanCheckerClient();
    const a = await fake.submitCheck({ mode: "attempt", kind: "proof", statement_source: "namespace Minerval.S0123abcd_v1", submission_source: "same" });
    const b = await fake.submitCheck({ mode: "attempt", kind: "proof", statement_source: "namespace Minerval.S0123abcd_v1", submission_source: "same" });
    const c = await fake.submitCheck({ mode: "attempt", kind: "proof", statement_source: "namespace Minerval.S0123abcd_v1", submission_source: "same", force: true });
    expect(b.check_id).toBe(a.check_id);
    expect(b.deduplicated).toBe(true);
    expect(c.check_id).not.toBe(a.check_id);
  });

  it("elaborates a statement in the convention and refuses one without a namespace", async () => {
    const fake = new FakeLeanCheckerClient();
    const good = await fake.elaborate({ statement_source: "import Mathlib\nnamespace Minerval.S0123abcd_v1\ndef Statement : Prop :=\n  1 + 1 = 2\nexample : True := trivial\nend Minerval.S0123abcd_v1\n" });
    expect(good.ok).toBe(true);
    expect(good.pp_type).toBe("1 + 1 = 2");
    expect(good.expr_hash).toMatch(/^[0-9a-f]{64}$/);
    const bad = await fake.elaborate({ statement_source: "def Statement : Prop := True" });
    expect(bad.ok).toBe(false);
  });
});

describe("cost and identity helpers", () => {
  it("meters a job as overhead plus wall time at the hourly price", () => {
    const config = { leanCpuHourCostMicroUsd: 3_600_000, leanCheckOverheadMicroUsd: 10 } as never;
    expect(leanUsageCostMicroUsd({ wall_ms: 1_000 }, config)).toBe(1_010);
    expect(leanUsageCostMicroUsd(undefined, config)).toBe(10);
    expect(leanUsageModel("mathlib-v4.33.0")).toBe("lean-checker/mathlib-v4.33.0");
  });

  it("summarizes a queued record with its position", () => {
    const rec = { status: "queued", verdict: null, queue_position: 3, checks: {} } as unknown as CheckRecord;
    expect(summarizeCheck(rec)).toBe("queued (position 3)");
  });
});
