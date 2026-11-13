/**
 * The client of the sandbox service (sandbox/ in this repository;
 * src/file-sets.ts).
 *
 * The sandbox is a small service the deployment runs beside the API, on a
 * network with no route out. It holds the file sets read-only, gives each
 * run a scratch directory, and runs one command at a time for it. This
 * file is the only thing that speaks to it: it asks what the service is
 * and what its limits are (health), runs a command (run), says a run has
 * ended so its scratch directory can go (removeScratch), and asks the
 * service to check what only the deployment can provide (probe).
 *
 * Nothing here throws for anything the service or the network did. Each
 * call answers with what came back or with a failure that says, in words an
 * agent or an operator can be shown, what went wrong.
 */
import { loadConfig } from "../config.js";

export interface SandboxConfig {
  sandboxUrl?: string;
  sandboxToken?: string;
}

export type SandboxFailureKind =
  | "not_configured"
  | "unreachable"
  | "unauthorized"
  | "timeout"
  | "busy"
  | "set_not_here"
  | "not_confined"
  | "refused"
  | "bad_answer";

export interface SandboxFailure {
  kind: SandboxFailureKind;
  /** A clause that completes "…: ", with no full stop. */
  message: string;
}

/** The limits the service enforces, as it reports them. Each is told to an agent with its reason. */
export interface SandboxLimits {
  commandSeconds: number;
  outputBytes: number;
  memoryMb: number;
  scratchMb: number;
}

export interface SandboxHealth {
  version: string;
  image: string;
  python: string;
  /** The Python libraries that import in the sandbox, each with its version. */
  libraries: Record<string, string>;
  /** The shell tools on its path. */
  tools: string[];
  landlockAbi: number;
  /** Where the store and the registered root are in the sandbox's own filesystem. */
  paths: { store: string; directoryRoot: string | null };
  limits: SandboxLimits;
}

export type SandboxEnded = "exited" | "timed_out" | "memory" | "output_ceiling" | "scratch_full" | "killed";

export interface SandboxRunResult {
  ended: SandboxEnded;
  exitCode: number | null;
  signal: number | null;
  output: string;
  outputBytes: number;
  durationMs: number;
  written: Array<{ path: string; bytes: number; sha256: string }>;
  writtenNotListed: number;
  /** The most memory the command was seen using, in MB; 0 when it ended before it was first looked at. */
  memoryMbPeak: number;
  scratchBytes: number;
  /** The run's scratch directory in the sandbox: where the command ran. */
  scratch: string;
  sets: Array<{ name: string; path: string }>;
  version: string;
  image: string;
  python: string;
  memoryMbUsed?: number;
}

export interface SandboxSetRef {
  name: string;
  origin: "upload" | "directory";
  key: string;
}

export interface SandboxProbe {
  ok: boolean;
  version: string;
  image: string;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
}

type Answer<T> = { ok: true; value: T } | { ok: false; failure: SandboxFailure };

export function sandboxConfigured(config: SandboxConfig = loadConfig()): boolean {
  return typeof config.sandboxUrl === "string" && config.sandboxUrl.trim().length > 0;
}

const NOT_CONFIGURED: SandboxFailure = {
  kind: "not_configured",
  message: "this deployment has no sandbox configured",
};

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: unknown,
  timeoutSeconds: number,
  config: SandboxConfig
): Promise<Answer<T>> {
  if (!sandboxConfigured(config)) return { ok: false, failure: NOT_CONFIGURED };
  const url = `${config.sandboxUrl!.replace(/\/+$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${config.sandboxToken ?? ""}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
      // The sandbox is one address on a private network. It is never followed elsewhere.
      redirect: "error",
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        failure: { kind: "timeout", message: `the sandbox did not answer in ${timeoutSeconds} seconds` },
      };
    }
    return { ok: false, failure: { kind: "unreachable", message: "the sandbox could not be reached" } };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      failure: { kind: "bad_answer", message: `the sandbox gave an answer that could not be read (HTTP ${response.status})` },
    };
  }
  if (response.ok) return { ok: true, value: parsed as T };
  const refusal = (parsed ?? {}) as { error?: string; message?: string };
  if (response.status === 401) {
    return { ok: false, failure: { kind: "unauthorized", message: "the sandbox refused the deployment's token" } };
  }
  const known: SandboxFailureKind[] = ["busy", "set_not_here", "not_confined"];
  const kind = known.includes(refusal.error as SandboxFailureKind) ? (refusal.error as SandboxFailureKind) : "refused";
  const said = typeof refusal.message === "string" && refusal.message ? refusal.message.replace(/\.$/, "") : `HTTP ${response.status}`;
  return { ok: false, failure: { kind, message: kind === "refused" ? `the sandbox refused the request: ${said}` : said } };
}

interface RawHealth {
  ok?: boolean;
  problem?: string;
  version?: string;
  image?: string;
  python?: string;
  libraries?: Record<string, string>;
  tools?: string[];
  landlock_abi?: number;
  paths?: { store?: string; directory_root?: string | null };
  limits?: { command_seconds?: number; output_bytes?: number; memory_mb?: number; scratch_mb?: number };
}

/** How long a run waits to learn whether the sandbox is there, when its toolset is being put together. */
const HEALTH_TIMEOUT_SECONDS = 10;

/**
 * What the sandbox is and what its limits are, asked of the service itself
 * so that what an agent is told is what will be enforced.
 */
export async function sandboxHealth(config: SandboxConfig = loadConfig()): Promise<Answer<SandboxHealth>> {
  const answered = await call<RawHealth>("GET", "/health", undefined, HEALTH_TIMEOUT_SECONDS, config);
  if (!answered.ok) return answered;
  const h = answered.value;
  if (h.ok !== true) {
    return {
      ok: false,
      failure: {
        kind: "not_confined",
        message: (h.problem ?? "the sandbox reports that it cannot run commands").replace(/\.$/, ""),
      },
    };
  }
  const limits = h.limits ?? {};
  if (
    typeof h.paths?.store !== "string" ||
    !Number.isFinite(limits.command_seconds) ||
    !Number.isFinite(limits.output_bytes) ||
    !Number.isFinite(limits.memory_mb) ||
    !Number.isFinite(limits.scratch_mb)
  ) {
    return { ok: false, failure: { kind: "bad_answer", message: "the sandbox did not say what its limits are" } };
  }
  return {
    ok: true,
    value: {
      version: String(h.version ?? ""),
      image: String(h.image ?? ""),
      python: String(h.python ?? ""),
      libraries: h.libraries ?? {},
      tools: h.tools ?? [],
      landlockAbi: Number(h.landlock_abi ?? 0),
      paths: { store: h.paths.store, directoryRoot: h.paths.directory_root ?? null },
      limits: {
        commandSeconds: limits.command_seconds!,
        outputBytes: limits.output_bytes!,
        memoryMb: limits.memory_mb!,
        scratchMb: limits.scratch_mb!,
      },
    },
  };
}

interface RawRun {
  ended: SandboxEnded;
  exit_code: number | null;
  signal: number | null;
  output: string;
  output_bytes: number;
  duration_ms: number;
  written: Array<{ path: string; bytes: number; sha256: string }>;
  written_not_listed: number;
  memory_mb_peak: number;
  scratch_bytes: number;
  scratch: string;
  sets: Array<{ name: string; path: string }>;
  version: string;
  image: string;
  python: string;
  memory_mb_used?: number;
}

/**
 * How long past the command's own time limit the API waits for the answer:
 * the service may hold a command up to a minute for a free place, and
 * hashes what the command wrote after it ends.
 */
const RUN_MARGIN_SECONDS = 90;

/** Run one command for one run. The command is sent once. */
export async function runInSandbox(
  input: {
    run: string;
    command: string;
    files: Array<{ path: string; content: string }>;
    sets: SandboxSetRef[];
    commandSeconds: number;
  },
  config: SandboxConfig = loadConfig()
): Promise<Answer<SandboxRunResult>> {
  const answered = await call<RawRun>(
    "POST",
    "/run",
    { run: input.run, command: input.command, files: input.files, sets: input.sets },
    input.commandSeconds + RUN_MARGIN_SECONDS,
    config
  );
  if (!answered.ok) return answered;
  const r = answered.value;
  if (typeof r?.output !== "string" || typeof r.ended !== "string") {
    return { ok: false, failure: { kind: "bad_answer", message: "the sandbox gave an answer that was not a command's result" } };
  }
  return {
    ok: true,
    value: {
      ended: r.ended,
      exitCode: r.exit_code ?? null,
      signal: r.signal ?? null,
      output: r.output,
      outputBytes: r.output_bytes ?? Buffer.byteLength(r.output, "utf8"),
      durationMs: r.duration_ms,
      written: r.written ?? [],
      writtenNotListed: r.written_not_listed ?? 0,
      memoryMbPeak: r.memory_mb_peak ?? 0,
      scratchBytes: r.scratch_bytes ?? 0,
      scratch: r.scratch,
      sets: r.sets ?? [],
      version: r.version,
      image: r.image,
      python: r.python,
      ...(typeof r.memory_mb_used === "number" ? { memoryMbUsed: r.memory_mb_used } : {}),
    },
  };
}

/**
 * Tell the sandbox a run has ended, so its scratch directory is removed.
 * Best effort: a sandbox that cannot be told removes a scratch directory
 * itself once nothing has used it for a day.
 */
export async function removeScratch(run: string, config: SandboxConfig = loadConfig()): Promise<boolean> {
  const answered = await call<{ removed: boolean }>("DELETE", `/scratch/${encodeURIComponent(run)}`, undefined, 30, config);
  return answered.ok && answered.value.removed === true;
}

/** Ask the service to check what the deployment has to provide (sandbox/server.py, probe). */
export async function probeSandboxService(config: SandboxConfig = loadConfig()): Promise<Answer<SandboxProbe>> {
  const answered = await call<SandboxProbe>("POST", "/probe", {}, 120, config);
  if (!answered.ok) return answered;
  if (!Array.isArray(answered.value?.checks)) {
    return { ok: false, failure: { kind: "bad_answer", message: "the sandbox gave an answer that was not a probe's result" } };
  }
  return answered;
}

/** What the preflight needs to know of the sandbox (docs/file-sets.md, "What the preflight should check"). */
export interface SandboxCheck {
  /** Whether the deployment names a sandbox at all (SANDBOX_URL). */
  configured: boolean;
  /** Whether the service answered, and why not when it did not. */
  answers: boolean;
  failure: SandboxFailure | null;
  version: string | null;
  image: string | null;
  limits: SandboxLimits | null;
  /**
   * The service's own checks, each with what was tried: that a command is
   * held to its run's sets, that the sets are mounted read-only and a write
   * to one fails, and that an attempt to connect out fails.
   */
  checks: Array<{ check: string; ok: boolean; detail: string }>;
  /** True when it answers and every check passed. */
  ok: boolean;
}

/**
 * Check the sandbox as the deployment has it: that the service starts and
 * answers, and what its own probe finds. The properties that matter most
 * here are the container's and not the code's (no route out, the sets
 * mounted read-only), so they are checked where they hold or fail: inside
 * the running service. Not called by anything in this change: the
 * preflight is meant to call it. A deployment with no sandbox configured is
 * not failing a check; its file sets simply cannot be explored.
 */
export async function checkSandbox(config: SandboxConfig = loadConfig()): Promise<SandboxCheck> {
  const check: SandboxCheck = {
    configured: sandboxConfigured(config),
    answers: false,
    failure: null,
    version: null,
    image: null,
    limits: null,
    checks: [],
    ok: false,
  };
  if (!check.configured) {
    check.failure = NOT_CONFIGURED;
    return check;
  }
  const health = await sandboxHealth(config);
  if (!health.ok) {
    check.failure = health.failure;
    return check;
  }
  check.answers = true;
  check.version = health.value.version;
  check.image = health.value.image;
  check.limits = health.value.limits;
  const probed = await probeSandboxService(config);
  if (!probed.ok) {
    check.failure = probed.failure;
    return check;
  }
  check.checks = probed.value.checks;
  check.ok = probed.value.ok === true && probed.value.checks.every((c) => c.ok);
  return check;
}
