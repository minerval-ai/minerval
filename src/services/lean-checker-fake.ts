/**
 * An in-memory Lean checker for tests and the corpus harness: the same
 * interface as the HTTP client, with canned answers and a scripted verdict
 * per submission hash. Nothing in production imports this module.
 */
import { createHash } from "node:crypto";
import type {
  CheckKind,
  CheckMode,
  CheckRecord,
  ElaborateResponse,
  GateName,
  GateRecord,
  LeanCheckerClient,
  PinInfo,
  ScratchResponse,
  SearchResponse,
  SubmitCheckInput,
  Verdict,
} from "./lean-checker-client.js";

export const FAKE_PIN: PinInfo = {
  pin_id: "mathlib-v4.33.0",
  lean_toolchain: "leanprover/lean4:v4.33.0",
  mathlib_rev: "0000000000000000000000000000000000000000",
  mathlib_tag: "v4.33.0",
  image_digest: "sha256:fake",
  checker_version: "fake-1",
};

const GATES: GateName[] = ["static_policy", "compile", "target", "axioms", "declarations", "replay"];

function checksFor(verdict: Verdict, failedGate: GateName | null): Record<GateName, GateRecord> {
  const out = {} as Record<GateName, GateRecord>;
  let failed = false;
  for (const g of GATES) {
    if (failed) out[g] = { status: "skipped", detail: "not evaluated" };
    else if (verdict === "rejected" && g === failedGate) {
      out[g] = { status: "fail", detail: `failed at ${g}` };
      failed = true;
    } else if (verdict === "error") out[g] = { status: "error", detail: "checker error" };
    else out[g] = { status: "pass", detail: "ok" };
  }
  return out;
}

export interface ScriptedVerdict {
  verdict: Verdict;
  failed_gate?: GateName;
  error_reason?: string;
  /** How many getCheck polls stay `running` before `done`. */
  polls?: number;
  wall_ms?: number;
}

export class FakeLeanCheckerClient implements LeanCheckerClient {
  readonly records = new Map<string, CheckRecord>();
  readonly submissions: SubmitCheckInput[] = [];
  readonly elaborations: string[] = [];
  private pending = new Map<string, number>();
  private scripted = new Map<string, ScriptedVerdict>();
  private defaultVerdict: ScriptedVerdict = { verdict: "accepted" };
  private seq = 0;
  /** When set, every elaboration fails with these errors (a mis-stated draft). */
  elaborateErrors: Array<{ message: string; line: number; column: number }> | null = null;
  searchHits: SearchResponse["hits"] = [];

  static sha256(source: string): string {
    return createHash("sha256").update(source).digest("hex");
  }

  /** Script the verdict for one submission source (matched by sha256). */
  script(submissionSource: string, verdict: ScriptedVerdict): void {
    this.scripted.set(FakeLeanCheckerClient.sha256(submissionSource), verdict);
  }
  scriptDefault(verdict: ScriptedVerdict): void {
    this.defaultVerdict = verdict;
  }

  async health() {
    return { status: "ok", pin: FAKE_PIN };
  }
  async pins() {
    return { platform_pin: FAKE_PIN.pin_id, pins: [FAKE_PIN] };
  }
  async elaborate(input: { statement_source: string }): Promise<ElaborateResponse> {
    this.elaborations.push(input.statement_source);
    const ns = /namespace\s+(Minerval\.S[0-9a-f]{8}_v\d+)/.exec(input.statement_source)?.[1] ?? null;
    const base = {
      namespace: ns,
      diagnostics: [],
      truncated: false,
      source_hash: FakeLeanCheckerClient.sha256(`${FAKE_PIN.pin_id}\n${input.statement_source}`),
      witness_present: /\bexample\b/.test(input.statement_source),
      warnings: [] as string[],
      pin: FAKE_PIN,
    };
    if (this.elaborateErrors || !ns) {
      return {
        ...base,
        ok: false,
        errors: this.elaborateErrors ?? [{ message: "no Minerval namespace", line: 1, column: 0 }],
      };
    }
    const body = /def Statement : Prop :=\s*([\s\S]*?)(?:\n\/--|\nexample|\nend)/.exec(input.statement_source)?.[1]?.trim() ?? "True";
    return {
      ...base,
      ok: true,
      errors: [],
      pp_type: body,
      expr_hash: FakeLeanCheckerClient.sha256(`expr\n${body}`),
      constants: [],
      definitions: [],
      definitions_axioms: {},
      statement_axioms: [],
      warnings: base.witness_present ? [] : ["no witness `example` is present"],
      resource: { wall_ms: 1500, cpu_ms: 1400, max_rss_mb: 900, exit_code: 0, killed: false },
    };
  }
  async scratch(input: { source: string }): Promise<ScratchResponse> {
    return {
      ok: !/\bsorry\b/.test(input.source),
      verdict: null,
      diagnostics: [],
      truncated: false,
      resource: { wall_ms: 800, cpu_ms: 700, max_rss_mb: 800, exit_code: 0, killed: false },
      pin: FAKE_PIN,
    };
  }
  async search(input: { query: string }): Promise<SearchResponse> {
    return { ok: true, backend: "pattern", hits: this.searchHits.filter((h) => h.name.includes(input.query) || true).slice(0, 20), pin_id: FAKE_PIN.pin_id };
  }
  async submitCheck(input: SubmitCheckInput): Promise<CheckRecord> {
    this.submissions.push(input);
    const sha = FakeLeanCheckerClient.sha256(input.submission_source);
    const existing = [...this.records.values()].find(
      (r) => r.submission_sha256 === sha && r.mode === input.mode && !input.force
    );
    if (existing) return { ...existing, deduplicated: true };
    const plan = this.scripted.get(sha) ?? this.defaultVerdict;
    const id = `chk_${++this.seq}`;
    const ns = /namespace\s+(Minerval\.S[0-9a-f]{8}_v\d+)/.exec(input.statement_source)?.[1] ?? "Minerval.S00000000_v1";
    const record: CheckRecord = {
      check_id: id,
      status: "queued",
      lane: "cold",
      mode: input.mode,
      kind: input.kind,
      namespace: ns,
      target: `${ns}.${input.kind}`,
      replay: input.replay ?? "module",
      submission_sha256: sha,
      statement_source_hash: FakeLeanCheckerClient.sha256(`${FAKE_PIN.pin_id}\n${input.statement_source}`),
      limits: {},
      verdict: null,
      failed_gate: null,
      error_reason: null,
      checks: checksFor("error", null),
      diagnostics: [],
      truncated: false,
      resource: { wall_ms: 0, cpu_ms: 0, max_rss_mb: 0, exit_code: null, killed: false },
      pin_id: FAKE_PIN.pin_id,
      lean_toolchain: FAKE_PIN.lean_toolchain,
      mathlib_rev: FAKE_PIN.mathlib_rev,
      mathlib_tag: FAKE_PIN.mathlib_tag,
      image_digest: FAKE_PIN.image_digest,
      checker_version: FAKE_PIN.checker_version,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      queue_position: 1,
    };
    this.records.set(id, record);
    this.pending.set(id, plan.polls ?? 0);
    return record;
  }
  async getCheck(checkId: string): Promise<CheckRecord> {
    const record = this.records.get(checkId);
    if (!record) throw new Error(`unknown check ${checkId}`);
    const left = this.pending.get(checkId) ?? 0;
    if (left > 0) {
      this.pending.set(checkId, left - 1);
      return { ...record, status: "running", queue_position: null };
    }
    const plan = this.scripted.get(record.submission_sha256) ?? this.defaultVerdict;
    const done: CheckRecord = {
      ...record,
      status: "done",
      verdict: plan.verdict,
      failed_gate: plan.verdict === "rejected" ? (plan.failed_gate ?? "axioms") : null,
      error_reason: plan.verdict === "error" ? (plan.error_reason ?? "timeout") : null,
      checks: checksFor(plan.verdict, plan.failed_gate ?? "axioms"),
      resource: { wall_ms: plan.wall_ms ?? 30_000, cpu_ms: plan.wall_ms ?? 30_000, max_rss_mb: 2_000, exit_code: 0, killed: false },
      started_at: record.created_at,
      finished_at: new Date().toISOString(),
      queue_position: null,
    };
    this.records.set(checkId, done);
    return done;
  }
}

export function fakeKind(kind: CheckKind, mode: CheckMode): string {
  return `${mode}:${kind}`;
}
