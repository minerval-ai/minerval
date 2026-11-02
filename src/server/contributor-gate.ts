/**
 * Shared contributor gate for governed write surfaces (#71, #157).
 *
 * POST /contributions, POST /claims/propose, and POST /sources all accept
 * user suggestions into the review pipeline, so they share one set of checks:
 * a resolved contributor identity, not suspended, not in pay-to-contribute
 * standing, and — for free surfaces only — inside the sybil/flood rate
 * limit. Returns the contributor, or null after sending the appropriate error
 * reply.
 *
 * Priced surfaces (POST /claims/propose, POST /sources) pass `priced: true`
 * and skip the hourly count: each submission takes an owl charge before any
 * work, so the caller's balance is what bounds them (docs/allocation.md,
 * "Agents work to a budget they can see"). The count stays on the free
 * surfaces because nothing prices the review they command.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { getOrCreateContributor } from "../services/contributor-service.js";
import { checkContributionRateLimit } from "../services/reputation-service.js";

export async function gateContributor(
  request: FastifyRequest,
  reply: FastifyReply,
  opts?: { displayName?: string; priced?: boolean }
): Promise<Awaited<ReturnType<typeof getOrCreateContributor>> | null> {
  // The acting contributor comes from the authenticated API key (issue #10)
  // — never from the request body, which would let any caller act as any
  // contributor.
  const externalId = request.contributorExternalId;
  if (!externalId) {
    await reply.code(403).send({
      error: {
        code: "NO_CONTRIBUTOR_IDENTITY",
        message: "API key is not bound to a contributor identity",
      },
    });
    return null;
  }

  const contributor = await getOrCreateContributor({
    externalId,
    displayName: opts?.displayName ?? externalId,
  });

  if (contributor.isSuspended) {
    await reply.code(403).send({
      error: {
        code: "CONTRIBUTOR_SUSPENDED",
        message: `Contributor is suspended: ${contributor.suspensionReason ?? "No reason provided"}`,
      },
    });
    return null;
  }

  // Good-faith-free / bad-faith-pay (#71): a suspected-bad-faith flag put
  // this contributor in must-pay standing. The deposit rail doesn't exist
  // yet (mirrors the consumer credits seam), so contributing is blocked
  // with 402 until the flag is overturned on appeal — which stays open.
  if (contributor.contributionStanding === "must_pay") {
    await reply.code(402).send({
      error: {
        code: "DEPOSIT_REQUIRED",
        message:
          "A suspected bad-faith contribution moved this account to " +
          "pay-to-contribute standing. Deposits are not yet available; " +
          "you can appeal the flag via POST /appeals.",
      },
    });
    return null;
  }

  // A priced submission is bounded by the owls it charges, not a count.
  if (opts?.priced) return contributor;

  // Sybil / flood sandbox (#71): free contributions command Contribution
  // Reviewer runs that nobody pays for, so they carry an hourly cap,
  // tighter for low-reputation and brand-new accounts. Stated up front in
  // the submit_contribution tool description and docs/reputation.md.
  const rate = checkContributionRateLimit(contributor);
  if (rate.limited) {
    await reply.code(429).send({
      error: {
        code: "CONTRIBUTION_RATE_LIMITED",
        message: rate.sandboxed
          ? `New and low-reputation accounts are limited to ${rate.limitPerHour} contributions per hour; retry later`
          : `Contribution rate limit (${rate.limitPerHour}/hour) exceeded; retry later`,
      },
    });
    return null;
  }

  return contributor;
}
