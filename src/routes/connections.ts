/**
 * Connections: the routes a members-only deployment's administrators point
 * it at an organization's own systems through (src/connections.ts;
 * docs/connections.md). Mounted only where READS=members (server/app.ts),
 * so the public graph has none of them.
 *
 *   GET   /connections: every connection, its state and its tools.
 *   GET   /connections/:connection_id: one.
 *   GET   /connections/:connection_id/calls: the calls agents made
 *     through it, newest first, with which were kept as sources.
 *   POST  /connections: add one. Its server is then asked for its tools.
 *   PATCH /connections/:connection_id: change its settings, or
 *     switch it off.
 *   POST  /connections/:connection_id/look: ask its server for its tools
 *     as they are now.
 *   PUT   /connections/:connection_id/tools: say which tools agents are
 *     offered, and on what terms: as tools that read, or under a write
 *     grant; whether a write waits for an administrator; what a call costs.
 *   GET   /connections/:connection_id/writes: the calls made to tools
 *     granted to write, with what was sent and what came back.
 *   POST  /connections/:connection_id/writes/:call_id/decision: approve or
 *     decline a write that waits for an administrator.
 *   PUT   /connections/:connection_id/credential: give the connection its
 *     credential, or replace it; kept sealed.
 *   DELETE /connections/:connection_id/credential: remove the credential
 *     given that way.
 *
 * Who may call what. All of them need the permission to administer. The
 * seven that change anything also need a signed-in session, as every other
 * administrative write does (routes/permissions.ts says why), so they are
 * not MCP tools; the four reads are (mcp/route-tools.ts).
 *
 * A credential is taken in, never returned. A connection either names the
 * environment variable that holds its credential, or is given the
 * credential itself (POST /connections, PUT .../credential), which is
 * sealed as it arrives and stored sealed (services/connection-credential.ts).
 * A read says where the credential comes from and whether a call would
 * carry it, and nothing of its value. Request bodies are not logged
 * (server/app.ts).
 */
import type { FastifyInstance } from "fastify";
import {
  CONNECTION_NAME_MAX_CHARS,
  CONNECTION_NOTICE,
  CONNECTION_STAKE_MAX_CHARS,
  CONNECTION_TIMEOUT_SECONDS,
  CONNECTION_ROLES,
  CONNECTION_ROLE_INFO,
  CONNECTION_TRANSPORTS,
  CALL_PRICE_MAX_MICRO_USD,
  WRITE_ACKNOWLEDGEMENT,
  WRITE_REASON_MAX_CHARS,
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_HEADER_PATTERN,
  TOOL_PREFIX_PATTERN,
} from "../connections.js";
import { CREDENTIAL_MAX_CHARS, credentialKeys } from "../services/connection-credential.js";

/**
 * The roles a connection may be offered to, as a page lists them: each
 * one's name, whether it may keep a reading as a source, and, for a role a
 * new connection starts unticked for, why.
 */
const ROLES = CONNECTION_ROLES.map((role) => ({
  role,
  name: CONNECTION_ROLE_INFO[role].name,
  keeps: CONNECTION_ROLE_INFO[role].keeps,
  ...(CONNECTION_ROLE_INFO[role].offFirst ? { off_at_first: CONNECTION_ROLE_INFO[role].offFirst } : {}),
}));

/** Whether this deployment can keep a credential given to a connection itself: its key is set, and is a key. */
const canKeepCredentials = (): boolean => credentialKeys().current !== null;
import { currentLabel } from "../llm/usage-context.js";
import { rawSourceLabelsOf } from "../raw-sources.js";
import { microUsdToOwls } from "../services/owl.js";
import { decideHeldCall } from "../services/reading-service.js";
import { requirePermission } from "../server/require-permission.js";
import {
  addConnection,
  changeConnection,
  CONNECTION_LABEL_IS_KEPT,
  connectionsNotShown,
  getConnection,
  listConnectionCalls,
  listConnectionWrites,
  listConnections,
  lookAtConnection,
  notShownNote,
  offerTools,
  removeStoredCredential,
  setStoredCredential,
  type ConnectionFailureCode,
  type ConnectionSettings,
} from "../services/connection-service.js";

const UUID = { type: "string", format: "uuid" } as const;
const CONNECTION_PARAMS = {
  type: "object",
  required: ["connection_id"],
  properties: { connection_id: UUID },
} as const;

/** The settings a connection has, as a request names them. */
const SETTINGS = {
  name: {
    type: "string",
    minLength: 1,
    maxLength: CONNECTION_NAME_MAX_CHARS,
    description: "What administrators and agents know the connection by, such as the system's name.",
  },
  tool_prefix: {
    type: "string",
    pattern: TOOL_PREFIX_PATTERN,
    description:
      "A short lower-case word that starts each of the connection's tool names as agents see them " +
      "(warehouse gives warehouse__run_query). Made from the name when left out.",
  },
  transport: { type: "string", enum: [...CONNECTION_TRANSPORTS], description: "How the MCP server is spoken to. streamable_http unless the server only speaks sse." },
  url: {
    type: "string",
    minLength: 1,
    maxLength: 2000,
    description: "The MCP server's address, http or https. It must not carry a credential.",
  },
  credential_env: {
    anyOf: [{ type: "string", pattern: CREDENTIAL_ENV_PATTERN }, { type: "null" }],
    description:
      "The NAME of an environment variable that holds the credential, never the credential. The name " +
      "starts CONNECTION_. Null when the credential is given to the connection itself (credential), or " +
      "the server asks for none. Naming one removes a credential given to the connection itself.",
  },
  credential_header: {
    type: "string",
    pattern: CREDENTIAL_HEADER_PATTERN,
    description:
      "The header the credential is sent in. In Authorization (the default) it is sent as a bearer token; in any other header, as it is.",
  },
  party_id: { ...UUID, description: "The party whose system this is (GET /parties)." },
  stake: {
    anyOf: [{ type: "string", maxLength: CONNECTION_STAKE_MAX_CHARS }, { type: "null" }],
    description:
      "Optional. What the party stands to gain or lose from what the system shows, in a sentence or two, " +
      "where that is worth saying: for an outside party's system, say, whose interest in what it shows the " +
      "agents could not guess. Given, it is recorded on every reading kept from the connection, as a fact " +
      "about the source and never a finding against it. Empty or null records none; an interest that bears " +
      "on one claim is then the Steward's to record for that claim.",
  },
  calls_per_minute: {
    anyOf: [{ type: "integer", minimum: 1, maximum: 6000 }, { type: "null" }],
    description:
      "The most calls a minute agents may make through the connection, all runs together, or null for no rate. Calls cost the system and no owls, so nothing else bounds them. Agents are told the rate and why.",
  },
  timeout_seconds: {
    type: "integer",
    minimum: CONNECTION_TIMEOUT_SECONDS.min,
    maximum: CONNECTION_TIMEOUT_SECONDS.max,
    description: `How long a call may go unanswered before it is given up (default ${CONNECTION_TIMEOUT_SECONDS.default}).`,
  },
  enabled: { type: "boolean", description: "False switches the connection off: no run is offered its tools. Readings already kept stand." },
  offered_to: {
    type: "array",
    uniqueItems: true,
    maxItems: CONNECTION_ROLES.length,
    items: { type: "string", enum: [...CONNECTION_ROLES] },
    description:
      "The agent roles a run is offered the connection in, when it works at a label that reads the " +
      "connection's. Left out when adding, every role but those that start unticked: " +
      CONNECTION_ROLES.filter((role) => CONNECTION_ROLE_INFO[role].offFirst)
        .map((role) => `${role} (${CONNECTION_ROLE_INFO[role].offFirst})`)
        .join(" ") +
      " Only the Stewards, and a Researcher whose work records sources, may keep a reading as a source; " +
      "the assistant role is offered a connection only for a person who may open raw sources at its label.",
  },
} as const;

interface SettingsBody {
  name?: string;
  tool_prefix?: string;
  transport?: string;
  url?: string;
  credential_env?: string | null;
  credential_header?: string;
  party_id?: string;
  label?: string;
  stake?: string | null;
  calls_per_minute?: number | null;
  timeout_seconds?: number;
  enabled?: boolean;
  offered_to?: string[];
}

function settingsOf(body: SettingsBody): ConnectionSettings {
  return {
    name: body.name,
    toolPrefix: body.tool_prefix,
    transport: body.transport,
    url: body.url,
    credentialEnv: body.credential_env,
    credentialHeader: body.credential_header,
    partyId: body.party_id,
    label: body.label,
    stake: body.stake,
    callsPerMinute: body.calls_per_minute,
    timeoutSeconds: body.timeout_seconds,
    enabled: body.enabled,
    offeredTo: body.offered_to,
  };
}

/** A credential, as a request gives it: taken in, sealed, and never returned. */
const CREDENTIAL = {
  type: "string",
  minLength: 1,
  maxLength: CREDENTIAL_MAX_CHARS,
  writeOnly: true,
  description:
    "The credential itself, such as an API token (the narrowest that allows what the connection's tools are " +
    "granted to do, and a read-only one where none is granted to write), to be kept sealed: encrypted under a key that " +
    "is only in the deployment's environment, and bound to this connection's address, so that a change of " +
    "address removes it. Sent in credential_header (in Authorization as a bearer token: give the token " +
    "without \"Bearer \"). Never returned or logged. Refused where the deployment has no key to keep it with.",
} as const;

function settingsStatus(code: ConnectionFailureCode): number {
  if (code === "NOT_FOUND" || code === "UNKNOWN_PARTY" || code === "UNKNOWN_LABEL") return 404;
  if (code === "NAME_TAKEN" || code === "TOOL_PREFIX_TAKEN" || code === "LABEL_IS_KEPT" || code === "NO_CREDENTIAL_KEY") {
    return 409;
  }
  return 400;
}

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const administrator = [app.authenticate, app.requireUser, requirePermission("administer")];
  // A change to what agents may read is made from a signed-in session,
  // never by a bare key (routes/permissions.ts).
  const administratorSession = [
    app.authenticate,
    app.requireSession,
    app.requireUser,
    requirePermission("administer"),
  ];

  app.get("/connections", {
    schema: {
      tags: ["connections"],
      summary:
        "The systems this deployment is connected to, each with its state and its tools (administrators)",
      description:
        "A connection points the deployment at an MCP server over a system where an organization's " +
        "data lives. Each is returned with whose system it is, its label, whether its server last " +
        "answered, and every tool the server listed when an administrator last looked: the server's " +
        "own marking of the tool as read-only (a hint), whether agents are offered it, whether it " +
        "was withdrawn because it changed, the write grant it is offered under where it has one " +
        "(`write_grant`: the administrator's reason, the words they acknowledged, who and when, and " +
        "whether its calls wait for an administrator), and what a call to it is charged to a run's " +
        "budget (`owls_per_call`). `write_acknowledgement` is what a write grant acknowledges now. The list holds the connections at labels the caller reads: " +
        "administering does not by that alone let a person read at a label. `not_shown` counts the " +
        "rest, and `not_shown_note` says so in a sentence when there are any. A tool's `calls` and " +
        "`readings_kept` count the calls the caller reads. `can_keep_credentials` says whether a " +
        "credential can be given to a connection itself, to be kept sealed: the deployment has the key " +
        "for it. `roles` lists the agent roles a connection may be offered to (`offered_to`): each one's " +
        "name, whether it may keep a reading as a source, and why a new connection starts it unticked where " +
        "it does. `notice` is what to tell whoever adds or " +
        `changes one. ${CONNECTION_NOTICE}`,
    },
    preHandler: administrator,
    handler: async (_request, reply) => {
      const connections = await listConnections();
      const notShown = await connectionsNotShown(connections.length);
      const note = notShownNote(notShown, "connections");
      return reply.send({
        notice: CONNECTION_NOTICE,
        write_acknowledgement: WRITE_ACKNOWLEDGEMENT,
        can_keep_credentials: canKeepCredentials(),
        roles: ROLES,
        connections,
        not_shown: notShown,
        ...(note ? { not_shown_note: note } : {}),
      });
    },
  });

  app.get<{ Params: { connection_id: string } }>("/connections/:connection_id", {
    schema: {
      tags: ["connections"],
      summary: "One connection, with its state and its tools (administrators)",
      params: CONNECTION_PARAMS,
    },
    preHandler: administrator,
    handler: async (request, reply) => {
      const connection = await getConnection(request.params.connection_id);
      if (!connection) return reply.code(404).send({ error: "Connection not found", code: "NOT_FOUND" });
      return reply.send({
        notice: CONNECTION_NOTICE,
        write_acknowledgement: WRITE_ACKNOWLEDGEMENT,
        can_keep_credentials: canKeepCredentials(),
        roles: ROLES,
        connection,
      });
    },
  });

  app.get<{
    Params: { connection_id: string };
    Querystring: { limit?: number; before?: string; kept?: boolean };
  }>("/connections/:connection_id/calls", {
    schema: {
      tags: ["connections"],
      summary:
        "The calls agents made through a connection, newest first, and which were kept as sources (administrators)",
      description:
        "Each call: the tool, when, how it ended, the size and SHA-256 of what came back, the run " +
        "and node it was made for, and the source it became if an agent's work rested on it. What " +
        "the system answered is never here; a kept reading is read as its source, and a call to a tool " +
        "granted to write (`writes`) is read with what came back at GET /connections/:connection_id/writes. " +
        "A call is a row at " +
        "the label of the run that made it, so the list holds the calls made at labels the caller " +
        "reads, and `not_shown` counts the rest. Page back with before=<the last call's called_at>.",
      params: CONNECTION_PARAMS,
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Calls to return (default 100)" },
          before: { type: "string", format: "date-time", description: "Only calls earlier than this time" },
          kept: { type: "boolean", description: "True for only the calls kept as sources" },
        },
      },
    },
    preHandler: administrator,
    handler: async (request, reply) => {
      const listed = await listConnectionCalls(request.params.connection_id, {
        limit: request.query.limit,
        before: request.query.before,
        keptOnly: request.query.kept === true,
      });
      if (listed === null) return reply.code(404).send({ error: "Connection not found", code: "NOT_FOUND" });
      const note = notShownNote(listed.notShown, "calls");
      return reply.send({ calls: listed.calls, not_shown: listed.notShown, ...(note ? { not_shown_note: note } : {}) });
    },
  });

  app.post<{ Body: SettingsBody & { name: string; url: string; party_id: string; credential?: string } }>(
    "/connections",
    {
      schema: {
        tags: ["connections"],
        summary:
          "Connect the deployment to a system's MCP server (administrators, from a signed-in session)",
        description:
          `${CONNECTION_NOTICE} The connection is saved with no tool offered, and its server is then ` +
          "asked for its tools, which are returned for picking (PUT /connections/:connection_id/tools). " +
          "A server that does not answer yet is still added, and `looked` says why it did not. The " +
          "change is logged. The connection's `label` is the one this request names, among the labels " +
          "the administrator reads: a run is offered the connection when the label it works at reads " +
          "that one, and the connection keeps it from then on. The credential is given either as " +
          "`credential`, kept sealed, or by naming the environment variable that holds it in " +
          "`credential_env`; not both.",
        // `label` is added to the body by the request-label plugin, as on
        // every route that starts something new (server/request-labels.ts).
        body: {
          type: "object",
          required: ["name", "url", "party_id"],
          additionalProperties: false,
          properties: { ...SETTINGS, credential: CREDENTIAL },
        },
      },
      preHandler: administratorSession,
      handler: async (request, reply) => {
        const actorId = request.auth!.userId!;
        // The label the request works at: the one it named, checked against
        // what the administrator reads, or the one label there is.
        const added = await addConnection(
          { ...settingsOf(request.body), label: request.body.label ?? currentLabel() } as ConnectionSettings & {
            name: string;
            url: string;
            partyId: string;
            label: string;
          },
          actorId,
          request.body.credential
        );
        if (!added.ok) return reply.code(settingsStatus(added.code)).send({ error: added.message, code: added.code });
        const looked = await lookAtConnection(added.id, actorId);
        return reply.code(201).send({
          notice: CONNECTION_NOTICE,
          connection: await getConnection(added.id),
          looked: lookedView(looked),
        });
      },
    }
  );

  app.patch<{ Params: { connection_id: string }; Body: SettingsBody }>("/connections/:connection_id", {
    schema: {
      tags: ["connections"],
      summary: "Change a connection's settings, or switch it off (administrators, from a signed-in session)",
      description:
        "Only the settings named are changed, and the log entry says which. A new address or " +
        "transport withdraws every tool that was offered until an administrator looks at what the " +
        "new address lists and picks again, and removes a credential given to the connection itself, " +
        "which was given for the old address (`stored_credential_removed`). A new party applies to readings from now on: those " +
        `already kept carry the party the connection had when they were read. ${CONNECTION_LABEL_IS_KEPT} ` +
        "A connection is never deleted; enabled false switches it off.",
      params: CONNECTION_PARAMS,
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: { ...SETTINGS, label: { type: "string", minLength: 1, description: CONNECTION_LABEL_IS_KEPT } },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const changed = await changeConnection(
        request.params.connection_id,
        settingsOf(request.body),
        request.auth!.userId!
      );
      if (!changed.ok) return reply.code(settingsStatus(changed.code)).send({ error: changed.message, code: changed.code });
      return reply.send({
        notice: CONNECTION_NOTICE,
        connection: await getConnection(changed.id),
        withdrawn: changed.withdrawn,
        stored_credential_removed: changed.storedCredentialRemoved,
      });
    },
  });

  app.post<{ Params: { connection_id: string } }>("/connections/:connection_id/look", {
    schema: {
      tags: ["connections"],
      summary:
        "Ask a connection's server for its tools as they are now (administrators, from a signed-in session)",
      description:
        "This is how an administrator looks at a connection again. Each tool the server lists is " +
        "stored as it now is and returned. A tool that is new is not offered. A tool that was offered " +
        "and whose definition has changed, or that the server no longer lists, stops being offered " +
        "and is named in `looked.withdrawn`; it is offered again only when picked on the definition " +
        "now shown. Also the way to test that the server answers and the credential is accepted.",
      params: CONNECTION_PARAMS,
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const looked = await lookAtConnection(request.params.connection_id, request.auth!.userId!);
      if (!looked.ok) return reply.code(404).send({ error: looked.message, code: looked.code });
      return reply.send({
        notice: CONNECTION_NOTICE,
        connection: await getConnection(request.params.connection_id),
        looked: lookedView(looked),
      });
    },
  });

  app.put<{
    Params: { connection_id: string };
    Body: {
      offered: Array<{
        name: string;
        definition_hash: string;
        writes?: { acknowledged: boolean; reason: string };
        held?: boolean;
        owls_per_call?: number;
      }>;
    };
  }>("/connections/:connection_id/tools", {
    schema: {
      tags: ["connections"],
      summary:
        "Say which of a connection's tools agents are offered, and on what terms (administrators, from a signed-in session)",
      description:
        `${CONNECTION_NOTICE} \`offered\` is the whole set, with the terms each tool is offered on: a tool ` +
        "left out is no longer offered, and a tool named without `writes` is picked as one that reads, so " +
        "a write grant it had is revoked. Each tool is named with the definition_hash shown for it, so a " +
        "pick is of the definition the administrator read: if the tool has changed since, the request is " +
        "refused and nothing changes. `writes` grants the tool to write: `acknowledged` true says the " +
        `administrator agrees to this (${JSON.stringify(WRITE_ACKNOWLEDGEMENT)}), and \`reason\` is theirs; ` +
        "both are kept on the tool and every agent offered it is told the reason. A tool the server itself " +
        "marks as writing is refused without it. A tool granted to write is offered only to a run that " +
        "works at the connection's own label, and never to the Assistant. `held` true makes each call to " +
        "it wait for an administrator (POST /connections/:connection_id/writes/:call_id/decision). " +
        "`owls_per_call` is what one call the system answers is charged to the run's budget. The change " +
        "is logged: the tools added and removed, each write grant with its reason, and each revocation.",
      params: CONNECTION_PARAMS,
      body: {
        type: "object",
        required: ["offered"],
        additionalProperties: false,
        properties: {
          offered: {
            type: "array",
            maxItems: 500,
            items: {
              type: "object",
              required: ["name", "definition_hash"],
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, description: "The tool's name at the server" },
                definition_hash: {
                  type: "string",
                  minLength: 1,
                  description: "The definition_hash the connection's read showed for the tool",
                },
                writes: {
                  type: "object",
                  required: ["acknowledged", "reason"],
                  additionalProperties: false,
                  description:
                    "Present to grant the tool to write; absent, the tool is picked as one that reads.",
                  properties: {
                    acknowledged: {
                      type: "boolean",
                      description: `True to acknowledge: ${WRITE_ACKNOWLEDGEMENT}`,
                    },
                    reason: {
                      type: "string",
                      minLength: 1,
                      maxLength: WRITE_REASON_MAX_CHARS,
                      description:
                        "Why agents should be able to write to this system through the tool, in a sentence or two. Kept, shown, and told to every agent offered the tool.",
                    },
                  },
                },
                held: {
                  type: "boolean",
                  description:
                    "True to have each call to the tool wait for an administrator before it is sent. Only with `writes`.",
                },
                owls_per_call: {
                  type: "number",
                  minimum: 0,
                  maximum: microUsdToOwls(CALL_PRICE_MAX_MICRO_USD),
                  description:
                    "What one call the system answers is charged to the run's budget, in owls; 0 or left out for a tool whose calls cost the organization's system and no money. Agents are told the price, and a call the rest of a run's budget cannot cover is not sent.",
                },
              },
            },
          },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const result = await offerTools(
        request.params.connection_id,
        request.body.offered.map((t) => ({
          name: t.name,
          definitionHash: t.definition_hash,
          ...(t.writes !== undefined ? { writes: t.writes } : {}),
          held: t.held,
          owlsPerCall: t.owls_per_call,
        })),
        request.auth!.userId!
      );
      if (!result.ok) {
        const status =
          result.code === "NOT_FOUND" || result.code === "UNKNOWN_TOOL"
            ? 404
            : result.code === "WRITE_NOT_ACKNOWLEDGED" ||
                result.code === "WRITE_REASON_NEEDED" ||
                result.code === "HELD_NEEDS_WRITE_GRANT" ||
                result.code === "INVALID_PRICE"
              ? 400
              : 409;
        return reply.code(status).send({ error: result.message, code: result.code });
      }
      return reply.send({
        notice: CONNECTION_NOTICE,
        connection: await getConnection(request.params.connection_id),
        offered: result.offered,
        no_longer_offered: result.noLongerOffered,
        write_granted: result.writeGranted,
        write_revoked: result.writeRevoked,
      });
    },
  });

  app.get<{
    Params: { connection_id: string };
    Querystring: { limit?: number; before?: string; held?: boolean };
  }>("/connections/:connection_id/writes", {
    schema: {
      tags: ["connections"],
      summary:
        "The calls agents made to a connection's tools granted to write, newest first, with what was sent and what came back (administrators)",
      description:
        "What an administrator watches a write grant by. Each call: the tool, when, which agent and run " +
        "made it and for which node, what was sent (`sent`, the arguments as the agent wrote them), how " +
        "it ended, what it was charged, and what came back (`came_back`: the first part of the stored " +
        "result with its size and SHA-256). What came back is the system's own text, so it is shown to a " +
        "caller who may open raw sources at the call's label and replaced by a notice saying so for one " +
        "who may not. A call that waited for an administrator says since when and how it was decided " +
        "(`held`); `waiting` counts those not yet decided, and held=true lists only them. A call is a row " +
        "at the label of the run that made it, so the list holds the calls the caller reads, and " +
        "`not_shown` counts the rest. To stop writes at once, switch the connection off (PATCH with " +
        "enabled false): no run is offered its tools, and a call that was waiting is not sent. Page back " +
        "with before=<the last call's called_at>.",
      params: CONNECTION_PARAMS,
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Calls to return (default 100)" },
          before: { type: "string", format: "date-time", description: "Only calls earlier than this time" },
          held: { type: "boolean", description: "True for only the calls waiting for an administrator" },
        },
      },
    },
    preHandler: administrator,
    handler: async (request, reply) => {
      const listed = await listConnectionWrites(request.params.connection_id, {
        limit: request.query.limit,
        before: request.query.before,
        heldOnly: request.query.held === true,
        rawSourceLabels: rawSourceLabelsOf(request.auth),
      });
      if (listed === null) return reply.code(404).send({ error: "Connection not found", code: "NOT_FOUND" });
      const note = notShownNote(listed.notShown, "calls");
      return reply.send({
        writes: listed.writes,
        waiting: listed.waiting,
        not_shown: listed.notShown,
        ...(note ? { not_shown_note: note } : {}),
      });
    },
  });

  app.post<{
    Params: { connection_id: string; call_id: string };
    Body: { decision: "approve" | "decline"; note?: string };
  }>("/connections/:connection_id/writes/:call_id/decision", {
    schema: {
      tags: ["connections"],
      summary:
        "Approve or decline a write that waits for an administrator (administrators, from a signed-in session)",
      description:
        "A call to a tool whose write grant holds its calls is recorded and not sent. Approved, it is sent " +
        "now, once, with the arguments the agent wrote, and the response says how it ended. Declined, " +
        "nothing is sent. The agent that made the call reads what became of it through the reading's id. " +
        "An approved call is sent only if the connection is on and the tool is still offered under a write " +
        "grant on the definition the agent wrote its arguments against; otherwise it is marked `not_sent` " +
        "with why. The decision, who made it, when, and the note are kept on the call. A call already " +
        "decided is refused (409).",
      params: {
        type: "object",
        required: ["connection_id", "call_id"],
        properties: { connection_id: UUID, call_id: { ...UUID, description: "The call's id, from the list of writes" } },
      },
      body: {
        type: "object",
        required: ["decision"],
        additionalProperties: false,
        properties: {
          decision: { type: "string", enum: ["approve", "decline"] },
          note: {
            type: "string",
            maxLength: 1000,
            description:
              "Optional. Why, in a sentence. Kept on the call, and told to the agent that made it when it asks what became of the call.",
          },
        },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const decided = await decideHeldCall(
        request.params.connection_id,
        request.params.call_id,
        request.body.decision,
        request.body.note ?? null,
        request.auth!.userId!
      );
      if (!decided.ok) {
        return reply.code(decided.code === "NOT_FOUND" ? 404 : 409).send({ error: decided.message, code: decided.code });
      }
      return reply.send({ call_id: decided.id, outcome: decided.outcome, ...(decided.problem ? { problem: decided.problem } : {}) });
    },
  });

  app.put<{ Params: { connection_id: string }; Body: { credential: string } }>("/connections/:connection_id/credential", {
    schema: {
      tags: ["connections"],
      summary:
        "Give a connection its credential, or replace it, to be kept sealed (administrators, from a signed-in session)",
      description:
        `${CONNECTION_NOTICE} The credential is sealed as it arrives: encrypted under a key that is only in ` +
        "the deployment's environment, bound to this connection, its address and its transport, and stored " +
        "sealed. It is never returned or logged; a read of the connection says that it was given, when, and " +
        "whether the key that sealed it is set. A connection that named an environment variable for its " +
        "credential no longer does. Changing the connection's address or transport removes it. Refused " +
        "where the deployment has no key to keep it with (CREDENTIAL_ENCRYPTION_KEY). Look at the " +
        "connection afterwards (POST .../look) to test that the server takes it. The change is logged, " +
        "without the credential.",
      params: CONNECTION_PARAMS,
      body: {
        type: "object",
        required: ["credential"],
        additionalProperties: false,
        properties: { credential: CREDENTIAL },
      },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const set = await setStoredCredential(request.params.connection_id, request.body.credential, request.auth!.userId!);
      if (!set.ok) return reply.code(settingsStatus(set.code)).send({ error: set.message, code: set.code });
      return reply.send({ notice: CONNECTION_NOTICE, connection: await getConnection(set.id), replaced: set.replaced });
    },
  });

  app.delete<{ Params: { connection_id: string } }>("/connections/:connection_id/credential", {
    schema: {
      tags: ["connections"],
      summary:
        "Remove the credential given to a connection itself (administrators, from a signed-in session)",
      description:
        "The connection's calls then go without a credential, until one is given again or an environment " +
        "variable is named for it. The change is logged.",
      params: CONNECTION_PARAMS,
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const removed = await removeStoredCredential(request.params.connection_id, request.auth!.userId!);
      if (!removed.ok) return reply.code(settingsStatus(removed.code)).send({ error: removed.message, code: removed.code });
      return reply.send({ notice: CONNECTION_NOTICE, connection: await getConnection(removed.id) });
    },
  });
}

/** What a look found, as a response carries it. */
function lookedView(looked: Awaited<ReturnType<typeof lookAtConnection>>) {
  if (!looked.ok) return { answered: false, problem: looked.message };
  if (!looked.answered) return { answered: false, problem: looked.failure.message, kind: looked.failure.kind };
  return { answered: true, withdrawn: looked.withdrawn };
}
