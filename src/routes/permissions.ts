/**
 * Permissions, parties and labels: the routes a members-only deployment's
 * administrators work through (src/permissions.ts; docs/accounts.md,
 * "Members-only deployments"). Mounted only where READS=members
 * (server/app.ts), so the public graph has none of them.
 *
 *   GET    /permissions: what each permission covers.
 *   GET    /permissions/mine: what the signed-in account holds.
 *   GET    /permissions/log: every grant, removal and
 *     administrative change, newest first, owls created and standing
 *     mandates set up included (routes/owls.ts), filtered by kind, actor
 *     and text before the limit. Any member may read it.
 *   GET    /permissions/grants: who holds what now.
 *   POST   /permissions/grants: grant one permission.
 *   DELETE /permissions/grants/:grant_id: remove a grant (the row stays).
 *   GET    /permissions/accounts: the accounts, their groups and grants.
 *   GET    /parties, POST /parties: whose material the graph holds.
 *   PUT    /sources/:source_id/party: whose material one source is.
 *   GET    /labels, POST /labels: the labels and which reads which.
 *   GET    /labels/mine: the labels the caller may file new material at.
 *   POST   /labels/:label/reads, DELETE /labels/:label/reads/:reads
 *   GET    /labels/providers: which model providers and outside services
 *     each label may be sent to, and whether the settings fix that.
 *   PUT    /labels/:label/providers: choose them for one label
 *     (clear_providers, from a signed-in session).
 *   POST   /operator/administrators: the operator key's way back in.
 *
 * Who may call what. The reads of who holds what, and every write, need
 * the permission to administer, except clearing providers for a label,
 * which needs a permission of its own (clear_providers): defining a label
 * with providers ticked needs both. The writes also need a signed-in session,
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
  holdsPermission,
  standingOf,
} from "../permissions.js";
import { deploymentHoldsLabels } from "../db/client.js";
import { requireAnyPermission, requirePermission } from "../server/require-permission.js";
import { choosableLabels } from "../services/label-service.js";
import { getContributorById } from "../services/contributor-service.js";
import { listProviderClearance, setProviderClearance } from "../services/provider-clearance-service.js";
import {
  LABEL_DESCRIPTION_MAX_CHARS,
  LABEL_NAME_PATTERN,
  addLabelRead,
  defineLabel,
  FACE_LINE_MAX_CHARS,
  FACE_NAME_MAX_CHARS,
  listLabelFaces,
  showLabelFace,
  withdrawLabelFace,
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
  LOG_TEXT_SCAN,
  LOG_TYPES,
  type LogType,
  getGrant,
  grantAdministratorByOperator,
  grantPermission,
  listAccounts,
  listLiveGrants,
  permissionLog,
  removeGrant,
} from "../services/permission-service.js";
import { PUBLIC_LABEL, baseLabel, publishedLabel, layersAreSplit } from "../labels.js";

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
        // Which labels are the bottom layers here (src/labels.ts), so that a
        // page can say "the public graph", "published" and "members" of
        // whatever this deployment calls them.
        label_layers: {
          public_graph: PUBLIC_LABEL,
          published: publishedLabel(),
          base: baseLabel(),
          split: layersAreSplit(),
        },
      });
    },
  });

  app.get<{ Querystring: { limit?: number; before?: string; type?: string; by?: string; q?: string } }>("/permissions/log", {
    schema: {
      tags: ["permissions"],
      summary:
        "The log of who was granted what, who removed it, every change to labels, parties, connections, file sets and whose material a source is, and every creation of owls or of a standing mandate, newest first, filtered by kind, by who acted and by text",
      description:
        "Any member may read it. People appear by display name. The name of a label you are " +
        "not cleared to read, or of a party that is neither the organization itself nor one " +
        "you consent for, is replaced by {withheld: true}, and so is a source's title " +
        "unless you read the source's label; that the act happened, who did it, to whom and " +
        "when is always shown. Each entry has a `type`, one of " +
        LOG_TYPES.join(", ") +
        ". `type` (one, or several separated by commas), `by` and `q` are applied before " +
        "`limit`. `by` is an account's id (an entry's `by_id`), or `operator`, `first_administrator` or " +
        "`deployment` for what acts where no person does. `q` matches the entry's words as " +
        "you are shown them, never a withheld name; with `q` one request reads at most " +
        LOG_TEXT_SCAN.toLocaleString("en-US") +
        " entries of the log, so a page can hold fewer than `limit` with more to read. " +
        "`next_before` is where the next page starts (pass it as `before`); null when the " +
        "log has nothing older that matches.",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Entries to return (default 100)" },
          before: { type: "string", format: "date-time", description: "Only entries earlier than this time" },
          type: {
            type: "string",
            pattern: `^(${LOG_TYPES.join("|")})(,(${LOG_TYPES.join("|")}))*$`,
            description: `Only entries of these kinds, separated by commas: ${LOG_TYPES.join(", ")}`,
          },
          by: {
            type: "string",
            maxLength: 64,
            description: "Only acts by this account (its id), or by operator, first_administrator or deployment",
          },
          q: { type: "string", maxLength: 200, description: "Only entries whose words hold this text, case aside" },
        },
      },
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const types = request.query.type
        ? (request.query.type.split(",") as LogType[]).filter((t) => (LOG_TYPES as readonly string[]).includes(t))
        : undefined;
      const log = await permissionLog(standingOf(request.auth), {
        limit: request.query.limit,
        before: request.query.before,
        types,
        by: request.query.by,
        q: request.query.q,
      });
      return reply.send({ entries: log.entries, next_before: log.next_before });
    },
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
        "(group), never both. read and read_sources are granted at one label; consent " +
        "for one party (party_id); direct, fund and administer take no scope. The grant is " +
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
      summary: "The parties whose material this deployment holds (administrators; by name, people who direct the graph)",
      description:
        "An administrator reads each party in full. A person who holds the permission to direct reads each " +
        "party's id and name and whether it is the organization itself, and nothing else: adding a source or a " +
        "set of files says whose material it is, so whoever adds one has to be able to name the party.",
    },
    preHandler: [...signedIn, requireAnyPermission(["administer", "direct"])],
    handler: async (request, reply) => {
      const parties = await listParties();
      if (holdsPermission(standingOf(request.auth), "administer")) return reply.send({ parties });
      return reply.send({ parties: parties.map((p) => ({ id: p.id, name: p.name, is_own_organization: p.is_own_organization })) });
    },
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

  // What a page, or an agent, needs where a label is chosen or shown
  // (server/request-labels.ts): the labels this request may file new
  // material at, and what each means for who reads it.
  app.get("/labels/mine", {
    schema: {
      tags: ["permissions"],
      summary:
        "The labels you may file new material at, and who reads each: for choosing a label when you start something new",
      description:
        "must_choose is true when this deployment holds material at more than one label and the " +
        "request is a signed-in session: a request that starts something new (a source, a " +
        "proposed node, a granting conversation, a conversation with the Assistant, an API key) " +
        "must then name one of these in `label`, and there is no default. works_at is set " +
        "instead when the request was made with an API key or an access token, or by the " +
        "Assistant: that credential works at one label, fixed when it was made, and names none. " +
        "For each label: what else its readers read, who reads it (who_reads, in words), and the " +
        "labels that read it, of which only those you may read are named. On a deployment whose " +
        "bottom layers are labels of their own, the public graph's label and the published one are " +
        "not listed: nothing is filed at either.",
    },
    preHandler: signedIn,
    handler: async (request, reply) => {
      const held = await deploymentHoldsLabels();
      const fixed = held ? request.auth?.fixedLabel : undefined;
      return reply.send({
        must_choose: held && !fixed,
        works_at: fixed?.label ?? null,
        labels: await choosableLabels(),
      });
    },
  });

  app.post<{ Body: { name: string; description: string; reads?: string[]; providers?: string[] } }>("/labels", {
    schema: {
      tags: ["permissions"],
      summary: "Define a label, with the labels its holders may also read (administrators, from a signed-in session)",
      description:
        "A label is never removed, since rows carry it. Labels are not ranked: which label " +
        "reads which is only what is recorded here. `providers` names the model providers and " +
        "outside services cleared to be sent the new label's text (GET /labels/providers lists " +
        "them); naming any takes the permission to clear providers as well, and is refused where " +
        "the deployment's settings fix the clearance. A label defined with none is served by no " +
        "provider until one is cleared for it.",
      body: {
        type: "object",
        required: ["name", "description"],
        properties: {
          name: { type: "string", pattern: LABEL_NAME_PATTERN },
          description: { type: "string", minLength: 1, maxLength: LABEL_DESCRIPTION_MAX_CHARS },
          reads: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 },
          providers: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const providers = request.body.providers ?? [];
      if (providers.length > 0 && !holdsPermission(standingOf(request.auth), "clear_providers")) {
        return reply.code(403).send({
          error:
            "Clearing a model provider or an outside service for a label takes the permission to " +
            `${PERMISSION_DEFINITIONS.clear_providers.phrase}, which you do not hold. Define the label ` +
            "without providers, and a holder of that permission clears them.",
          code: "PERMISSION_REQUIRED",
        });
      }
      const result = await defineLabel({
        name: request.body.name,
        description: request.body.description,
        reads: request.body.reads,
        providers,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.code(201).send({ labels: await listLabels() });
    },
  });

  app.get("/labels/providers", {
    schema: {
      tags: ["permissions"],
      summary:
        "Which model providers and outside services each label may be sent text at, and what each is sent " +
        "(administrators and holders of the permission to clear providers)",
      description:
        "providers lists every model provider and outside service this deployment knows, with what it would " +
        "be sent and whether it is set up here. labels gives each label besides public the providers cleared " +
        "for it now. public_graph says what is in force for public, the public graph's own text: every " +
        "provider, unless the settings narrow it, and whether any run of this deployment works there. " +
        "fixed_by_settings is true where the deployment's " +
        "settings (PROVIDER_LABELS, or [provider_labels] in its config file) fix the clearance, and then " +
        "nothing can be changed through PUT /labels/:label/providers.",
    },
    preHandler: [...signedIn, requireAnyPermission(["administer", "clear_providers"])],
    handler: async (_request, reply) => reply.send(await listProviderClearance()),
  });

  app.put<{ Params: { label: string }; Body: { providers: string[] } }>("/labels/:label/providers", {
    schema: {
      tags: ["permissions"],
      summary:
        "Choose which model providers and outside services a label may be sent text at (holders of the " +
        "permission to clear providers, from a signed-in session)",
      description:
        "Exactly the providers named are cleared for the label afterwards, so an empty list clears none. " +
        "Each change is logged, and it is in force without a restart. Refused for public, which every " +
        "provider is cleared for, and where the deployment's settings fix the clearance.",
      params: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
      body: {
        type: "object",
        required: ["providers"],
        properties: { providers: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 } },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser, requirePermission("clear_providers")],
    handler: async (request, reply) => {
      const result = await setProviderClearance({
        label: request.params.label,
        providers: request.body.providers,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.send({
        cleared: result.cleared,
        no_longer_cleared: result.no_longer_cleared,
        ...(await listProviderClearance()),
      });
    },
  });

  app.get("/labels/faces", {
    schema: {
      tags: ["permissions"],
      summary: "The faces labels have been given at labels they read, by which work is asked of them from there (administrators)",
    },
    preHandler: administrator,
    handler: async (_request, reply) => reply.send({ faces: await listLabelFaces() }),
  });

  app.put<{ Params: { label: string }; Body: { at: string; name: string; can_be_asked: string } }>("/labels/:label/face", {
    schema: {
      tags: ["permissions"],
      summary: "Give a label a face at a label it reads, so that work can be asked of it from there (administrators, from a signed-in session)",
      description: FACE_TOLD,
      params: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
      body: {
        type: "object",
        required: ["at", "name", "can_be_asked"],
        properties: {
          at: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1, maxLength: FACE_NAME_MAX_CHARS },
          can_be_asked: { type: "string", minLength: 1, maxLength: FACE_LINE_MAX_CHARS },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await showLabelFace({
        label: request.params.label,
        at: request.body.at,
        name: request.body.name,
        canBeAsked: request.body.can_be_asked,
        actorId: request.auth!.userId!,
      });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.send({ faces: await listLabelFaces() });
    },
  });

  app.delete<{ Params: { label: string; at: string } }>("/labels/:label/face/:at", {
    schema: {
      tags: ["permissions"],
      summary: "Withdraw a label's face at a label: nothing new can be asked of it from there (administrators, from a signed-in session)",
      description: "What was already asked stays as it is, and its work goes on.",
      params: { type: "object", required: ["label", "at"], properties: { label: { type: "string" }, at: { type: "string" } } },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await withdrawLabelFace({ label: request.params.label, at: request.params.at, actorId: request.auth!.userId! });
      if (!result.ok) return reply.code(labelStatus(result.code)).send({ error: result.message, code: result.code });
      return reply.send({ faces: await listLabelFaces() });
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

/** What giving a label a face shows, and to whom. */
const FACE_TOLD =
  "A label cannot be read or named from the labels it reads. Giving it a face at one of them shows there, and at every label that " +
  "reads that one, that it exists under this name and can be asked for work: people who may fund, mandates and agents' runs there " +
  "can then ask for and pay for work at it, done by agents that read what it reads. What that work finds comes down only through " +
  "the label's gate. The name and the line are yours to write and are all that is shown; the label's own name is not.";

function labelStatus(code: string): number {
  if (code === "UNKNOWN_LABEL" || code === "NOT_READ" || code === "NO_FACE") return 404;
  if (code === "LABEL_EXISTS" || code === "ALREADY_READS" || code === "FIXED_BY_SETTINGS") return 409;
  return 400;
}
