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
 *     offered.
 *
 * Who may call what. All of them need the permission to administer. The
 * four that change anything also need a signed-in session, as every other
 * administrative write does (routes/permissions.ts says why), so they are
 * not MCP tools; the three reads are (mcp/route-tools.ts).
 *
 * No route takes, stores or returns a credential. A connection names the
 * environment variable that holds its credential, and a read says whether
 * that variable is set.
 */
import type { FastifyInstance } from "fastify";
import {
  CONNECTION_NAME_MAX_CHARS,
  CONNECTION_NOTICE,
  CONNECTION_STAKE_MAX_CHARS,
  CONNECTION_TIMEOUT_SECONDS,
  CONNECTION_TRANSPORTS,
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_HEADER_PATTERN,
  TOOL_PREFIX_PATTERN,
} from "../connections.js";
import { standingOf } from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import {
  addConnection,
  changeConnection,
  getConnection,
  listConnectionCalls,
  listConnections,
  lookAtConnection,
  offerTools,
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
      "The NAME of the environment variable that holds the credential, never the credential. The name " +
      "starts CONNECTION_. Null when the server asks for none.",
  },
  credential_header: {
    type: "string",
    pattern: CREDENTIAL_HEADER_PATTERN,
    description:
      "The header the credential is sent in. In Authorization (the default) it is sent as a bearer token; in any other header, as it is.",
  },
  party_id: { ...UUID, description: "The party whose system this is (GET /parties)." },
  label: {
    type: "string",
    minLength: 1,
    description:
      "The connection's one label (GET /labels). A run is offered the connection when the label it works at reads this one, and every reading kept from it carries it.",
  },
  stake: {
    type: "string",
    minLength: 1,
    maxLength: CONNECTION_STAKE_MAX_CHARS,
    description:
      "What the party stands to gain or lose from what the system shows, in a sentence or two. It is recorded on every reading kept from the connection, as a fact about the source and never a finding against it.",
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
  stake?: string;
  calls_per_minute?: number | null;
  timeout_seconds?: number;
  enabled?: boolean;
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
  };
}

function settingsStatus(code: ConnectionFailureCode): number {
  if (code === "NOT_FOUND" || code === "UNKNOWN_PARTY" || code === "UNKNOWN_LABEL") return 404;
  if (code === "NAME_TAKEN" || code === "TOOL_PREFIX_TAKEN") return 409;
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
        "own marking of the tool as read-only (a hint), whether agents are offered it, and whether it " +
        "was withdrawn because it changed. `notice` is what to tell whoever adds or changes one. " +
        `${CONNECTION_NOTICE}`,
    },
    preHandler: administrator,
    handler: async (_request, reply) =>
      reply.send({ notice: CONNECTION_NOTICE, connections: await listConnections() }),
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
      return reply.send({ notice: CONNECTION_NOTICE, connection });
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
        "the system answered is never here; a kept reading is read as its source. A call's arguments " +
        "are what an agent wrote, so they are returned only to a caller cleared to read at the " +
        "call's label, and marked withheld otherwise. Page back with before=<the last call's called_at>.",
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
      const calls = await listConnectionCalls(
        request.params.connection_id,
        { limit: request.query.limit, before: request.query.before, keptOnly: request.query.kept === true },
        standingOf(request.auth).clearance
      );
      if (calls === null) return reply.code(404).send({ error: "Connection not found", code: "NOT_FOUND" });
      return reply.send({ calls });
    },
  });

  app.post<{ Body: SettingsBody & { name: string; url: string; party_id: string; label: string; stake: string } }>(
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
          "change is logged.",
        body: {
          type: "object",
          required: ["name", "url", "party_id", "label", "stake"],
          additionalProperties: false,
          properties: SETTINGS,
        },
      },
      preHandler: administratorSession,
      handler: async (request, reply) => {
        const actorId = request.auth!.userId!;
        const added = await addConnection(
          settingsOf(request.body) as ConnectionSettings & {
            name: string;
            url: string;
            partyId: string;
            label: string;
            stake: string;
          },
          actorId
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
        "new address lists and picks again. A new label or party applies to readings from now on: " +
        "those already kept carry what the connection had when they were read. A connection is " +
        "never deleted; enabled false switches it off.",
      params: CONNECTION_PARAMS,
      body: { type: "object", additionalProperties: false, minProperties: 1, properties: SETTINGS },
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
    Body: { offered: Array<{ name: string; definition_hash: string }> };
  }>("/connections/:connection_id/tools", {
    schema: {
      tags: ["connections"],
      summary:
        "Say which of a connection's tools agents are offered (administrators, from a signed-in session)",
      description:
        `${CONNECTION_NOTICE} \`offered\` is the whole set: a tool left out is no longer offered. ` +
        "Each tool is named with the definition_hash shown for it, so a pick is of the definition " +
        "the administrator read: if the tool has changed since, the request is refused and nothing " +
        "changes. The change is logged with the tools added and removed.",
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
        request.body.offered.map((t) => ({ name: t.name, definitionHash: t.definition_hash })),
        request.auth!.userId!
      );
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" || result.code === "UNKNOWN_TOOL" ? 404 : 409;
        return reply.code(status).send({ error: result.message, code: result.code });
      }
      return reply.send({
        notice: CONNECTION_NOTICE,
        connection: await getConnection(request.params.connection_id),
        offered: result.offered,
        no_longer_offered: result.noLongerOffered,
      });
    },
  });
}

/** What a look found, as a response carries it. */
function lookedView(looked: Awaited<ReturnType<typeof lookAtConnection>>) {
  if (!looked.ok) return { answered: false, problem: looked.message };
  if (!looked.answered) return { answered: false, problem: looked.failure.message, kind: looked.failure.kind };
  return { answered: true, withdrawn: looked.withdrawn };
}
