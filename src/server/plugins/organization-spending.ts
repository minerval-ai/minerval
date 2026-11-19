/**
 * Who spends an organization's owls on a request made as it
 * (docs/organizations.md, "What an organization grants"; services/
 * organization-spending.ts): a member acting as it, or a connected
 * deployment. Each route that writes runs inside that spender, so a debit it
 * makes counts against the grantee's allowance; one that would pass it is
 * refused with 402 and the figures, and nothing moves.
 *
 * Registered before any route, so every route is wrapped as it registers.
 * Work a request starts and leaves running, such as an Assistant turn, goes
 * on inside the same spender.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { AllowanceExceededError, runAsSpender, spendGrantOf } from "../../services/organization-spending.js";
import { namesPeople, readSentName, runNamed } from "../../services/named-person.js";

type Handler = (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => unknown;

function refuse(reply: FastifyReply, err: AllowanceExceededError) {
  return reply.code(402).send({
    error: err.message,
    code: err.code,
    allowance_micro_usd: err.allowanceMicroUsd,
    allowance_spent_micro_usd: err.spentMicroUsd,
    wanted_micro_usd: err.wantedMicroUsd,
  });
}

async function memberName(accountId: string): Promise<string | null> {
  const { rawQuery } = await import("../../db/client.js");
  const [row] = await rawQuery<{ display_name: string }>(`SELECT display_name FROM contributors WHERE id = $1`, [accountId]);
  return row?.display_name ?? null;
}

export async function registerOrganizationSpending(app: FastifyInstance): Promise<void> {
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) => String(m).toUpperCase());
    if (methods.every((m) => m === "GET" || m === "HEAD" || m === "OPTIONS")) return;
    const handler = route.handler as Handler;
    route.handler = async function asSpender(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      const auth = request.auth;
      const organizationId = auth?.actingMember || auth?.deployment ? auth.userId : null;
      if (!organizationId) return handler.call(this, request, reply);
      const grantId = auth!.deployment
        ? await spendGrantOf(organizationId, { deploymentId: auth!.deployment.id })
        : await spendGrantOf(organizationId, { accountId: auth!.actingMember!.accountId });
      // Who to name on what it puts on the record, where the organization chose to (services/named-person.ts):
      // the name a deployment sends, or the member's own where the organization names people.
      const name = auth!.deployment
        ? readSentName(request.headers["x-acting-person-name"])
        : (await namesPeople(organizationId))
          ? await memberName(auth!.actingMember!.accountId)
          : null;
      try {
        return await runAsSpender({ organizationId, grantId }, () => runNamed(name, () => handler.call(this, request, reply)));
      } catch (err) {
        if (err instanceof AllowanceExceededError) return refuse(reply, err);
        throw err;
      }
    };
  });
}
