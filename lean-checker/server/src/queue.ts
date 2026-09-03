/**
 * The check queue: one job per `POST /v1/check`, run through the runner
 * with bounded concurrency, its record readable at `GET /v1/checks/:id`
 * until it expires. No callbacks: the record is polled.
 *
 * Also the two budget rules the design names: a per-day CPU-hour cap
 * (`LEAN_CHECKER_DAILY_CPU_HOURS`) that refuses new jobs once spent and
 * fails already-queued ones as `error` when they come up, and the per-job
 * limits, which are clamped into `CheckInput.limits` before a job is
 * submitted here.
 */
import { randomUUID } from "node:crypto";
import type { PinInfo } from "./pins.js";
import type { CheckInput, Diagnostic, LeanRunner, Limits, Resource } from "./runner.js";
import type { Violation } from "./static-policy.js";
import {
  computeVerdict,
  emptyChecks,
  staticRejection,
  ZERO_RESOURCE,
  type ChecksRecord,
  type GateName,
  type Verdict,
  type VerdictOutcome,
} from "./verdict.js";

export type CheckMode = "prize" | "attempt" | "steward";
export type CheckStatus = "queued" | "running" | "done";

const MODE_PRIORITY: Record<CheckMode, number> = { prize: 0, steward: 1, attempt: 2 };

export interface CheckRecord {
  check_id: string;
  status: CheckStatus;
  lane: "warm" | "cold";
  mode: CheckMode;
  kind: "proof" | "disproof";
  namespace: string;
  target: string;
  replay: "module" | "fresh";
  submission_sha256: string;
  statement_source_hash: string;
  limits: Limits;
  verdict: Verdict | null;
  failed_gate: GateName | null;
  error_reason: string | null;
  checks: ChecksRecord;
  diagnostics: Diagnostic[];
  truncated: boolean;
  resource: Resource;
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  image_digest: string;
  checker_version: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Position in the queue while `queued`, 1-based; null otherwise. */
  queue_position: number | null;
}

export interface SubmitJob {
  input: CheckInput;
  mode: CheckMode;
  submission_sha256: string;
  statement_source_hash: string;
  /** Re-run even when an identical check is queued, running, or done. */
  force?: boolean;
}

export class CapExceededError extends Error {
  constructor(public readonly usedMs: number, public readonly capMs: number) {
    super(`the daily CPU cap of ${Math.round(capMs / 3_600_000)} h is spent`);
    this.name = "CapExceededError";
  }
}

/** CPU-milliseconds spent per UTC day. */
export class DailyCpuCap {
  private day = "";
  private usedMs = 0;
  public readonly capMs: number;

  constructor(hoursPerDay: number, private readonly now: () => number = Date.now) {
    this.capMs = hoursPerDay * 3_600_000;
  }

  private roll(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.usedMs = 0;
    }
  }

  used(): number {
    this.roll();
    return this.usedMs;
  }

  add(ms: number): void {
    this.roll();
    this.usedMs += Math.max(0, ms);
  }

  exceeded(): boolean {
    return this.used() >= this.capMs;
  }
}

export interface CheckQueueOptions {
  runner: LeanRunner;
  lane: "warm" | "cold";
  pins: PinInfo;
  concurrency: number;
  dailyCpuHours: number;
  recordTtlMs: number;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Job {
  record: CheckRecord;
  input: CheckInput;
  seq: number;
}

export class CheckQueue {
  private readonly records = new Map<string, CheckRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly pending: Job[] = [];
  private readonly runningJobs = new Map<string, Job>();
  private readonly doneListeners: Array<(record: CheckRecord) => void> = [];
  private seq = 0;
  public readonly cap: DailyCpuCap;
  private readonly now: () => number;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly opts: CheckQueueOptions) {
    this.now = opts.now ?? Date.now;
    this.cap = new DailyCpuCap(opts.dailyCpuHours, this.now);
    this.log = opts.log ?? (() => undefined);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private key(job: SubmitJob): string {
    return [job.statement_source_hash, job.submission_sha256, job.input.kind, job.input.replay, job.mode].join("|");
  }

  private baseRecord(job: SubmitJob, status: CheckStatus): CheckRecord {
    const p = this.opts.pins;
    return {
      check_id: job.input.check_id,
      status,
      lane: this.opts.lane,
      mode: job.mode,
      kind: job.input.kind,
      namespace: job.input.namespace,
      target: job.input.target,
      replay: job.input.replay,
      submission_sha256: job.submission_sha256,
      statement_source_hash: job.statement_source_hash,
      limits: job.input.limits,
      verdict: null,
      failed_gate: null,
      error_reason: null,
      checks: emptyChecks(),
      diagnostics: [],
      truncated: false,
      resource: { ...ZERO_RESOURCE },
      pin_id: p.pin_id,
      lean_toolchain: p.lean_toolchain,
      mathlib_rev: p.mathlib_rev,
      mathlib_tag: p.mathlib_tag,
      image_digest: p.image_digest,
      checker_version: p.checker_version,
      created_at: this.stamp(),
      started_at: null,
      finished_at: null,
      queue_position: null,
    };
  }

  /** Gate 1 failed on the static policy: a finished record, no job. */
  recordStaticRejection(job: SubmitJob, violations: Violation[]): CheckRecord {
    this.sweep();
    const record = this.baseRecord(job, "done");
    this.apply(record, staticRejection(violations));
    record.started_at = record.created_at;
    record.finished_at = record.created_at;
    this.records.set(record.check_id, record);
    return record;
  }

  /**
   * Queue a job. An identical check (same statement, submission, kind,
   * replay, and mode) that is queued, running, or done is returned instead
   * of being run again unless `force` is set.
   */
  submit(job: SubmitJob): { record: CheckRecord; deduplicated: boolean } {
    this.sweep();
    const key = this.key(job);
    if (!job.force) {
      const existingId = this.byKey.get(key);
      const existing = existingId ? this.records.get(existingId) : undefined;
      if (existing) return { record: this.view(existing), deduplicated: true };
    }
    if (this.cap.exceeded()) throw new CapExceededError(this.cap.used(), this.cap.capMs);
    const record = this.baseRecord(job, "queued");
    this.records.set(record.check_id, record);
    this.byKey.set(key, record.check_id);
    this.pending.push({ record, input: job.input, seq: this.seq++ });
    this.pending.sort((a, b) => MODE_PRIORITY[a.record.mode] - MODE_PRIORITY[b.record.mode] || a.seq - b.seq);
    this.pump();
    return { record: this.view(record), deduplicated: false };
  }

  get(id: string): CheckRecord | undefined {
    this.sweep();
    const r = this.records.get(id);
    return r ? this.view(r) : undefined;
  }

  onDone(listener: (record: CheckRecord) => void): void {
    this.doneListeners.push(listener);
  }

  stats(): { queued: number; running: number; stored: number; cpu_ms_today: number; cpu_cap_ms: number } {
    return {
      queued: this.pending.length,
      running: this.runningJobs.size,
      stored: this.records.size,
      cpu_ms_today: this.cap.used(),
      cpu_cap_ms: this.cap.capMs,
    };
  }

  /** Resolves once nothing is queued or running (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.pending.length > 0 || this.runningJobs.size > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private view(record: CheckRecord): CheckRecord {
    const position = record.status === "queued" ? this.pending.findIndex((j) => j.record.check_id === record.check_id) + 1 : null;
    return { ...record, queue_position: position === 0 ? null : position };
  }

  private apply(record: CheckRecord, outcome: VerdictOutcome): void {
    record.verdict = outcome.verdict;
    record.failed_gate = outcome.failed_gate;
    record.error_reason = outcome.error_reason;
    record.checks = outcome.checks;
    record.diagnostics = outcome.diagnostics;
    record.truncated = outcome.truncated;
    record.resource = outcome.resource;
  }

  private pump(): void {
    while (this.runningJobs.size < this.opts.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.runningJobs.set(job.record.check_id, job);
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const { record } = job;
    record.status = "running";
    record.started_at = this.stamp();
    try {
      if (this.cap.exceeded()) {
        const checks = emptyChecks();
        checks.static_policy = { status: "pass", detail: "no forbidden tokens or options" };
        checks.compile = { status: "error", detail: "the daily CPU cap was spent before this check ran" };
        this.apply(record, {
          verdict: "error",
          failed_gate: null,
          error_reason: "daily_cpu_cap",
          checks,
          diagnostics: [],
          truncated: false,
          resource: { ...ZERO_RESOURCE },
        });
      } else {
        const raw = await this.opts.runner.check(job.input);
        const outcome = computeVerdict(raw);
        this.apply(record, outcome);
        this.cap.add(outcome.resource.cpu_ms ?? outcome.resource.wall_ms);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log("check runner threw", { check_id: record.check_id, error: message });
      const checks = emptyChecks();
      checks.static_policy = { status: "pass", detail: "no forbidden tokens or options" };
      checks.compile = { status: "error", detail: `the runner failed: ${message}` };
      this.apply(record, {
        verdict: "error",
        failed_gate: null,
        error_reason: `runner: ${message}`,
        checks,
        diagnostics: [],
        truncated: false,
        resource: { ...ZERO_RESOURCE },
      });
    } finally {
      record.status = "done";
      record.finished_at = this.stamp();
      this.runningJobs.delete(record.check_id);
      for (const l of this.doneListeners) l(record);
      this.pump();
    }
  }

  /** Drop finished records older than the TTL. */
  private sweep(): void {
    const cutoff = this.now() - this.opts.recordTtlMs;
    for (const [id, r] of this.records) {
      if (r.status === "done" && r.finished_at && Date.parse(r.finished_at) < cutoff) {
        this.records.delete(id);
        for (const [k, v] of this.byKey) if (v === id) this.byKey.delete(k);
      }
    }
  }
}

export function newCheckId(): string {
  return randomUUID();
}
