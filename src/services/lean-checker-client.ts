/**
 * The client for the Lean checker service (lean-checker/, docs/mathematics.md
 * §5.3 and §6.1).
 *
 * The checker is a Minerval-owned HTTP service with two lanes: the warm lane
 * elaborates statements and runs scratch work; the cold lane runs one process
 * per check and returns a verdict. This client mirrors its routes one for one
 * and does nothing else: it never meters (callers meter through
 * meterExternalUsage so the cost lands on the action that asked), never
 * retries a verdict, and never throws for a mechanical outcome. A checker that
 * is unreachable is a result the caller reports ("verification unavailable"),
 * so transport failures surface as LeanCheckerUnavailable, distinct from the
 * checker's own answers.
 *
 * The checker never calls the API back (a security-group rule); polling is
 * the only way a cold-lane verdict arrives, and waitForCheck is that poll.
 */
import { loadConfig, type Config } from "../config.js";

export type CheckMode = "prize" | "attempt" | "steward";
export type CheckKind = "proof" | "disproof";
export type CheckReplay = "module" | "fresh";
export type Verdict = "accepted" | "rejected" | "error";
export type GateName = "static_policy" | "compile" | "target" | "axioms" | "declarations" | "replay";

export interface Diagnostic {
  severity: string;
  message: string;
  line: number;
  column: number;
  [extra: string]: unknown;
}

export interface Resource {
  wall_ms: number;
  cpu_ms: number;
  max_rss_mb: number;
  exit_code: number | null;
  killed: boolean;
  [extra: string]: unknown;
}

export interface PinInfo {
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  image_digest: string;
  checker_version: string;
  [extra: string]: unknown;
}

export interface Limits {
  timeout_s?: number;
  memory_mb?: number;
  max_heartbeats?: number;
}

export interface ElaborateResponse {
  ok: boolean;
  namespace: string | null;
  errors: Array<{ message: string; line: number; column: number }>;
  diagnostics: Diagnostic[];
  truncated: boolean;
  pp_type?: string;
  expr_hash?: string;
  source_hash: string;
  constants?: string[];
  definitions?: string[];
  definitions_axioms?: Record<string, string[]>;
  statement_axioms?: string[];
  witness_present: boolean;
  warnings: string[];
  resource?: Resource;
  pin: PinInfo;
  timed_out?: boolean;
}

export interface ScratchResponse {
  ok: boolean;
  verdict: null;
  statement_errors?: unknown[];
  policy_violations?: unknown[];
  diagnostics: Diagnostic[];
  error_count?: number;
  truncated: boolean;
  timed_out?: boolean;
  killed?: boolean;
  resource?: Resource;
  pin: PinInfo;
  error?: string;
}

export interface SearchResponse {
  ok: boolean;
  backend?: string;
  hits: Array<{ name: string; type?: string; module?: string; doc?: string }>;
  note?: string;
  error?: string;
  message?: string;
  pin_id?: string;
}

export interface GateRecord {
  status: "pass" | "fail" | "skipped" | "error";
  detail: string;
  [extra: string]: unknown;
}

export interface CheckRecord {
  check_id: string;
  status: "queued" | "running" | "done";
  lane: "warm" | "cold";
  mode: CheckMode;
  kind: CheckKind;
  namespace: string;
  target: string;
  replay: CheckReplay;
  submission_sha256: string;
  statement_source_hash: string;
  limits: Limits;
  verdict: Verdict | null;
  failed_gate: GateName | null;
  error_reason: string | null;
  checks: Record<GateName, GateRecord>;
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
  queue_position: number | null;
  deduplicated?: boolean;
}

export interface SubmitCheckInput {
  mode: CheckMode;
  kind: CheckKind;
  statement_source: string;
  submission_source: string;
  replay?: CheckReplay;
  force?: boolean;
  limits?: Limits;
}

/** The checker could not be reached or answered outside its contract. */
export class LeanCheckerUnavailable extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "LeanCheckerUnavailable";
  }
}

/** The checker refused the job for the day (its daily CPU cap). */
export class LeanCheckerCapExceeded extends LeanCheckerUnavailable {
  constructor(message: string) {
    super(message, 429);
    this.name = "LeanCheckerCapExceeded";
  }
}

export interface LeanCheckerClient {
  health(): Promise<{ status: string; pin: PinInfo; [extra: string]: unknown }>;
  pins(): Promise<{ platform_pin: string; pins: PinInfo[] }>;
  elaborate(input: { statement_source: string; limits?: Limits }): Promise<ElaborateResponse>;
  scratch(input: { source: string; statement_source?: string; limits?: Limits }): Promise<ScratchResponse>;
  search(input: { query: string; backend?: "pattern" | "natural"; limit?: number }): Promise<SearchResponse>;
  submitCheck(input: SubmitCheckInput): Promise<CheckRecord>;
  getCheck(checkId: string): Promise<CheckRecord>;
}

/** Whether a checker is configured for this deployment (LEAN_CHECKER_URL). */
export function leanCheckerConfigured(config: Config = loadConfig()): boolean {
  return config.leanCheckerUrl.trim().length > 0;
}

type FetchLike = typeof fetch;

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  /** Per-request transport timeout; elaboration can take a minute on a cold warm lane. */
  timeoutMs?: number;
}

export class HttpLeanCheckerClient implements LeanCheckerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 202]
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LeanCheckerUnavailable(
        `checker unreachable at ${this.baseUrl}${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.status === 429) {
      const msg = (parsed as { message?: string } | null)?.message ?? "daily CPU cap reached";
      throw new LeanCheckerCapExceeded(msg);
    }
    if (!okStatuses.includes(res.status)) {
      const msg = (parsed as { message?: string; error?: string } | null)?.message
        ?? (parsed as { error?: string } | null)?.error
        ?? text.slice(0, 200);
      throw new LeanCheckerUnavailable(`checker ${method} ${path} returned ${res.status}: ${msg}`, res.status);
    }
    if (parsed === null) {
      throw new LeanCheckerUnavailable(`checker ${method} ${path} returned no JSON`, res.status);
    }
    return parsed as T;
  }

  health() {
    return this.request<{ status: string; pin: PinInfo }>("GET", "/health");
  }
  pins() {
    return this.request<{ platform_pin: string; pins: PinInfo[] }>("GET", "/v1/pins");
  }
  elaborate(input: { statement_source: string; limits?: Limits }) {
    return this.request<ElaborateResponse>("POST", "/v1/elaborate", input);
  }
  scratch(input: { source: string; statement_source?: string; limits?: Limits }) {
    return this.request<ScratchResponse>("POST", "/v1/scratch", input);
  }
  search(input: { query: string; backend?: "pattern" | "natural"; limit?: number }) {
    // 502 and 503 carry a structured answer ("search unconfigured", a failed
    // mirror); those are results for the agent, not transport failures.
    return this.request<SearchResponse>("POST", "/v1/search", input, [200, 502, 503]);
  }
  submitCheck(input: SubmitCheckInput) {
    return this.request<CheckRecord>("POST", "/v1/check", input, [200, 202]);
  }
  getCheck(checkId: string) {
    return this.request<CheckRecord>("GET", `/v1/checks/${encodeURIComponent(checkId)}`);
  }
}

let _client: LeanCheckerClient | null = null;
let _override: LeanCheckerClient | null = null;

/**
 * The process-wide client, built from config. Returns null when no checker
 * is configured, which callers turn into "formal tools unavailable this run"
 * (§6.2) rather than an error.
 */
export function getLeanCheckerClient(config: Config = loadConfig()): LeanCheckerClient | null {
  if (_override) return _override;
  if (!leanCheckerConfigured(config)) return null;
  if (!_client) {
    _client = new HttpLeanCheckerClient({
      baseUrl: config.leanCheckerUrl,
      token: config.leanCheckerToken,
    });
  }
  return _client;
}

/** Tests and the corpus harness swap the client; `null` restores config. */
export function setLeanCheckerClientForTests(client: LeanCheckerClient | null): void {
  _override = client;
  _client = null;
}

/**
 * Poll a cold-lane check to completion. The checker never calls back; a
 * caller that needs the verdict waits here, and a worker that would rather
 * not hold a process open records the check id and sweeps later.
 */
export async function waitForCheck(
  client: LeanCheckerClient,
  checkId: string,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<CheckRecord> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (;;) {
    const record = await client.getCheck(checkId);
    if (record.status === "done") return record;
    if (Date.now() - started > timeoutMs) {
      throw new LeanCheckerUnavailable(`check ${checkId} did not finish within ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

/**
 * What a checker call cost, from the checker's own resource record (§6.3): a
 * fixed per-job overhead plus wall time at the deployment's compute price.
 * The checker reports; the caller meters.
 */
export function leanUsageCostMicroUsd(
  resource: { wall_ms?: number } | undefined,
  config: Config = loadConfig()
): number {
  const wallMs = Math.max(0, resource?.wall_ms ?? 0);
  const perHour = config.leanCpuHourCostMicroUsd;
  return Math.round(config.leanCheckOverheadMicroUsd + (perHour * wallMs) / 3_600_000);
}

/** The identity metered rows carry for a checker call: `lean-checker/<pin>`. */
export function leanUsageModel(pinId: string): string {
  return `lean-checker/${pinId}`;
}

/** One-line, reader-facing summary of a verdict record for a tool result or a page. */
export function summarizeCheck(record: CheckRecord): string {
  if (record.verdict === "accepted") return "accepted: every gate passed";
  if (record.verdict === "rejected") {
    const gate = record.failed_gate ?? "unknown";
    const detail = record.failed_gate ? record.checks[record.failed_gate]?.detail : "";
    return `rejected at the ${gate} gate${detail ? `: ${detail}` : ""}`;
  }
  if (record.verdict === "error") return `error: ${record.error_reason ?? "the checker could not decide"}`;
  return `${record.status}${record.queue_position ? ` (position ${record.queue_position})` : ""}`;
}
