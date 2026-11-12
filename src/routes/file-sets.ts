/**
 * File sets: the routes a members-only deployment's people add sets of
 * files through (src/file-sets.ts; docs/file-sets.md). Mounted only where
 * READS=members (server/app.ts), so the public graph has none of them.
 *
 *   GET   /file-sets: every set the caller may see, with its state.
 *   GET   /file-sets/:file_set_id: one.
 *   GET   /file-sets/:file_set_id/files: its manifest, a page at a time.
 *   GET   /file-sets/:file_set_id/commands: the commands agents ran with
 *     it mounted, newest first, with which were kept as sources.
 *   POST  /file-sets: add one, empty and open for upload, or as a
 *     directory registered where it lies.
 *   PUT   /file-sets/:file_set_id/files/*: upload one file into an open
 *     set. The body is the file's bytes, streamed to the store.
 *   POST  /file-sets/:file_set_id/close: close an uploaded set.
 *   PATCH /file-sets/:file_set_id: switch a set off or on.
 *
 * Who may call what. All of them need the permission to direct, which
 * covers adding sources, and every one is held to the caller's clearance:
 * a set at a label the caller may not read is not listed and is not found.
 * The four that change anything also need a signed-in session, as a
 * connection's do (routes/connections.ts): what agents may read is widened
 * by a person at a screen, never by a bare key or by an agent following
 * text it read. So they are not MCP tools; the four reads are
 * (mcp/route-tools.ts).
 */
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import {
  FILE_SET_DESCRIPTION_MAX_CHARS,
  FILE_SET_NAME_MAX_CHARS,
  FILE_SET_NOTICE,
  FILE_SET_SLUG_PATTERN,
  FILE_SET_STAKE_MAX_CHARS,
} from "../file-sets.js";
import { standingOf } from "../permissions.js";
import { requirePermission } from "../server/require-permission.js";
import {
  addFileSet,
  changeFileSet,
  closeFileSet,
  directoryRoot,
  fillFromDirectory,
  getFileSet,
  listFileSetFiles,
  listFileSets,
  listSandboxCalls,
  storeDir,
  uploadFile,
  type FileSetFailureCode,
} from "../services/file-set-service.js";
import { sandboxConfigured } from "../services/sandbox-client.js";

const UUID = { type: "string", format: "uuid" } as const;
const FILE_SET_PARAMS = {
  type: "object",
  required: ["file_set_id"],
  properties: { file_set_id: UUID },
} as const;

function statusOf(code: FileSetFailureCode): number {
  switch (code) {
    case "NOT_FOUND":
    case "UNKNOWN_PARTY":
    case "DIRECTORY_NOT_FOUND":
      return 404;
    case "LABEL_NOT_YOURS":
      return 403;
    case "NAME_TAKEN":
    case "SLUG_TAKEN":
    case "PATH_TAKEN":
    case "CLOSED":
    case "NOT_AN_UPLOAD":
    case "EMPTY":
    case "STILL_HASHING":
    case "NO_STORE":
    case "NO_DIRECTORY_ROOT":
      return 409;
    case "TOO_LARGE":
      return 413;
    default:
      return 400;
  }
}

/** What this deployment can take, so a page offers only the ways in that work here. */
function waysIn() {
  return {
    upload: storeDir() !== null,
    register_directory: directoryRoot() !== null,
    sandbox_configured: sandboxConfigured(),
  };
}

export async function fileSetRoutes(app: FastifyInstance): Promise<void> {
  const director = [app.authenticate, app.requireUser, requirePermission("direct")];
  // A change to what agents may read is made from a signed-in session,
  // never by a bare key (routes/permissions.ts).
  const directorSession = [app.authenticate, app.requireSession, app.requireUser, requirePermission("direct")];

  app.get("/file-sets", {
    schema: {
      tags: ["file-sets"],
      summary: "The sets of files this deployment holds for its agents, each with its state (holders of direct)",
      description:
        "A file set is files of any kind taken in together: data, logs, transcripts, code. Agents " +
        "explore one by running commands in a sandbox the deployment runs, which has no network. Each " +
        "set is returned with whose files they are, its label, how it was filled, whether it is " +
        "closed, its file count, size and manifest hash, and how many commands were run against it " +
        "and how many sources kept from it. Only sets at a label the caller may read are listed. " +
        "`ways_in` says whether this deployment takes uploads, registers directories, and has a " +
        "sandbox configured. `notice` is what to tell whoever adds one. " +
        FILE_SET_NOTICE,
    },
    preHandler: director,
    handler: async (request, reply) =>
      reply.send({
        notice: FILE_SET_NOTICE,
        ways_in: waysIn(),
        file_sets: await listFileSets(standingOf(request.auth).clearance),
      }),
  });

  app.get<{ Params: { file_set_id: string } }>("/file-sets/:file_set_id", {
    schema: {
      tags: ["file-sets"],
      summary: "One file set, with its state (holders of direct)",
      params: FILE_SET_PARAMS,
    },
    preHandler: director,
    handler: async (request, reply) => {
      const fileSet = await getFileSet(request.params.file_set_id, standingOf(request.auth).clearance);
      if (!fileSet) return reply.code(404).send({ error: "File set not found", code: "NOT_FOUND" });
      return reply.send({ notice: FILE_SET_NOTICE, ways_in: waysIn(), file_set: fileSet });
    },
  });

  app.get<{ Params: { file_set_id: string }; Querystring: { limit?: number; after?: string } }>(
    "/file-sets/:file_set_id/files",
    {
      schema: {
        tags: ["file-sets"],
        summary: "A file set's manifest: each file's path, size and SHA-256 (holders of direct)",
        description:
          "In order of path. Page on with after=<the last path returned>. The set's manifest_sha256 " +
          "is one hash over every line `<sha256>  <path>` in this order, so anyone holding the files " +
          "can check them against it.",
        params: FILE_SET_PARAMS,
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, description: "Files to return (default 200)" },
            after: { type: "string", description: "Only files whose path sorts after this one" },
          },
        },
      },
      preHandler: director,
      handler: async (request, reply) => {
        const files = await listFileSetFiles(
          request.params.file_set_id,
          { limit: request.query.limit, after: request.query.after },
          standingOf(request.auth).clearance
        );
        if (files === null) return reply.code(404).send({ error: "File set not found", code: "NOT_FOUND" });
        return reply.send({ files });
      },
    }
  );

  app.get<{
    Params: { file_set_id: string };
    Querystring: { limit?: number; before?: string; kept?: boolean };
  }>("/file-sets/:file_set_id/commands", {
    schema: {
      tags: ["file-sets"],
      summary:
        "The commands agents ran in the sandbox with a file set mounted, newest first, and which were kept as sources (holders of direct)",
      description:
        "Each command: when, how it ended, the size and SHA-256 of what it printed, the sets it could " +
        "read, the run and node it was run for, and the source it became if an agent's work rested on " +
        "it. What it printed is never here; a kept analysis is read as its source. A command and the " +
        "files given with it are what an agent wrote, so they are returned only to a caller cleared " +
        "to read at the call's label, and marked withheld otherwise. Page back with " +
        "before=<the last command's called_at>.",
      params: FILE_SET_PARAMS,
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Commands to return (default 100)" },
          before: { type: "string", format: "date-time", description: "Only commands earlier than this time" },
          kept: { type: "boolean", description: "True for only the commands kept as sources" },
        },
      },
    },
    preHandler: director,
    handler: async (request, reply) => {
      const commands = await listSandboxCalls(
        {
          fileSetId: request.params.file_set_id,
          limit: request.query.limit,
          before: request.query.before,
          keptOnly: request.query.kept === true,
        },
        standingOf(request.auth).clearance
      );
      if (commands === null) return reply.code(404).send({ error: "File set not found", code: "NOT_FOUND" });
      return reply.send({ commands });
    },
  });

  app.post<{
    Body: {
      name: string;
      slug?: string;
      description?: string;
      party_id: string;
      stake: string;
      label: string;
      directory?: string;
    };
  }>("/file-sets", {
    schema: {
      tags: ["file-sets"],
      summary: "Add a set of files for the agents to read (holders of direct, from a signed-in session)",
      description:
        `${FILE_SET_NOTICE} Without \`directory\`, the set is added empty and open: upload its files ` +
        "(PUT /file-sets/:file_set_id/files/<path>) and then close it (POST /file-sets/:file_set_id/close). " +
        "With `directory`, a directory under the root this deployment registers directories from is " +
        "walked and each file hashed where it lies; that can take as long as the data is large, so " +
        "the answer does not wait for it. The set is returned in the state `hashing` and closes by " +
        "itself; read it again to see. No run is offered a set until it is closed. The act is logged.",
      body: {
        type: "object",
        required: ["name", "party_id", "stake", "label"],
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: FILE_SET_NAME_MAX_CHARS,
            description: "What people and agents know the set by.",
          },
          slug: {
            type: "string",
            pattern: FILE_SET_SLUG_PATTERN,
            description:
              "A short lower-case word that names the set's directory in the sandbox and starts the " +
              "address of every file kept from it. Made from the name when left out.",
          },
          description: {
            type: "string",
            maxLength: FILE_SET_DESCRIPTION_MAX_CHARS,
            description:
              "What the set holds, in a sentence or two. Agents are shown it as the words of whoever added the set.",
          },
          party_id: { ...UUID, description: "The party whose files these are (GET /parties)." },
          stake: {
            type: "string",
            minLength: 1,
            maxLength: FILE_SET_STAKE_MAX_CHARS,
            description:
              "What the party stands to gain or lose from what the files show, in a sentence or two. It is " +
              "recorded on every source kept from the set, as a fact about the source and never a finding against it.",
          },
          label: {
            type: "string",
            minLength: 1,
            description:
              "The set's one label, which must be one you may read. A run is offered the set when the label it works at reads this one.",
          },
          directory: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            description:
              "A directory to register where it lies, as a path relative to the root this deployment " +
              "registers directories from. Leave out to upload the files instead.",
          },
        },
      },
    },
    preHandler: directorSession,
    handler: async (request, reply) => {
      const clearance = standingOf(request.auth).clearance;
      const body = request.body;
      const added = await addFileSet(
        {
          name: body.name,
          slug: body.slug,
          description: body.description,
          partyId: body.party_id,
          stake: body.stake,
          label: body.label,
          directory: body.directory,
        },
        request.auth!.userId!,
        clearance
      );
      if (!added.ok) return reply.code(statusOf(added.code)).send({ error: added.message, code: added.code });
      if (added.origin === "directory") {
        // Not awaited: hashing takes as long as the data is large. The
        // set's state says where the walk is, and a failure is written to it.
        void fillFromDirectory(added.id).catch((err) => request.log.error({ err }, "file set walk failed"));
      }
      return reply.code(201).send({
        notice: FILE_SET_NOTICE,
        ways_in: waysIn(),
        file_set: await getFileSet(added.id, clearance),
      });
    },
  });

  // The upload route is in a scope of its own, so that its body, which is
  // a file's bytes of any type, is handed over as a stream and never parsed
  // or held in memory, and no other route's parsing changes.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    scope.put<{ Params: { file_set_id: string; "*": string } }>("/file-sets/:file_set_id/files/*", {
      schema: {
        tags: ["file-sets"],
        summary: "Upload one file into an open file set (holders of direct, from a signed-in session)",
        description:
          "The path after /files/ is the file's path inside the set; the body is the file's bytes, of " +
          "any type, streamed to the deployment's store and hashed as they arrive. The answer gives " +
          "the file's size and SHA-256. A path the set already has is refused: a file in a set is " +
          "not replaced. Upload is for sets of modest size; larger data is registered as a directory.",
        params: {
          type: "object",
          required: ["file_set_id", "*"],
          properties: { file_set_id: UUID, "*": { type: "string", description: "The file's path inside the set" } },
        },
      },
      preHandler: directorSession,
      handler: async (request, reply) => {
        const uploaded = await uploadFile(
          request.params.file_set_id,
          request.params["*"],
          request.body as Readable,
          standingOf(request.auth).clearance
        );
        if (!uploaded.ok) return reply.code(statusOf(uploaded.code)).send({ error: uploaded.message, code: uploaded.code });
        return reply.code(201).send({ file: uploaded.file });
      },
    });
  });

  app.post<{ Params: { file_set_id: string } }>("/file-sets/:file_set_id/close", {
    schema: {
      tags: ["file-sets"],
      summary: "Close a file set once its files are in (holders of direct, from a signed-in session)",
      description:
        "Fixes the set: its manifest hash is taken over every file, nothing is added to it afterwards, " +
        "and runs whose label reads its label are offered it from now on. For a registered directory " +
        "whose hashing failed or was cut short, this starts the walk again. The act is logged with the " +
        "file count and the manifest hash.",
      params: FILE_SET_PARAMS,
    },
    preHandler: directorSession,
    handler: async (request, reply) => {
      const clearance = standingOf(request.auth).clearance;
      const id = request.params.file_set_id;
      const closed = await closeFileSet(id, request.auth!.userId!, clearance);
      if (!closed.ok) return reply.code(statusOf(closed.code)).send({ error: closed.message, code: closed.code });
      if (closed.restart) {
        void fillFromDirectory(id).catch((err) => request.log.error({ err }, "file set walk failed"));
      }
      return reply.send({ notice: FILE_SET_NOTICE, file_set: await getFileSet(id, clearance) });
    },
  });

  app.patch<{ Params: { file_set_id: string }; Body: { enabled: boolean } }>("/file-sets/:file_set_id", {
    schema: {
      tags: ["file-sets"],
      summary: "Switch a file set off or on (holders of direct, from a signed-in session)",
      description:
        "Off, no run is offered the set. Nothing else about a set changes after it is added, and a " +
        "set is never deleted: the commands run against it and the sources kept from it stand. The " +
        "act is logged.",
      params: FILE_SET_PARAMS,
      body: {
        type: "object",
        required: ["enabled"],
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", description: "False switches the set off; true switches it back on." },
        },
      },
    },
    preHandler: directorSession,
    handler: async (request, reply) => {
      const clearance = standingOf(request.auth).clearance;
      const changed = await changeFileSet(
        request.params.file_set_id,
        { enabled: request.body.enabled },
        request.auth!.userId!,
        clearance
      );
      if (!changed.ok) return reply.code(statusOf(changed.code)).send({ error: changed.message, code: changed.code });
      return reply.send({ notice: FILE_SET_NOTICE, file_set: await getFileSet(request.params.file_set_id, clearance) });
    },
  });
}
