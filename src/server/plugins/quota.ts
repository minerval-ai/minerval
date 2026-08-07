/**
 * Quota enforcement for agentic (LLM-backed) endpoints — the owl economy's
 * charging gate.
 *
 * Free, non-agentic reads never pass through here. Every agentic surface has
 * a per-run owl CAP (src/services/owl.ts) and runs four steps:
 *
 *   1. A per-caller rate limit (in-memory sliding hour window) as a blunt
 *      backstop against runaway clients.
 *   2. An affordability CHECK before any work: balance ≥ cap, else 402
 *      with the cap list and balance in the body (§15 legibility).
 *   3. The CHARGE — an owl-ledger debit of the full cap — taken only when
 *      the operation actually starts (after validation, right before the
 *      LLM work), never at request arrival; a failure after the charge
 *      refunds the whole cap.
 *   4. The SETTLEMENT — after the work finishes, the meter's real cost-plus
 *      figure is compared to the cap and the unused fraction is credited
 *      back. Cost past the cap is absorbed, never charged: the cap is a
 *      ceiling the user can trust.
 *
 * REST routes wire step 2 as the `requireAgenticQuota(op)` preHandler and
 * steps 3–4 via withMeteredCharge (or the chargeAgenticOp/refundAgenticOp
 * pair when the work runs elsewhere). MCP tool handlers use
 * checkAgenticQuota + withMeteredCharge per tool call.
 *
 * Service traffic with no acting user (operator env keys, internal jobs) is
 * exempt from pricing — that work is attributed to the system — but still
 * rate-limited when it carries a key identity.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { loadConfig } from "../../config.js";
import {
  checkSpend,
  serializeEntitlement,
  serializeOwlPacks,
  getEntitlement,
} from "../../services/billing-service.js";
import {
  chargeOwls,
  refundOwls,
  settleMeteredCharge,
} from "../../services/owl-ledger-service.js";
import { capOwls, capMicroUsd, type PricedOp } from "../../services/owl.js";
import { withCostMeter } from "../../llm/usage-context.js";

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

type AuthLike = Pick<
  NonNullable<FastifyRequest["auth"]>,
  "apiKeyId" | "userId" | "method"
> | null;

export interface QuotaDecision {
  allowed: boolean;
  /** HTTP-shaped status for the denial: 429 (rate) or 402 (owls). */
  statusCode?: 429 | 402;
  code?: "RATE_LIMITED" | "INSUFFICIENT_OWLS";
  message?: string;
  entitlement?: ReturnType<typeof serializeEntitlement>;
  packs?: ReturnType<typeof serializeOwlPacks>;
  capOwls?: number;
}

function insufficientOwls(
  op: PricedOp,
  price: number,
  entitlement: Awaited<ReturnType<typeof getEntitlement>>
): QuotaDecision {
  const config = loadConfig();
  return {
    allowed: false,
    statusCode: 402,
    code: "INSUFFICIENT_OWLS",
    message:
      `This operation (${op}) costs up to ${price} owl${price === 1 ? "" : "s"} ` +
      `(you pay the metered cost, never more than the cap) ` +
      `and your balance is ${entitlement.owlBalance}. ` +
      (entitlement.creditsEnabled
        ? `Buy owls from your account page (${config.publicWebBaseUrl}/account); ` +
          `the free monthly owl also lands at the start of each month.`
        : `Purchasing owls is not enabled on this deployment; the free ` +
          `monthly owl lands at the start of each month.`),
    entitlement: serializeEntitlement(entitlement),
    packs: serializeOwlPacks(),
    capOwls: price,
  };
}

/**
 * The pre-work gate: rate limit + affordability check. Deliberately does NOT
 * charge — the charge belongs at the moment the operation starts
 * (chargeAgenticOp), so a request that fails validation costs nothing.
 */
export async function checkAgenticQuota(
  auth: AuthLike,
  op: PricedOp
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

  // Pricing applies to user-attributed work. Trusted service traffic
  // without an acting user is system work and exempt.
  if (auth?.userId) {
    const { allowed, capOwls: price, entitlement } = await checkSpend(
      auth.userId,
      op
    );
    if (!allowed) return insufficientOwls(op, price, entitlement);
  }

  return { allowed: true };
}

/**
 * Take the cap charge, at the moment the operation starts. Returns
 * allowed=false (a 402-shaped decision) when the balance no longer covers
 * the cap — the check-then-charge gap is racable by parallel requests, so
 * callers must handle this even after a passing check. Callers whose work
 * runs elsewhere (a worker) own the eventual settlement.
 */
export async function chargeAgenticOp(
  auth: AuthLike,
  op: PricedOp,
  refs: { claimId?: string | null; contributionId?: string | null } = {}
): Promise<QuotaDecision & { entryId?: string | null }> {
  if (!auth?.userId) return { allowed: true };
  const { charged, entryId } = await chargeOwls({
    userId: auth.userId,
    priceOwls: capOwls(op),
    op,
    claimId: refs.claimId ?? null,
    contributionId: refs.contributionId ?? null,
  });
  if (!charged) {
    const entitlement = await getEntitlement(auth.userId);
    return insufficientOwls(op, capOwls(op), entitlement);
  }
  return { allowed: true, entryId };
}

/** Compensate a cap charge whose operation failed after it started. */
export async function refundAgenticOp(
  auth: AuthLike,
  op: PricedOp,
  refs: { claimId?: string | null; contributionId?: string | null } = {}
): Promise<void> {
  if (!auth?.userId) return;
  await refundOwls({
    userId: auth.userId,
    priceOwls: capOwls(op),
    op,
    claimId: refs.claimId ?? null,
    contributionId: refs.contributionId ?? null,
  });
}

/**
 * Run capped work with cap-then-settle semantics: charge the cap, run the
 * work under a cost meter, then settle the unused fraction back. If the
 * work throws, the whole cap refunds (the user shouldn't pay for our
 * failure). Returns the denial decision when the charge itself fails.
 */
export async function withAgenticCharge<T>(
  auth: AuthLike,
  op: PricedOp,
  refs: { claimId?: string | null; contributionId?: string | null },
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; denied: QuotaDecision }> {
  const charge = await chargeAgenticOp(auth, op, refs);
  if (!charge.allowed) return { ok: false, denied: charge };
  try {
    const { value, billedMicroUsd } = await withCostMeter(fn);
    if (auth?.userId && charge.entryId) {
      await settleMeteredCharge({
        userId: auth.userId,
        capMicroUsd: capMicroUsd(op),
        meteredMicroUsd: billedMicroUsd,
        settleKey: charge.entryId,
        op,
        claimId: refs.claimId ?? null,
        contributionId: refs.contributionId ?? null,
      }).catch(() => {
        // Settlement is a credit back to the user; a miss here favours the
        // platform, is idempotent, and must not fail work that succeeded.
      });
    }
    return { ok: true, value };
  } catch (err) {
    await refundAgenticOp(auth, op, refs).catch(() => {
      // The refund is best-effort compensation; the original error matters more.
    });
    throw err;
  }
}

function sendDenial(reply: FastifyReply, decision: QuotaDecision) {
  return reply.code(decision.statusCode!).send({
    error: decision.message,
    code: decision.code,
    ...(decision.capOwls !== undefined
      ? { cap_owls: decision.capOwls }
      : {}),
    ...(decision.entitlement ? { entitlement: decision.entitlement } : {}),
    ...(decision.packs && decision.packs.length > 0
      ? { packs: decision.packs }
      : {}),
  });
}

export async function registerQuota(app: FastifyInstance): Promise<void> {
  app.decorate("requireAgenticQuota", (op: PricedOp) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const decision = await checkAgenticQuota(request.auth, op);
      if (!decision.allowed) return sendDenial(reply, decision);
    };
  });
  app.decorate(
    "sendQuotaDenial",
    (reply: FastifyReply, decision: QuotaDecision) =>
      sendDenial(reply, decision)
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireAgenticQuota: (
      op: PricedOp
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    sendQuotaDenial: (
      reply: FastifyReply,
      decision: QuotaDecision
    ) => ReturnType<FastifyReply["send"]>;
  }
}
