/**
 * Organizations on minerval.ai (docs/organizations.md, "Organizations on
 * minerval.ai"; #1118): making one, its members and admins, the invitations
 * that add people, its log, the old keys a converted account holds, a shared
 * login's request to become one, and the operator's way back for an
 * organization with no admin left.
 *
 * Every change is made by a person from a signed-in session, as themselves:
 * each decides who speaks for an organization, so no key or token makes it
 * (src/mcp/route-tools.ts says the same for MCP). The reads take any
 * credential of a member. Anyone who is not a member is told the
 * organization does not exist.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  OrganizationError,
  acceptConversion,
  acceptInvitation,
  askConversion,
  cancelConversion,
  cancelInvitation,
  createOrganization,
  getOpenConversion,
  getOrganization,
  grantPermission,
  listGrants,
  listOrganizationCredentials,
  revokeOrganizationCredential,
  setAllowance,
  listConversionsForMe,
  listInvitations,
  listLog,
  listMembers,
  listMyOrganizations,
  listOldKeys,
  makeInvitation,
  operatorAddAdmin,
  readInvitation,
  removeMember,
  renameOrganization,
  revokeOldKey,
  setRole,
  withdrawGrant,
} from "../services/organization-service.js";
import { ORGANIZATION_PERMISSIONS, type OrganizationRole } from "../db/schema.js";

const TAGS = ["organizations"];
const ROLE = { type: "string", enum: ["admin", "member"] } as const;

async function answer<T>(reply: FastifyReply, fn: () => Promise<T>, status = 200): Promise<FastifyReply> {
  try {
    return reply.code(status).send(await fn());
  } catch (err) {
    if (err instanceof OrganizationError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    throw err;
  }
}

import { nextFeedBatch, uploadUsageReport } from "../services/organization-carried.js";

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  const reader = [app.authenticate, app.requireUser];
  const session = [app.authenticate, app.requireSession, app.requireUser];
  const me = (request: { auth: { userId: string | null } | null }) => request.auth!.userId!;

  // ---- making and reading ----

  app.post<{ Body: { name: string } }>("/organizations", {
    schema: {
      tags: TAGS,
      summary:
        "Make an organization: an account of its own kind, which nobody signs in as. You become its first admin. " +
        "It costs nothing and gives nothing: no owls, no standing.",
      body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
    },
    preHandler: session,
    handler: (request, reply) => answer(reply, async () => ({ organization: await createOrganization({ name: request.body.name, by: me(request) }) }), 201),
  });

  app.get("/organizations", {
    schema: { tags: TAGS, summary: "The organizations you belong to, with your role in each" },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ organizations: await listMyOrganizations(me(request)) })),
  });

  app.get<{ Params: { id: string } }>("/organizations/:id", {
    schema: {
      tags: TAGS,
      summary: "One organization you belong to: its name, its account's external id, and your role",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ organization: await getOrganization(request.params.id, me(request)) })),
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>("/organizations/:id", {
    schema: {
      tags: TAGS,
      summary: "Rename an organization (its admins). The name is public; it proves nothing",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => ({ organization: await renameOrganization({ organizationId: request.params.id, name: request.body.name, by: me(request) }) })),
  });

  // ---- members ----

  app.get<{ Params: { id: string } }>("/organizations/:id/members", {
    schema: {
      tags: TAGS,
      summary: "An organization's members and their roles (its members only)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ members: await listMembers(request.params.id, me(request)) })),
  });

  app.put<{ Params: { id: string; account_id: string }; Body: { role: OrganizationRole } }>("/organizations/:id/members/:account_id", {
    schema: {
      tags: TAGS,
      summary: "Make a member an admin, or an admin a member (admins). Refused where it would leave the organization with no admin",
      params: {
        type: "object",
        required: ["id", "account_id"],
        properties: { id: { type: "string" }, account_id: { type: "string" } },
      },
      body: { type: "object", required: ["role"], properties: { role: ROLE } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => ({
        members: await setRole({ organizationId: request.params.id, accountId: request.params.account_id, role: request.body.role, by: me(request) }),
      })),
  });

  app.delete<{ Params: { id: string; account_id: string } }>("/organizations/:id/members/:account_id", {
    schema: {
      tags: TAGS,
      summary:
        "Take a person out of an organization: an admin removes anyone, anyone removes themselves. " +
        "Refused where it would leave the organization with no admin",
      params: {
        type: "object",
        required: ["id", "account_id"],
        properties: { id: { type: "string" }, account_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await removeMember({ organizationId: request.params.id, accountId: request.params.account_id, by: me(request) });
        return { removed: true };
      }),
  });

  // ---- grants: what each member and deployment may do as the organization ----

  app.get<{ Params: { id: string } }>("/organizations/:id/grants", {
    schema: {
      tags: TAGS,
      summary:
        "An organization's live grants: the permissions its admins gave each member and each deployment (its members only). " +
        "Admins hold every member permission without a grant.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ grants: await listGrants(request.params.id, me(request)) })),
  });

  app.post<{ Params: { id: string }; Body: { permission: string; account_id?: string; deployment_id?: string } }>("/organizations/:id/grants", {
    schema: {
      tags: TAGS,
      summary:
        "Give a member or a deployment a permission to act as the organization (admins): for a member spend, buy, speak, propose, take_up " +
        "or claim_prizes; for a deployment read_feed, report_usage, publish, spend, speak, propose or take_up",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: {
        type: "object",
        required: ["permission"],
        properties: {
          permission: { type: "string", enum: [...ORGANIZATION_PERMISSIONS] },
          account_id: { type: "string" },
          deployment_id: { type: "string" },
        },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(
        reply,
        async () => ({
          grants: await grantPermission({
            organizationId: request.params.id,
            permission: request.body.permission,
            accountId: request.body.account_id ?? null,
            deploymentId: request.body.deployment_id ?? null,
            by: me(request),
          }),
        }),
        201
      ),
  });

  app.delete<{ Params: { id: string; grant_id: string } }>("/organizations/:id/grants/:grant_id", {
    schema: {
      tags: TAGS,
      summary: "Withdraw a grant from a member or a deployment (admins). It stops working at their next request",
      params: {
        type: "object",
        required: ["id", "grant_id"],
        properties: { id: { type: "string" }, grant_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => ({ grants: await withdrawGrant({ organizationId: request.params.id, grantId: request.params.grant_id, by: me(request) }) })),
  });

  app.put<{ Params: { id: string; grant_id: string }; Body: { allowance_owls: number | null } }>(
    "/organizations/:id/grants/:grant_id/allowance",
    {
      schema: {
        tags: TAGS,
        summary:
          "Set the allowance on a grant of spend (admins): the owls of the organization that member or deployment may spend in all, " +
          "counting what they have spent, or null to spend from the whole balance. It has no period; raise it to let them spend more",
        params: {
          type: "object",
          required: ["id", "grant_id"],
          properties: { id: { type: "string" }, grant_id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["allowance_owls"],
          properties: { allowance_owls: { type: ["number", "null"], minimum: 0 } },
        },
      },
      preHandler: session,
      handler: (request, reply) =>
        answer(reply, async () => ({
          grants: await setAllowance({
            organizationId: request.params.id,
            grantId: request.params.grant_id,
            allowanceOwls: request.body.allowance_owls,
            by: me(request),
          }),
        })),
    }
  );

  // ---- credentials made to act as the organization ----

  app.get<{ Params: { id: string } }>("/organizations/:id/credentials", {
    schema: {
      tags: TAGS,
      summary:
        "The live API keys and MCP clients its members made to act as the organization, by whom (its members only). " +
        "Each acts as its maker acting as the organization, under their permissions there at each request",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ credentials: await listOrganizationCredentials(request.params.id, me(request)) })),
  });

  app.delete<{ Params: { id: string; kind: "api_key" | "mcp_client"; credential_id: string } }>(
    "/organizations/:id/credentials/:kind/:credential_id",
    {
      schema: {
        tags: TAGS,
        summary: "Revoke an API key or MCP client made to act as the organization (admins, or the member who made it)",
        params: {
          type: "object",
          required: ["id", "kind", "credential_id"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["api_key", "mcp_client"] },
            credential_id: { type: "string" },
          },
        },
      },
      preHandler: session,
      handler: (request, reply) =>
        answer(reply, async () => {
          await revokeOrganizationCredential({
            organizationId: request.params.id,
            kind: request.params.kind,
            id: request.params.credential_id,
            by: me(request),
          });
          return { credentials: await listOrganizationCredentials(request.params.id, me(request)) };
        }),
    }
  );

  // ---- invitations ----

  app.get<{ Params: { id: string } }>("/organizations/:id/invitations", {
    schema: {
      tags: TAGS,
      summary: "The invitations made for an organization and what became of each (its members only)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ invitations: await listInvitations(request.params.id, me(request)) })),
  });

  app.post<{ Params: { id: string }; Body: { role: OrganizationRole } }>("/organizations/:id/invitations", {
    schema: {
      tags: TAGS,
      summary:
        "Make a single-use invitation link that adds a person with the role it names (admins). " +
        "The link is returned once and expires after seven days; the person opens it signed in as themselves and accepts",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["role"], properties: { role: ROLE } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(
        reply,
        async () => {
          const made = await makeInvitation({ organizationId: request.params.id, role: request.body.role, by: me(request) });
          return { invitation: made.invitation, token: made.token };
        },
        201
      ),
  });

  app.delete<{ Params: { id: string; invitation_id: string } }>("/organizations/:id/invitations/:invitation_id", {
    schema: {
      tags: TAGS,
      summary: "Cancel an open invitation (admins)",
      params: {
        type: "object",
        required: ["id", "invitation_id"],
        properties: { id: { type: "string" }, invitation_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await cancelInvitation({ organizationId: request.params.id, invitationId: request.params.invitation_id, by: me(request) });
        return { cancelled: true };
      }),
  });

  app.get<{ Params: { token: string } }>("/organization-invitations/:token", {
    schema: {
      tags: TAGS,
      summary: "What an invitation link is for: the organization, the role, and whether it can still be accepted",
      params: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ invitation: await readInvitation(request.params.token) })),
  });

  app.post<{ Params: { token: string } }>("/organization-invitations/:token/accept", {
    schema: {
      tags: TAGS,
      summary: "Accept an invitation, as yourself. Single use",
      params: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) => answer(reply, async () => ({ organization: await acceptInvitation({ token: request.params.token, by: me(request) }) })),
  });

  // ---- the log and old keys ----

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>("/organizations/:id/log", {
    schema: {
      tags: TAGS,
      summary:
        "Every change to an organization and every act its admins made for it from minerval.ai, newest first, " +
        "with who made it (its members only)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ log: await listLog(request.params.id, me(request), request.query.limit ?? 100) })),
  });

  app.get<{ Params: { id: string } }>("/organizations/:id/old-keys", {
    schema: {
      tags: TAGS,
      summary:
        "The API keys the organization's account still holds from before it was an organization, with when each was last used. " +
        "They can do anything the organization can (its members only)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ keys: await listOldKeys(request.params.id, me(request)) })),
  });

  app.delete<{ Params: { id: string; key_id: string } }>("/organizations/:id/old-keys/:key_id", {
    schema: {
      tags: TAGS,
      summary: "Revoke one of the organization's old API keys (admins)",
      params: {
        type: "object",
        required: ["id", "key_id"],
        properties: { id: { type: "string" }, key_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await revokeOldKey({ organizationId: request.params.id, keyId: request.params.key_id, by: me(request) });
        return { revoked: true };
      }),
  });

  // ---- converting a shared account ----

  app.get("/account-conversion", {
    schema: {
      tags: TAGS,
      summary: "This account's open request to become an organization, if it has one, with what it would keep",
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ conversion: await getOpenConversion(me(request)) })),
  });

  app.post<{ Body: { name: string; first_admin_id: string } }>("/account-conversion", {
    schema: {
      tags: TAGS,
      summary:
        "Ask for this account, a login several people share, to become an organization, naming a person's own account as its first admin. " +
        "Nothing changes until that person accepts. A new request replaces an open one",
      body: {
        type: "object",
        required: ["name", "first_admin_id"],
        properties: { name: { type: "string", minLength: 1 }, first_admin_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => ({ conversion: await askConversion({ accountId: me(request), name: request.body.name, firstAdminId: request.body.first_admin_id }) }), 201),
  });

  app.delete("/account-conversion", {
    schema: { tags: TAGS, summary: "Withdraw this account's open request to become an organization" },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await cancelConversion(me(request));
        return { cancelled: true };
      }),
  });

  app.get("/account-conversions/for-me", {
    schema: { tags: TAGS, summary: "The open requests that name you as the first admin of an account becoming an organization" },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ conversions: await listConversionsForMe(me(request)) })),
  });

  app.post<{ Params: { id: string } }>("/account-conversions/:id/accept", {
    schema: {
      tags: TAGS,
      summary:
        "Accept, as the named first admin, that an account becomes an organization. It keeps its id, record, pages, owls and API keys; " +
        "the shared login no longer reaches it, and its OAuth tokens are revoked",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) => answer(reply, async () => ({ organization: await acceptConversion({ conversionId: request.params.id, by: me(request) }) })),
  });

  // ---- carried by hand (docs/organizations.md, "Connecting by hand") ----

  app.get<{ Params: { id: string; deployment_id: string }; Querystring: { after?: number } }>("/organizations/:id/deployments/:deployment_id/feed", {
    schema: {
      tags: TAGS,
      summary:
        "The next batch of the public graph's mirror feed after the one named (its members), exactly as signed, as a file to carry to " +
        "one of the organization's deployments that holds read_feed and follows from files. Every batch after one you name, never a " +
        "choice among nodes, so the download shows no more than a pull over the network. On the organization's log as a pull. 204 where " +
        "there is no later batch",
      params: {
        type: "object",
        required: ["id", "deployment_id"],
        properties: { id: { type: "string" }, deployment_id: { type: "string" } },
      },
      querystring: { type: "object", properties: { after: { type: "integer", minimum: 0 } } },
    },
    preHandler: reader,
    handler: async (request, reply) => {
      try {
        const batch = await nextFeedBatch({
          organizationId: request.params.id,
          deploymentId: request.params.deployment_id,
          after: Number(request.query.after ?? 0),
          by: me(request),
        });
        if (!batch) return reply.code(204).send();
        return reply
          .header("content-type", "application/json; charset=utf-8")
          .header("content-disposition", `attachment; filename="${batch.file_name}"`)
          .header("x-mirror-batch-sequence", String(batch.sequence))
          .send(batch.body);
      } catch (err) {
        if (err instanceof OrganizationError) return reply.code(err.status).send({ error: err.message, code: err.code });
        throw err;
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { report: unknown } }>("/organizations/:id/usage-reports", {
    schema: {
      tags: TAGS,
      summary:
        "Upload a usage report a deployment of the organization wrote as a file (its admins, from a signed-in session): recorded against " +
        "the organization exactly as one sent over the network is, privately, and published nowhere",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["report"], properties: { report: {} } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        const result = await uploadUsageReport({ organizationId: request.params.id, report: request.body.report, by: me(request) });
        if (!result.ok) throw new OrganizationError(result.code, result.message, result.code === "REPORT_DIFFERS" ? 409 : 422);
        return { recorded: result.recorded, period: result.period, revision: result.revision, received_at: result.received_at };
      }),
  });

  // ---- the operator's way back ----

  app.post<{ Params: { id: string }; Body: { account_id: string } }>("/operator/organizations/:id/admins", {
    schema: {
      tags: TAGS,
      summary:
        "Make a person an admin of an organization whose admins are all gone (the operator key). " +
        "Logged on the organization's log as made with the operator key",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["account_id"], properties: { account_id: { type: "string" } } },
    },
    preHandler: [app.requireOperator],
    handler: (request, reply) =>
      answer(reply, async () => {
        await operatorAddAdmin({ organizationId: request.params.id, accountId: request.body.account_id });
        return { added: true };
      }),
  });
}
