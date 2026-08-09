/**
 * The process-wide circuit breaker on LLM spend — and, deliberately, only
 * over the work that has no other bound.
 *
 * Attributed work carries its own ceiling: a user's call is charged against
 * their owl balance with a per-operation cap, and a funded job's call is
 * charged against a mandate's escrow (which the allocation engine will not
 * overcommit). For that work these counters are a second, cruder limit on
 * top of a real one, and they were doing active harm: one process-global
 * hourly count, shared by every lane, meant a busy background sweep could
 * exhaust the hour and start refusing PAID requests — the platform's own
 * housekeeping denying service to the people funding it, and the reverse
 * too, a burst of user traffic starving the background lane.
 *
 * So the limits scope to UNATTRIBUTED work: no paying user, no funded job.
 * That is the lane with nothing else standing between a runaway loop and
 * the bill, which is exactly what a circuit breaker is for. Session totals
 * stay whole-process: the cost report should show what the run really spent.
 */
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError } from "./errors.js";
import { getUsageContext } from "./usage-context.js";

interface BudgetCounters {
  hourlyCallCount: number;
  hourlyTokenCount: number;
  dailyCallCount: number;
  dailyTokenCount: number;
  currentHour: number;
  currentDay: number;
  // Session totals — cumulative for the lifetime of the process, never rolled
  // over. These power the per-run cost report (and a meaningful $ estimate),
  // which the hourly/daily limits — a coarse input+output token sum that ignores
  // cache reads and output weighting — cannot give on their own.
  sessionCalls: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCacheReadTokens: number;
  sessionCacheCreationTokens: number;
}

function freshCounters(): BudgetCounters {
  return {
    hourlyCallCount: 0,
    hourlyTokenCount: 0,
    dailyCallCount: 0,
    dailyTokenCount: 0,
    currentHour: Math.floor(Date.now() / 3_600_000),
    currentDay: Math.floor(Date.now() / 86_400_000),
    sessionCalls: 0,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCacheReadTokens: 0,
    sessionCacheCreationTokens: 0,
  };
}

let _counters: BudgetCounters = freshCounters();

function rolloverIfNeeded(): void {
  const now = Date.now();
  const currentHour = Math.floor(now / 3_600_000);
  const currentDay = Math.floor(now / 86_400_000);

  if (currentHour !== _counters.currentHour) {
    _counters.hourlyCallCount = 0;
    _counters.hourlyTokenCount = 0;
    _counters.currentHour = currentHour;
  }
  if (currentDay !== _counters.currentDay) {
    _counters.dailyCallCount = 0;
    _counters.dailyTokenCount = 0;
    _counters.currentDay = currentDay;
  }
}

/**
 * Whether this call has money of its own behind it: a paying user, or a
 * budget job whose escrow the allocation engine has already bounded. Absent
 * both, it is system work billed to nobody, and these counters are the only
 * thing bounding it.
 */
function isAttributedCall(): boolean {
  const ctx = getUsageContext();
  return Boolean(ctx.userId || ctx.jobId);
}

/**
 * Check limits before making an LLM call. Throws if any limit is exceeded.
 * A no-op for attributed calls, which are bounded by their own budget.
 */
export function checkBudget(): void {
  if (isAttributedCall()) return;
  rolloverIfNeeded();
  const config = loadConfig();

  if (
    config.llmHourlyCallLimit > 0 &&
    _counters.hourlyCallCount >= config.llmHourlyCallLimit
  ) {
    throw new LlmBudgetExceededError(
      "hourly_call_count",
      _counters.hourlyCallCount,
      config.llmHourlyCallLimit
    );
  }

  if (
    config.llmDailyCallLimit > 0 &&
    _counters.dailyCallCount >= config.llmDailyCallLimit
  ) {
    throw new LlmBudgetExceededError(
      "daily_call_count",
      _counters.dailyCallCount,
      config.llmDailyCallLimit
    );
  }

  if (
    config.llmHourlyTokenLimit > 0 &&
    _counters.hourlyTokenCount >= config.llmHourlyTokenLimit
  ) {
    throw new LlmBudgetExceededError(
      "hourly_token_count",
      _counters.hourlyTokenCount,
      config.llmHourlyTokenLimit
    );
  }

  if (
    config.llmDailyTokenLimit > 0 &&
    _counters.dailyTokenCount >= config.llmDailyTokenLimit
  ) {
    throw new LlmBudgetExceededError(
      "daily_token_count",
      _counters.dailyTokenCount,
      config.llmDailyTokenLimit
    );
  }
}

/**
 * Record usage after a successful LLM call.
 *
 * `inputTokens` / `outputTokens` are the (uncached) input and output token
 * counts. The optional cache fields let the session totals — and the per-run
 * cost estimate — account for prompt caching, where cache *reads* are ~10x
 * cheaper than fresh input. The hourly/daily LIMIT counters intentionally keep
 * summing only uncached input+output (their historical behavior) so a large but
 * cheap cache-read prefix doesn't trip the circuit breaker prematurely.
 *
 * The limit counters also only count UNATTRIBUTED calls, matching what
 * checkBudget enforces: counting paid work into a limit it is exempt from
 * would let user traffic close the breaker on the background lane.
 */
export function recordUsage(
  inputTokens: number,
  outputTokens: number,
  cache?: { readTokens?: number; creationTokens?: number }
): void {
  rolloverIfNeeded();
  const totalTokens = inputTokens + outputTokens;
  if (!isAttributedCall()) {
    _counters.hourlyCallCount += 1;
    _counters.dailyCallCount += 1;
    _counters.hourlyTokenCount += totalTokens;
    _counters.dailyTokenCount += totalTokens;
  }

  _counters.sessionCalls += 1;
  _counters.sessionInputTokens += inputTokens;
  _counters.sessionOutputTokens += outputTokens;
  _counters.sessionCacheReadTokens += cache?.readTokens ?? 0;
  _counters.sessionCacheCreationTokens += cache?.creationTokens ?? 0;
}

export interface SessionUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Cumulative token usage for this process — for per-run cost reporting. */
export function getSessionUsage(): SessionUsage {
  return {
    calls: _counters.sessionCalls,
    inputTokens: _counters.sessionInputTokens,
    outputTokens: _counters.sessionOutputTokens,
    cacheReadTokens: _counters.sessionCacheReadTokens,
    cacheCreationTokens: _counters.sessionCacheCreationTokens,
  };
}

/**
 * Get current counters for health/monitoring endpoints.
 */
export function getBudgetStatus(): Readonly<BudgetCounters> {
  rolloverIfNeeded();
  return { ..._counters };
}

/**
 * Reset counters (for testing).
 */
export function resetBudgetCounters(): void {
  _counters = freshCounters();
}
