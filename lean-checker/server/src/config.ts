/**
 * Every knob the service reads from the environment, in one place, with the
 * defaults the design names. Nothing here is a secret except the bearer
 * token, which is never passed to a Lean process (see runner-process.ts).
 */
import type { Limits } from "./runner.js";

export type Lane = "warm" | "cold";

export interface ServerConfig {
  port: number;
  host: string;
  lane: Lane;
  /** Bearer token; the server refuses to start without one. */
  token: string;
  pinFile: string;
  imageDigest: string | undefined;
  /** The Lake project holding Mathlib and minerval_check. */
  projectDir: string;
  workRoot: string;
  checkerBin: string;
  /** Per-job ceilings; a request may lower them, never raise them. */
  jobLimits: Limits;
  elaborateLimits: Limits;
  /** Seconds between SIGTERM and SIGKILL from `timeout --kill-after`. */
  killAfterS: number;
  maxConcurrentChecks: number;
  maxConcurrentElaborations: number;
  dailyCpuHours: number;
  recordTtlHours: number;
  /** Whether a warm-lane instance accepts `mode: "prize"` checks. */
  refusePrizeOnWarm: boolean;
  /** Cold lane: exit after this many completed checks have been fetched. */
  coldMaxChecks: number;
  /** Cold lane: exit after this long without a request. */
  coldIdleS: number;
  /** Gate 5: the kernel replay tool; `none` records `error`, never `accepted`. */
  replayTool: "leanchecker" | "none";
  loogleUrl: string | undefined;
  naturalSearchUrl: string | undefined;
  bodyLimitBytes: number;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${raw}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const lane = (env.LEAN_CHECKER_LANE ?? "warm") as Lane;
  if (lane !== "warm" && lane !== "cold") throw new Error(`LEAN_CHECKER_LANE must be warm or cold, got ${lane}`);
  const replayTool = env.LEAN_CHECKER_REPLAY_TOOL ?? "leanchecker";
  if (replayTool !== "leanchecker" && replayTool !== "none") {
    throw new Error(`LEAN_CHECKER_REPLAY_TOOL must be leanchecker or none, got ${replayTool}`);
  }
  const projectDir = env.LEAN_CHECKER_PROJECT_DIR ?? "/opt/minerval/checker";
  return {
    port: int(env, "LEAN_CHECKER_PORT", 8080),
    host: env.LEAN_CHECKER_HOST ?? "0.0.0.0",
    lane,
    token: env.LEAN_CHECKER_TOKEN ?? "",
    pinFile: env.LEAN_CHECKER_PIN_FILE ?? "/etc/minerval-lean-pin.json",
    imageDigest: env.LEAN_CHECKER_IMAGE_DIGEST,
    projectDir,
    workRoot: env.LEAN_CHECKER_WORK_ROOT ?? "/work",
    checkerBin: env.LEAN_CHECKER_BIN ?? `${projectDir}/.lake/build/bin/minerval_check`,
    jobLimits: {
      timeout_s: int(env, "LEAN_CHECKER_JOB_TIMEOUT_S", 600),
      memory_mb: int(env, "LEAN_CHECKER_JOB_MEMORY_MB", 12288),
      max_heartbeats: int(env, "LEAN_CHECKER_JOB_MAX_HEARTBEATS", 400_000),
    },
    elaborateLimits: {
      timeout_s: int(env, "LEAN_CHECKER_ELAB_TIMEOUT_S", 180),
      memory_mb: int(env, "LEAN_CHECKER_ELAB_MEMORY_MB", 12288),
      max_heartbeats: int(env, "LEAN_CHECKER_ELAB_MAX_HEARTBEATS", 400_000),
    },
    killAfterS: int(env, "LEAN_CHECKER_KILL_AFTER_S", 10),
    maxConcurrentChecks: int(env, "LEAN_CHECKER_MAX_CONCURRENT", 1),
    maxConcurrentElaborations: int(env, "LEAN_CHECKER_MAX_WARM_CONCURRENT", 2),
    dailyCpuHours: int(env, "LEAN_CHECKER_DAILY_CPU_HOURS", 20),
    recordTtlHours: int(env, "LEAN_CHECKER_RECORD_TTL_HOURS", 72),
    refusePrizeOnWarm: bool(env, "LEAN_CHECKER_REFUSE_PRIZE_ON_WARM", true),
    coldMaxChecks: int(env, "LEAN_CHECKER_COLD_MAX_CHECKS", 1),
    coldIdleS: int(env, "LEAN_CHECKER_COLD_IDLE_S", 1200),
    replayTool,
    loogleUrl: env.LOOGLE_URL,
    naturalSearchUrl: env.LEAN_SEARCH_NATURAL_URL,
    bodyLimitBytes: int(env, "LEAN_CHECKER_BODY_LIMIT_BYTES", 2 * 1024 * 1024),
  };
}

/** A request may ask for less than the ceiling, never more. */
export function clampLimits(ceiling: Limits, requested?: Partial<Limits> | null): Limits {
  const pick = (key: keyof Limits) => {
    const r = requested?.[key];
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return ceiling[key];
    return Math.min(r, ceiling[key]);
  };
  return {
    timeout_s: pick("timeout_s"),
    memory_mb: pick("memory_mb"),
    max_heartbeats: pick("max_heartbeats"),
  };
}
