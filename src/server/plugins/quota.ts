/**
 * Quota enforcement for agentic (LLM-backed) endpoints — the owl economy's
 * charging gate.
 *
 * Free, non-agentic reads never pass through here. Every agentic surface has
 * a flat owl price (src/services/owl.ts) and runs three steps:
 *
 *   1. A per-caller rate limit (in-memory sliding hour window) as a blunt
 *      backstop against runaway clients.
 *   2. An affordability CHECK before any work: balance ≥ price, else 402
 *      with the price list and balance in the body (§15 legibility).
 *   3. The CHARGE — an explicit owl-ledger debit — taken only when the
 *      operation actually starts (after validation, right before the LLM
 *      work), never at request arrival; a failure after the charge refunds.
 *
 * REST routes wire step 2 as the `requireAgenticQuota(op)` preHandler and
 * steps 3 via chargeAgenticOp/refundAgenticOp inside the handler. MCP tool
 * handlers use checkAgenticQuota + the same charge pair per tool call.
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
import { chargeOwls, refundOwls } from "../../services/owl-ledger-service.js";
import { priceOwls, type PricedOp } from "../../services/owl.js";

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
  priceOwls?: number;
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
      `This operation (${op}) costs ${price} owl${price === 1 ? "" : "s"} ` +
      `and your balance is ${entitlement.owlBalance}. ` +
      (entitlement.creditsEnabled
        ? `Buy owls from your account page (${config.publicWebBaseUrl}/account); ` +
          `the free monthly owl also lands at the start of each month.`
        : `Purchasing owls is not enabled on this deployment; the free ` +
          `monthly owl lands at the start of each month.`),
    entitlement: serializeEntitlement(entitlement),
    packs: serializeOwlPacks(),
    priceOwls: price,
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
    const { allowed, priceOwls: price, entitlement } = await checkSpend(
      auth.userId,
      op
    );
    if (!allowed) return insufficientOwls(op, price, entitlement);
  }

  return { allowed: true };
}

/**
 * Take the charge, at the moment the operation starts. Returns allowed=false
 * (a 402-shaped decision) when the balance no longer covers the price — the
 * check-then-charge gap is racable by parallel requests, so callers must
 * handle this even after a passing check.
 */
export async function chargeAgenticOp(
  auth: AuthLike,
  op: PricedOp,
  refs: { claimId?: string | null; contributionId?: string | null } = {}
): Promise<QuotaDecision & { entryId?: string | null }> {
  if (!auth?.userId) return { allowed: true };
  const { charged, entryId } = await chargeOwls({
    userId: auth.userId,
    priceOwls: priceOwls(op),
    op,
    claimId: refs.claimId ?? null,
    contributionId: refs.contributionId ?? null,
  });
  if (!charged) {
    const entitlement = await getEntitlement(auth.userId);
    return insufficientOwls(op, priceOwls(op), entitlement);
  }
  return { allowed: true, entryId };
}

/** Compensate a charge whose operation failed after it started. */
export async function refundAgenticOp(
  auth: AuthLike,
  op: PricedOp,
  refs: { claimId?: string | null; contributionId?: string | null } = {}
): Promise<void> {
  if (!auth?.userId) return;
  await refundOwls({
    userId: auth.userId,
    priceOwls: priceOwls(op),
    op,
    claimId: refs.claimId ?? null,
    contributionId: refs.contributionId ?? null,
  });
}

/**
 * Run priced work with charge-at-start semantics: charge, run, and refund if
 * the work throws (the user shouldn't pay for our failure). Returns the
 * denial decision when the charge itself fails.
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
    return { ok: true, value: await fn() };
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
    ...(decision.priceOwls !== undefined
      ? { price_owls: decision.priceOwls }
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
