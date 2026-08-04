/**
 * Quota enforcement for agentic (LLM-backed) endpoints (#70).
 *
 * Free, non-agentic reads never pass through here. Agentic surfaces — source
 * ingestion, claim proposal, and future extension/chat endpoints — add the
 * `requireAgenticQuota` preHandler, which enforces:
 *
 *   1. A per-caller rate limit (in-memory sliding hour window) as a blunt
 *      backstop against runaway clients.
 *   2. The metered monthly grant via the billing seam: once a user's derived
 *      cost for the month exhausts the free-tier grant, requests return 402
 *      QUOTA_EXCEEDED — "credits not yet available" until Stripe lands.
 *
 * Service traffic with no acting user (operator env keys, internal jobs) is
 * exempt from the monthly grant — that work is attributed to the system — but
 * still rate-limited when it carries a key identity.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { loadConfig } from "../../config.js";
import {
  getBillingProvider,
  serializeEntitlement,
} from "../../services/billing-service.js";

// callerKey → timestamps (ms) of requests within the last hour
const windows = new Map<string, number[]>();

function rateLimited(callerKey: string, limitPerHour: number): boolean {
  if (limitPerHour <= 0) return false;
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const hits = (windows.get(callerKey) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limitPerHour) {
    windows.set(callerKey, hits);
    return true;
  }
  hits.push(now);
  windows.set(callerKey, hits);
  return false;
}

/** Test hook. */
export function resetRateLimiter(): void {
  windows.clear();
}

export interface QuotaDecision {
  allowed: boolean;
  /** HTTP-shaped status for the denial: 429 (rate) or 402 (grant). */
  statusCode?: 429 | 402;
  code?: "RATE_LIMITED" | "QUOTA_EXCEEDED";
  message?: string;
  entitlement?: ReturnType<typeof serializeEntitlement>;
}

/**
 * The agentic-quota decision, independent of transport. Used by the REST
 * preHandler below and by MCP tool handlers (#73), which enforce the same
 * gate per tool call rather than per HTTP request.
 */
export async function checkAgenticQuota(
  auth: Pick<
    NonNullable<FastifyRequest["auth"]>,
    "apiKeyId" | "userId" | "method"
  > | null
): Promise<QuotaDecision> {
  const config = loadConfig();

  const callerKey =
    auth?.apiKeyId ?? auth?.userId ?? auth?.method ?? "anonymous";
  if (rateLimited(callerKey, config.agenticRateLimitPerHour)) {
    return {
      allowed: false,
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "Rate limit exceeded for agentic endpoints; retry later",
    };
  }

  // Metered grant applies to user-attributed work. Trusted service
  // traffic without an acting user is system work and exempt.
  if (auth?.userId) {
    const { allowed, entitlement } = await getBillingProvider().checkSpend(
      auth.userId
    );
    if (!allowed) {
      return {
        allowed: false,
        statusCode: 402,
        code: "QUOTA_EXCEEDED",
        message: entitlement.creditsEnabled
          ? "Monthly free-tier allowance for LLM-backed requests is exhausted " +
            "and no purchased credits remain. Buy credits from your account " +
            `page (${config.publicWebBaseUrl}/account) to continue; the free ` +
            "allowance also resets at the start of next month."
          : "Monthly free-tier allowance for LLM-backed requests is exhausted. " +
            "Purchasing credits is not yet available; the allowance resets at " +
            "the start of next month.",
        entitlement: serializeEntitlement(entitlement),
      };
    }
  }

  return { allowed: true };
}

export async function registerQuota(app: FastifyInstance): Promise<void> {
  app.decorate(
    "requireAgenticQuota",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const decision = await checkAgenticQuota(request.auth);
      if (!decision.allowed) {
        return reply.code(decision.statusCode!).send({
          error: decision.message,
          code: decision.code,
          ...(decision.entitlement ? { entitlement: decision.entitlement } : {}),
        });
      }
    }
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireAgenticQuota: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}
