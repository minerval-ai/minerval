/**
 * Usage service — writes and queries the per-token LLM meter (#70).
 *
 * Writes happen at the single LLM chokepoint (src/llm/client.ts) via
 * meterLlmUsage(), which is deliberately fire-and-forget-safe: metering must
 * never fail an LLM call or an agent run, so it catches and logs instead of
 * throwing. Token counts also feed the in-memory budget tracker separately;
 * this service is the durable, per-user record.
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { apiKeys, llmUsage } from "../db/schema.js";
import { costMicroUsd } from "../llm/pricing.js";
import { getUsageContext } from "../llm/usage-context.js";

export interface LlmCallUsage {
  model: string;
  /**
   * Which backend served the call (anthropic | openai | openrouter). Derivable
   * from the model id (src/llm/providers/routing.ts), but recorded so usage
   * queries can group by provider without re-deriving the routing rules in SQL.
   */
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Cost the PROVIDER reported for this call, in micro-USD. Overrides the
   * pricing table when present — see src/llm/pricing.ts. Only OpenRouter
   * reports one.
   */
  providerCostMicroUsd?: number;
}

/**
 * Record one LLM call against the ambient usage context. Never throws.
 * Returns the insert promise so tests can await it; production callers
 * fire-and-forget.
 */
export async function meterLlmUsage(call: LlmCallUsage): Promise<void> {
  const ctx = getUsageContext();
  // Cost is measured in dollars: the meter records the REAL cost of the
  // call, never a marked-up figure. The platform's margin lives entirely
  // in the owl's purchase price ($4 buys an owl; an owl covers $1 of this
  // cost), so cost rows, charges, and estimates all speak the same unit.
  const billedMicroUsd = Math.round(costMicroUsd(call.model, call));
  // Feed the enclosing operation's live cost meter FIRST and synchronously:
  // cap-and-settle charging depends on this number being complete the moment
  // the operation's work finishes, even if the durable insert below lags or
  // fails.
  if (ctx.meter) ctx.meter.billedMicroUsd += billedMicroUsd;
  try {
    const db = getDb();
    await db.insert(llmUsage).values({
      userId: ctx.userId ?? null,
      apiKeyId: ctx.apiKeyId ?? null,
      jobId: ctx.jobId ?? null,
      claimId: ctx.claimId ?? null,
      requestId: ctx.requestId ?? null,
      agent: ctx.agent ?? "unknown",
      model: call.model,
      provider: call.provider ?? "anthropic",
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens ?? 0,
      cacheCreationTokens: call.cacheCreationTokens ?? 0,
      // costMicroUsd honours call.providerCostMicroUsd when the provider
      // reported one, and falls back to the rate table otherwise. The markup
      // multiplier turns raw provider cost into the billed rate every
      // downstream consumer (free grant, credit burn, dashboard) sees.
      costMicroUsd: billedMicroUsd,
    });
  } catch (err) {
    // Metering must never break the calling agent. Surface loudly in logs.
    console.error(
      "[usage] failed to record LLM usage:",
      err instanceof Error ? err.message : err
    );
  }
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costMicroUsd: number;
}

const totalsSelection = {
  calls: sql<number>`count(*)::int`,
  inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::bigint`,
  cacheReadTokens: sql<number>`coalesce(sum(${llmUsage.cacheReadTokens}), 0)::bigint`,
  cacheCreationTokens: sql<number>`coalesce(sum(${llmUsage.cacheCreationTokens}), 0)::bigint`,
  costMicroUsd: sql<number>`coalesce(sum(${llmUsage.costMicroUsd}), 0)::bigint`,
};

function coerceTotals(row: Record<string, unknown>): UsageTotals {
  return {
    calls: Number(row.calls ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
    costMicroUsd: Number(row.costMicroUsd ?? 0),
  };
}

/** Start of the current UTC calendar month — the free-tier accounting window. */
export function currentMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Month-to-date metered cost for one user, in micro-USD. Quota enforcement reads this. */
export async function getMonthToDateCostMicroUsd(
  userId: string
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({
      costMicroUsd: sql<number>`coalesce(sum(${llmUsage.costMicroUsd}), 0)::bigint`,
    })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.userId, userId),
        gte(llmUsage.createdAt, currentMonthStart())
      )
    );
  return Number(row?.costMicroUsd ?? 0);
}

export interface UsageSummary {
  totals: UsageTotals;
  byDay: Array<{ date: string } & UsageTotals>;
  byKey: Array<{ apiKeyId: string | null; keyName: string | null } & UsageTotals>;
  byAgent: Array<{ agent: string } & UsageTotals>;
}

/**
 * Usage for one user over the trailing `days` window, aggregated per day,
 * per key, and per agent — powers the dashboard and GET /usage.
 */
export async function getUsageSummary(
  userId: string,
  days = 30
): Promise<UsageSummary> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since));

  const day = sql<string>`to_char(${llmUsage.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [totalsRow] = await db.select(totalsSelection).from(llmUsage).where(scope);

  const byDayRows = await db
    .select({ date: day, ...totalsSelection })
    .from(llmUsage)
    .where(scope)
    .groupBy(day)
    .orderBy(desc(day));

  const byKeyRows = await db
    .select({
      apiKeyId: llmUsage.apiKeyId,
      keyName: apiKeys.name,
      ...totalsSelection,
    })
    .from(llmUsage)
    .leftJoin(apiKeys, eq(llmUsage.apiKeyId, apiKeys.id))
    .where(scope)
    .groupBy(llmUsage.apiKeyId, apiKeys.name)
    .orderBy(desc(sql`sum(${llmUsage.costMicroUsd})`));

  const byAgentRows = await db
    .select({ agent: llmUsage.agent, ...totalsSelection })
    .from(llmUsage)
    .where(scope)
    .groupBy(llmUsage.agent)
    .orderBy(desc(sql`sum(${llmUsage.costMicroUsd})`));

  return {
    totals: coerceTotals(totalsRow ?? {}),
    byDay: byDayRows.map((r) => ({ date: r.date, ...coerceTotals(r) })),
    byKey: byKeyRows.map((r) => ({
      apiKeyId: r.apiKeyId,
      keyName: r.keyName,
      ...coerceTotals(r),
    })),
    byAgent: byAgentRows.map((r) => ({ agent: r.agent, ...coerceTotals(r) })),
  };
}

/**
 * Ops aggregate across all users (service-scope only): system vs attributed
 * spend over the trailing window, plus the top spenders.
 */
export async function getSystemUsageSummary(days = 30) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = gte(llmUsage.createdAt, since);

  const [totalsRow] = await db.select(totalsSelection).from(llmUsage).where(scope);
  const [systemRow] = await db
    .select(totalsSelection)
    .from(llmUsage)
    .where(and(scope, sql`${llmUsage.userId} is null`));

  const byAgentRows = await db
    .select({ agent: llmUsage.agent, ...totalsSelection })
    .from(llmUsage)
    .where(scope)
    .groupBy(llmUsage.agent)
    .orderBy(desc(sql`sum(${llmUsage.costMicroUsd})`));

  const topUsers = await db
    .select({ userId: llmUsage.userId, ...totalsSelection })
    .from(llmUsage)
    .where(and(scope, isNotNull(llmUsage.userId)))
    .groupBy(llmUsage.userId)
    .orderBy(desc(sql`sum(${llmUsage.costMicroUsd})`))
    .limit(20);

  return {
    totals: coerceTotals(totalsRow ?? {}),
    system: coerceTotals(systemRow ?? {}),
    byAgent: byAgentRows.map((r) => ({ agent: r.agent, ...coerceTotals(r) })),
    topUsers: topUsers.map((r) => ({ userId: r.userId, ...coerceTotals(r) })),
  };
}

// ---------------------------------------------------------------------------
// Allocation cost stats (#217) — the marginal-COST half of the estimate
// ---------------------------------------------------------------------------

export interface AllocationStats {
  /** Steward spend per model: run counts and average cost per claim-run. */
  byModel: Array<{
    model: string;
    claims: number;
    calls: number;
    costMicroUsd: number;
    avgCostPerClaimMicroUsd: number;
  }>;
  /** Assessment counts per trigger — what drives the re-assessment load. */
  byTrigger: Array<{ trigger: string; assessments: number }>;
  /** The costliest claims in the window: where the budget actually went. */
  topClaims: Array<{
    claimId: string;
    costMicroUsd: number;
    calls: number;
  }>;
}

/**
 * Per-model average steward-run cost, per-trigger assessment counts, and the
 * most expensive claims — computed from llm_usage.claim_id attribution.
 * Deliberately raw aggregates: inputs to a human's judgment about pricing,
 * tiering thresholds, and cadence, never a formula that decides.
 */
export async function getAllocationStats(days = 30): Promise<AllocationStats> {
  const since = new Date(Date.now() - days * 86_400_000);

  const byModel = await rawQuery<{
    model: string;
    claims: number;
    calls: number;
    cost: number;
  }>(
    `SELECT model,
            COUNT(DISTINCT claim_id)::int AS claims,
            COUNT(*)::int AS calls,
            COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost
       FROM llm_usage
      WHERE agent = 'steward' AND claim_id IS NOT NULL AND created_at >= $1
      GROUP BY model
      ORDER BY cost DESC`,
    [since]
  );

  const byTrigger = await rawQuery<{ trigger: string; assessments: number }>(
    `SELECT COALESCE(trigger, 'unknown') AS trigger, COUNT(*)::int AS assessments
       FROM assessments
      WHERE assessed_at >= $1
      GROUP BY COALESCE(trigger, 'unknown')
      ORDER BY assessments DESC`,
    [since]
  );

  const topClaims = await rawQuery<{
    claim_id: string;
    cost: number;
    calls: number;
  }>(
    `SELECT claim_id, COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost,
            COUNT(*)::int AS calls
       FROM llm_usage
      WHERE claim_id IS NOT NULL AND created_at >= $1
      GROUP BY claim_id
      ORDER BY cost DESC
      LIMIT 20`,
    [since]
  );

  return {
    byModel: byModel.map((r) => ({
      model: r.model,
      claims: Number(r.claims),
      calls: Number(r.calls),
      costMicroUsd: Number(r.cost),
      avgCostPerClaimMicroUsd:
        Number(r.claims) > 0 ? Math.round(Number(r.cost) / Number(r.claims)) : 0,
    })),
    byTrigger: byTrigger.map((r) => ({
      trigger: r.trigger,
      assessments: Number(r.assessments),
    })),
    topClaims: topClaims.map((r) => ({
      claimId: r.claim_id,
      costMicroUsd: Number(r.cost),
      calls: Number(r.calls),
    })),
  };
}
