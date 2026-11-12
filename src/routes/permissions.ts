/**
 * Permissions, parties and labels: the routes a members-only deployment's
 * administrators work through (src/permissions.ts; docs/accounts.md,
 * "Members-only deployments"). Mounted only where READS=members
 * (server/app.ts), so the public graph has none of them.
 *
 *   GET    /permissions                    — what each permission covers.
 *   GET    /permissions/mine               — what the signed-in account holds.
 *   GET    /permissions/log                — every grant, removal and
 *     administrative change, newest first. Any member may read it.
 *   GET    /permissions/grants             — who holds what now.
 *   POST   /permissions/grants             — grant one permission.
 *   DELETE /permissions/grants/:grant_id   — remove a grant (the row stays).
 *   GET    /permissions/accounts           — the accounts, their groups and grants.
 *   GET    /parties, POST /parties         — whose material the graph holds.
 *   PUT    /sources/:source_id/party       — whose material one source is.
 *   GET    /labels, POST /labels           — the labels and which reads which.
 *   POST   /labels/:label/reads, DELETE /labels/:label/reads/:reads
 *   POST   /operator/administrators        — the operator key's way back in.
 *
 * Who may call what. The reads of who holds what, and every write, need
 * the permission to administer. The writes also need a signed-in session,
 * as minting an API key does: a key or an access token that leaked, or an
 * agent following text it read, must not be able to change who may read or
 * release. So the writes are not MCP tools (mcp/route-tools.ts). The log
 * is open to every member, because who holds power over a graph is part of
 * what its readers weigh.
 */
import type { FastifyInstance } from "fastify";
import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
  heldPermissions,
  standingOf,
} from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import { getContributorById } from "../services/contributor-service.js";
import {
  LABEL_DESCRIPTION_MAX_CHARS,
  LABEL_NAME_PATTERN,
  addLabelRead,
  defineLabel,
  listLabels,
  removeLabelRead,
} from "../services/label-admin-service.js";
import {
  PARTY_NAME_MAX_CHARS,
  addParty,
  listParties,
  setSourceParty,
} from "../services/party-service.js";
import {
  getGrant,
  grantAdministratorByOperator,
  grantPermission,
  listAccounts,
  listLiveGrants,
  permissionLog,
  removeGrant,
} from "../services/permission-service.js";

const UUID = { type: "string", format: "uuid" } as const;

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  // Membership itself is the members-only hook's to check, before any of
  // these run (server/plugins/members-only.ts).
  const signedIn = [app.authenticate, app.requireUser];
  const administrator = [...signedIn, requirePermission("administer")];
  // A change to who may do what is made from a signed-in session, never by
  // a bare key (see the module comment).
  const administratorSession = [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission("administer"),
  ];

  app.get("/permissions", {
    schema: {
      tags: ["permissions"],
      summary: "The permissions a members-only deployment grants, and what each covers",
    },
    preHandler: signedIn,
    handler: async (_request, reply) =>
      reply.send({
        permissions: PERMISSIONS.map((name) => ({
          name,
          scope: PERMISSION_DEFINITIONS[name].scope,
          covers: PERMISSION_DEFINITIONS[name].covers,
          never: PERMISSION_DEFINITIONS[name].never,
        })),
      }),
  });

  app.get("/permissions/mine", {
    schema: {
      tags: ["permissions"],
      summary:
        "What the signed-in account holds in this deployment: its permissions, the labels it may read, and its groups",
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const standing = standingOf(request.auth);
      const user = await getContributorById(request.auth!.userId!);
      const partyNames = new Map((await listParties()).map((p) => [p.id, p.name]));
      return reply.send({
        account: {
          id: request.auth!.userId,
          display_name: user?.displayName ?? null,
          // The identity an administrator, or the FIRST_ADMINISTRATOR
          // setting, names this person by.
          external_id: user?.externalId ?? null,
        },
        member: standing.member,
        permissions: heldPermissions(standing),
        grants: standing.grants.map((g) => ({
          permission: g.permission,
          ...(g.label !== null ? { label: g.label } : {}),
          ...(g.partyId !== null
            ? { party: { id: g.partyId, name: partyNames.get(g.partyId) ?? "" } }
            : {}),
          ...(g.group !== null ? { through_group: g.group } : {}),
        })),
        clearance: standing.clearance,
        raw_source_labels: standing.rawSourceLabels,
        groups: standing.groups,
      });
    },
  });

  app.get<{ Querystring: { limit?: number; before?: string } }>("/permissions/log", {
    schema: {
      tags: ["permissions"],
      summary:
        "The log of who was granted what, who removed it, and every change to labels, parties and whose material a source is, newest first",
      description:
        "Any member may read it. People appear by display name. The name of a label you are " +
        "not cleared to read, or of a party that is neither the organization itself nor one " +
        "you hold release for, is replaced by {withheld: true}; that the act happened, who " +
        "did it, to whom and when is always shown. Page back with before=<the last entry's at>.",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Entries to return (default 100)" },
          before: { type: "string", format: "date-time", description: "Only entries earlier than this time" },
        },
      },
    },
    preHandler: signedIn,
    handler: async (request, reply) =>
      reply.send({
        entries: await permissionLog(standingOf(request.auth), {
          limit: request.query.limit,
          before: request.query.before,
        }),
      }),
  });

  app.get("/permissions/grants", {
    schema: {
      tags: ["permissions"],
      summary: "Who holds what now: every live grant, to an account or to a group (administrators)",
    },
    preHandler: administrator,
    handler: async (_request, reply) => reply.send({ grants: await listLiveGrants() }),
  });

  app.post<{
    Body: { permission: string; account_id?: string; group?: string; label?: string; party_id?: string };
  }>("/permissions/grants", {
    schema: {
      tags: ["permissions"],
      summary: "Grant one permission to one account or one group (administrators, from a signed-in session)",
      description:
        "A grant is to an account (account_id) or to a group the identity provider names " +
        "(group), never both. read and read_sources are granted at one label; release for " +
        "one party (party_id); direct, fund and administer take no scope. The grant is " +
        "logged with who made it and is never deleted.",
      body: {
        type: "object",
        required: ["permission"],
        properties: {
          permission: { type: "string", enum: [...PERMISSIONS] },
          account_id: UUID,
          group: { type: "string", minLength: 1, maxLength: 256 },
          label: { type: "string", minLength: 1 },
          party_id: UUID,
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await grantPermission({
        permission: request.body.permission,
        accountId: request.body.account_id ?? null,
        groupName: request.body.group ?? null,
        label: request.body.label ?? null,
        partyId: request.body.party_id ?? null,
        grantedBy: request.auth!.userId!,
        via: "administrator",
      });
      if (!result.ok) {
        const status =
          result.code === "ALREADY_HELD"
            ? 409
            : result.code.startsWith("UNKNOWN_")
              ? 404
              : 400;
        return reply.code(status).send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({ grant: await getGrant(result.value.id) });
    },
  });

  app.delete<{ Params: { grant_id: string } }>("/permissions/grants/:grant_id", {
    schema: {
      tags: ["permissions"],
      summary:
        "Remove a grant (administrators, from a signed-in session). The row stays, with who removed it and when",
      params: { type: "object", required: ["grant_id"], properties: { grant_id: UUID } },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await removeGrant({
        grantId: request.params.grant_id,
        removedBy: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.send({ grant: await getGrant(result.value.id) });
    },
  });

  app.get<{ Querystring: { q?: string; limit?: number } }>("/permissions/accounts", {
    schema: {
      tags: ["permissions"],
      summary:
        "The accounts that have signed in, with the groups each sign-in carried and the grants made to each directly (administrators)",
      querystring: {
        type: "object",
        properties: {
          q: { type: "string", maxLength: 200, description: "Part of a name, an email or a sign-in identity" },
          limit: { type: "integer", minimum: 1, maximum: 1000, description: "Accounts to return (default 200)" },
        },
      },
    },
    preHandler: administrator,
    handler: async (request, reply) =>
      reply.send({ accounts: await listAccounts({ q: request.query.q, limit: request.query.limit }) }),
  });

  // ---- parties ----

  app.get("/parties", {
    schema: {
      tags: ["permissions"],
      summary: "The parties whose material this deployment holds (administrators)",
    },
    preHandler: administrator,
    handler: async (_request, reply) => reply.send({ parties: await listParties() }),
  });

  app.post<{ Body: { name: string; is_own_organization?: boolean } }>("/parties", {
    schema: {
      tags: ["permissions"],
      summary: "Add a party: the organization itself, or an outside party that supplies material (administrators, from a signed-in session)",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: PARTY_NAME_MAX_CHARS },
          is_own_organization: {
            type: "boolean",
            description: "True for the one party that is the organization running this deployment",
          },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await addParty({
        name: request.body.name,
        isOwnOrganization: request.body.is_own_organization,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "INVALID_NAME" ? 400 : 409)
          .send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({ party: result.party });
    },
  });

  app.put<{ Params: { source_id: string }; Body: { party_id: string | null } }>(
    "/sources/:source_id/party",
    {
      schema: {
        tags: ["permissions"],
        summary: "Say whose material a source is (administrators, from a signed-in session)",
        description:
          "party_id names a party, or is null to record that the source is no party's. The " +
          "change is logged with the party it was before.",
        params: { type: "object", required: ["source_id"], properties: { source_id: UUID } },
        body: {
          type: "object",
          required: ["party_id"],
          properties: { party_id: { anyOf: [UUID, { type: "null" }] } },
        },
      },
      preHandler: administratorSession,
      handler: async (request, reply) => {
        const result = await setSourceParty({
          sourceId: request.params.source_id,
          partyId: request.body.party_id,
          actorId: request.auth!.userId!,
        });
        if (!result.ok) return reply.code(404).send({ error: result.message, code: result.code });
        return reply.send({ source_id: result.source_id, party: result.party });
      },
    }
  );

  // ---- labels ----

  app.get("/labels", {
    schema: {
      tags: ["permissions"],
      summary: "The labels this deployment defines, and which label reads which (administrators)",
    },
    preHandler: administrator,
    handler: async (_request, reply) => reply.send({ labels: await listLabels() }),
  });

  app.post<{ Body: { name: string; description: string; reads?: string[] } }>("/labels", {
    schema: {
      tags: ["permissions"],
      summary: "Define a label, with the labels its holders may also read (administrators, from a signed-in session)",
      description:
        "A label is never removed, since rows carry it. Labels are not ranked: which label " +
        "reads which is only what is recorded here.",
      body: {
        type: "object",
        required: ["name", "description"],
        properties: {
          name: { type: "string", pattern: LABEL_NAME_PATTERN },
          description: { type: "string", minLength: 1, maxLength: LABEL_DESCRIPTION_MAX_CHARS },
          reads: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await defineLabel({
        name: request.body.name,
        description: request.body.description,
        reads: request.body.reads,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.code(201).send({ labels: await listLabels() });
    },
  });

  app.post<{ Params: { label: string }; Body: { reads: string } }>("/labels/:label/reads", {
    schema: {
      tags: ["permissions"],
      summary:
        "Record that holders of one label may also read another (administrators, from a signed-in session)",
      description:
        "This widens what every holder of the label may read, at once, and is logged.",
      params: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
      body: {
        type: "object",
        required: ["reads"],
        properties: { reads: { type: "string", minLength: 1 } },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await addLabelRead({
        label: request.params.label,
        reads: request.body.reads,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.code(201).send({ labels: await listLabels() });
    },
  });

  app.delete<{ Params: { label: string; reads: string } }>("/labels/:label/reads/:reads", {
    schema: {
      tags: ["permissions"],
      summary:
        "Take back that holders of one label may read another (administrators, from a signed-in session)",
      params: {
        type: "object",
        required: ["label", "reads"],
        properties: { label: { type: "string" }, reads: { type: "string" } },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await removeLabelRead({
        label: request.params.label,
        reads: request.params.reads,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.send({ labels: await listLabels() });
    },
  });

  // ---- the operator key ----

  // The way back in for a deployment whose administrators can no longer
  // sign in. It grants the one permission that lets a person grant the
  // others, and nothing else, so the operator key never becomes a second
  // way to hand out reading or releasing.
  app.post<{ Body: { external_id: string } }>("/operator/administrators", {
    schema: {
      tags: ["permissions"],
      summary: "Grant the permission to administer to an account, by its sign-in identity (operator key)",
      body: {
        type: "object",
        required: ["external_id"],
        properties: { external_id: { type: "string", minLength: 3, maxLength: 500 } },
      },
    },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const result = await grantAdministratorByOperator(request.body.external_id);
      if (!result.ok) {
        const status = result.code === "ALREADY_HELD" ? 409 : result.code === "UNKNOWN_ACCOUNT" ? 404 : 400;
        return reply.code(status).send({ error: result.message, code: result.code });
      }
      return reply.code(201).send({ grant: await getGrant(result.value.id) });
    },
  });
}

function labelStatus(code: string): number {
  if (code === "UNKNOWN_LABEL" || code === "NOT_READ") return 404;
  if (code === "LABEL_EXISTS" || code === "ALREADY_READS") return 409;
  return 400;
}
