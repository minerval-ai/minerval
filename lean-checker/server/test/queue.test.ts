import { describe, expect, it } from "vitest";
import { CapExceededError, CheckQueue, DailyCpuCap, type SubmitJob } from "../src/queue.js";
import { FakeLeanRunner, rawAccepted, rawCompileRejected, resource } from "../src/runner-fake.js";
import { assembleSubmission } from "../src/statement.js";
import { NS, pins, STATEMENT, VALID_PROOF } from "./helpers.js";

function job(over: Partial<SubmitJob> = {}, id = `id-${Math.random().toString(36).slice(2)}`): SubmitJob {
  const { file, headerLines } = assembleSubmission(NS, VALID_PROOF);
  return {
    input: {
      check_id: id,
      statement_source: STATEMENT,
      namespace: NS,
      submission_file: file,
      header_lines: headerLines,
      kind: "proof",
      target: `${NS}.proof`,
      replay: "module",
      limits: { timeout_s: 600, memory_mb: 12288, max_heartbeats: 400000 },
    },
    mode: "attempt",
    submission_sha256: "sub",
    statement_source_hash: "stmt",
    ...over,
  };
}

function queue(runner: FakeLeanRunner, over: Partial<ConstructorParameters<typeof CheckQueue>[0]> = {}) {
  return new CheckQueue({
    runner,
    lane: "warm",
    pins: pins(),
    concurrency: 1,
    dailyCpuHours: 20,
    recordTtlMs: 3_600_000,
    ...over,
  });
}

describe("the check queue", () => {
  it("moves a job queued → running → done and fills the record", async () => {
    const runner = new FakeLeanRunner();
    let release!: () => void;
    runner.hold = new Promise<void>((r) => (release = r));
    const q = queue(runner);
    const { record, deduplicated } = q.submit(job());
    expect(deduplicated).toBe(false);
    // Nothing else is running, so the job starts on submit: the first
    // snapshot is already `running`, never a stale `queued`.
    expect(record.status).toBe("running");
    expect(record.verdict).toBeNull();
    expect(record.pin_id).toBe("mathlib-v4.33.0");
    expect(record.image_digest).toBe("sha256:test");
    await new Promise((r) => setTimeout(r, 1));
    expect(q.get(record.check_id)!.status).toBe("running");
    expect(q.get(record.check_id)!.started_at).not.toBeNull();
    release();
    await q.drain();
    const done = q.get(record.check_id)!;
    expect(done.status).toBe("done");
    expect(done.verdict).toBe("accepted");
    expect(done.finished_at).not.toBeNull();
    expect(done.queue_position).toBeNull();
    expect(runner.calls.check).toHaveLength(1);
    expect(runner.calls.check[0]!.target).toBe(`${NS}.proof`);
  });

  it("runs one job at a time at concurrency 1 and reports queue positions", async () => {
    const runner = new FakeLeanRunner();
    let release!: () => void;
    runner.hold = new Promise<void>((r) => (release = r));
    const q = queue(runner);
    const a = q.submit(job({ submission_sha256: "a" })).record;
    const b = q.submit(job({ submission_sha256: "b" })).record;
    const c = q.submit(job({ submission_sha256: "c" })).record;
    await new Promise((r) => setTimeout(r, 1));
    expect(q.get(a.check_id)!.status).toBe("running");
    expect(q.get(b.check_id)!.queue_position).toBe(1);
    expect(q.get(c.check_id)!.queue_position).toBe(2);
    expect(q.stats()).toMatchObject({ queued: 2, running: 1 });
    release();
    await q.drain();
    expect(runner.calls.check.map((c) => c.check_id)).toEqual([a.check_id, b.check_id, c.check_id]);
  });

  it("runs prize checks before steward and attempt checks", async () => {
    const runner = new FakeLeanRunner();
    let release!: () => void;
    runner.hold = new Promise<void>((r) => (release = r));
    const q = queue(runner);
    const first = q.submit(job({ mode: "attempt", submission_sha256: "1" })).record;
    const attempt = q.submit(job({ mode: "attempt", submission_sha256: "2" })).record;
    const steward = q.submit(job({ mode: "steward", submission_sha256: "3" })).record;
    const prize = q.submit(job({ mode: "prize", submission_sha256: "4" })).record;
    release();
    await q.drain();
    expect(runner.calls.check.map((c) => c.check_id)).toEqual([first.check_id, prize.check_id, steward.check_id, attempt.check_id]);
  });

  it("returns the existing record for an identical check unless forced", async () => {
    const runner = new FakeLeanRunner();
    const q = queue(runner);
    const a = q.submit(job({}, "one"));
    const b = q.submit(job({}, "two"));
    expect(b.deduplicated).toBe(true);
    expect(b.record.check_id).toBe(a.record.check_id);
    await q.drain();
    const c = q.submit(job({}, "three"));
    expect(c.deduplicated).toBe(true);
    const d = q.submit(job({ force: true }, "four"));
    expect(d.deduplicated).toBe(false);
    expect(d.record.check_id).toBe("four");
    await q.drain();
    expect(runner.calls.check).toHaveLength(2);
    const e = q.submit(job({ input: { ...job().input, replay: "fresh", check_id: "five" } }, "five"));
    expect(e.deduplicated).toBe(false);
  });

  it("records a static rejection as a finished record without running anything", () => {
    const runner = new FakeLeanRunner();
    const q = queue(runner);
    const record = q.recordStaticRejection(job({}, "static"), [{ token: "sorry", line: 1, column: 0, reason: "no" }]);
    expect(record.status).toBe("done");
    expect(record.verdict).toBe("rejected");
    expect(record.failed_gate).toBe("static_policy");
    expect(q.get("static")!.checks.static_policy.status).toBe("fail");
    expect(runner.calls.check).toHaveLength(0);
  });

  it("maps a rejection and an error into the record", async () => {
    const runner = new FakeLeanRunner().onCheck(rawCompileRejected()).onCheck(() => {
      throw new Error("disk full");
    });
    const q = queue(runner);
    const a = q.submit(job({ submission_sha256: "a" }, "a")).record;
    const b = q.submit(job({ submission_sha256: "b" }, "b")).record;
    await q.drain();
    expect(q.get(a.check_id)!.verdict).toBe("rejected");
    expect(q.get(a.check_id)!.failed_gate).toBe("compile");
    expect(q.get(b.check_id)!.verdict).toBe("error");
    expect(q.get(b.check_id)!.error_reason).toMatch(/disk full/);
    expect(q.get(b.check_id)!.status).toBe("done");
  });

  it("enforces the daily CPU cap: refuses new jobs once spent, fails queued ones as error, resets at midnight UTC", async () => {
    let clock = Date.parse("2026-09-03T10:00:00Z");
    const now = () => clock;
    const runner = new FakeLeanRunner().defaultCheck(() => {
      const r = rawAccepted();
      r.compile = { ...r.compile!, resource: resource({ cpu_ms: 30 * 60_000 }) };
      return r;
    });
    // Half an hour of CPU per job against a one-hour cap.
    const q = queue(runner, { dailyCpuHours: 1, now });
    q.submit(job({ submission_sha256: "1" }, "1"));
    await q.drain();
    expect(q.cap.exceeded()).toBe(false);
    let release!: () => void;
    runner.hold = new Promise<void>((r) => (release = r));
    q.submit(job({ submission_sha256: "2" }, "2"));
    q.submit(job({ submission_sha256: "3" }, "3"));
    release();
    await q.drain();
    expect(q.get("2")!.verdict).toBe("accepted");
    // Job 3 came up after the cap was spent by job 2.
    expect(q.get("3")!.verdict).toBe("error");
    expect(q.get("3")!.error_reason).toBe("daily_cpu_cap");
    expect(() => q.submit(job({ submission_sha256: "4" }, "4"))).toThrow(CapExceededError);
    clock = Date.parse("2026-09-04T00:00:01Z");
    expect(() => q.submit(job({ submission_sha256: "5" }, "5"))).not.toThrow();
    await q.drain();
    expect(q.get("5")!.verdict).toBe("accepted");
  });

  it("charges wall time when cpu time is unknown", () => {
    const cap = new DailyCpuCap(1, () => Date.parse("2026-01-01T00:00:00Z"));
    cap.add(1000);
    expect(cap.used()).toBe(1000);
    expect(cap.capMs).toBe(3_600_000);
  });

  it("expires finished records after the TTL and forgets unknown ids", async () => {
    let clock = Date.parse("2026-09-03T10:00:00Z");
    const q = queue(new FakeLeanRunner(), { recordTtlMs: 60_000, now: () => clock });
    const r = q.submit(job({}, "ttl")).record;
    await q.drain();
    expect(q.get(r.check_id)).toBeDefined();
    clock += 61_000;
    expect(q.get(r.check_id)).toBeUndefined();
    expect(q.get("nope")).toBeUndefined();
    // And a dedupe key does not outlive its record.
    expect(q.submit(job({}, "again")).deduplicated).toBe(false);
  });

  it("notifies listeners when a record finishes", async () => {
    const q = queue(new FakeLeanRunner());
    const seen: string[] = [];
    q.onDone((r) => seen.push(`${r.check_id}:${r.verdict}`));
    q.submit(job({}, "x"));
    await q.drain();
    expect(seen).toEqual(["x:accepted"]);
  });
});
