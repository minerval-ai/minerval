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
import { getDb } from "../db/client.js";
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
  try {
    const db = getDb();
    await db.insert(llmUsage).values({
      userId: ctx.userId ?? null,
      apiKeyId: ctx.apiKeyId ?? null,
      jobId: ctx.jobId ?? null,
      requestId: ctx.requestId ?? null,
      agent: ctx.agent ?? "unknown",
      model: call.model,
      provider: call.provider ?? "anthropic",
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens ?? 0,
      cacheCreationTokens: call.cacheCreationTokens ?? 0,
      // costMicroUsd honours call.providerCostMicroUsd when the provider
      // reported one, and falls back to the rate table otherwise.
      costMicroUsd: costMicroUsd(call.model, call),
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
