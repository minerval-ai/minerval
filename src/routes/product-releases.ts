/**
 * Minerval's releases (services/product-release-service.ts;
 * docs/releases.md). Releases of the software: the gate's releases of pages
 * are at /releases (routes/releases.ts), which is why these are under
 * /setup, beside GET /setup/version.
 *
 * The list. On the public graph this is the list itself, open to anyone
 * with no key; a members-only deployment serves its own copy of it to its
 * members by the same routes:
 *
 *   GET  /setup/releases            every release, newest first, with its
 *     facts and without its prose, and the signed entries that say so.
 *   GET  /setup/releases/latest     the newest release that is not withdrawn.
 *   GET  /setup/releases/:version   one release, with its prose.
 *   POST /operator/releases         add signed entries to the list (the
 *     operator key). Minerval's release workflow calls it on a tag.
 *
 * In a members-only deployment besides, for its administrators, on its own
 * copy:
 *
 *   POST /setup/releases/upload     keep a file of the list, for a deployment
 *     that reaches nothing outside.
 *   POST /setup/releases/steps      mark an operator step of a release done.
 *
 * What a deployment knows of releases it shows on Health, in the setup
 * checklist's `version` part (GET /setup/checklist).
 *
 * Every entry is checked against the release key in the code before it is
 * kept, on either side: the operator key says who may add to the list, and
 * the signature says the entry is Minerval's.
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import { membersOnly } from "../permissions.js";
import { loadConfig } from "../config.js";
import { latestRelease } from "../release-entries.js";
import {
  acceptReleaseEntries,
  markReleaseStepDone,
  publicRelease,
  publicReleaseList,
} from "../services/product-release-service.js";

const ENTRIES_BODY = {
  type: "object",
  required: ["entries"],
  additionalProperties: true,
  properties: {
    entries: {
      type: "array",
      maxItems: 2000,
      description: "Signed entries, as GET /setup/releases gives them or as the release workflow signs them.",
      items: { type: "object" },
    },
  },
} as const;

const VERSION = { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" } as const;

export async function productReleaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/releases", {
    schema: {
      tags: ["setup"],
      summary: "Every release of Minerval, newest first, with what each asks of a deployment",
      description:
        "Open to anyone, with no key. `releases` has each release at its latest revision: its version and day, whether it " +
        "is a security release, the oldest version it can be reached from (`upgrades_from`), the settings it added, " +
        "retired or gave a new default, the steps it asks of a deployment's operator, each correction made since it was " +
        "cut, and `withdrawn` where it was found to be bad, with the reason and the version to move to. `entries` are the " +
        "statements Minerval signed that say so, which a deployment checks against the release key in its own code. A " +
        "release's prose is at GET /setup/releases/:version.",
    },
    handler: async (_request, reply) => reply.send(await publicReleaseList()),
  });

  app.get("/setup/releases/latest", {
    schema: {
      tags: ["setup"],
      summary: "The newest release of Minerval that is not withdrawn",
    },
    handler: async (_request, reply) => {
      const latest = latestRelease((await publicReleaseList()).releases);
      if (!latest) return reply.code(404).send({ error: "No release is on the list yet.", code: "NO_RELEASE" });
      return reply.send(await publicRelease(latest.version));
    },
  });

  app.get<{ Params: { version: string } }>("/setup/releases/:version", {
    schema: {
      tags: ["setup"],
      summary: "One release of Minerval, with its notes",
      params: { type: "object", required: ["version"], properties: { version: VERSION } },
    },
    handler: async (request, reply) => {
      const found = await publicRelease(request.params.version);
      if (!found) {
        return reply.code(404).send({ error: `No release ${request.params.version} is on the list.`, code: "NO_RELEASE" });
      }
      return reply.send(found);
    },
  });

  app.post<{ Body: { entries: unknown[] } }>("/operator/releases", {
    schema: {
      tags: ["setup"],
      summary: "Add signed entries to the list of Minerval's releases (the operator key)",
      description:
        "Cutting, correcting and withdrawing a release are entries Minerval's release workflow signs with the release " +
        "key and posts here on a tag. An entry is never changed: one already on the list is left as it is. An entry the " +
        "release key did not sign is refused, whoever holds the operator key.",
      body: ENTRIES_BODY,
    },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const outcome = await acceptReleaseEntries(request.body.entries);
      return reply.code(outcome.refused.length > 0 && outcome.accepted + outcome.already === 0 ? 422 : 200).send(outcome);
    },
  });

  // A deployment's own copy of the list, for its administrators.
  if (membersOnly(loadConfig())) {
    const administratorSession = [app.authenticate, app.requireSession, app.requireUser, requirePermission("administer")];

    app.post<{ Body: { entries: unknown[] } }>("/setup/releases/upload", {
      schema: {
        tags: ["setup"],
        summary: "Keep a file of the list of Minerval's releases, for a deployment that reaches nothing outside (administrators, signed in)",
        description:
          "The file is the list as the public graph serves it (GET /setup/releases there), downloaded by a person. Every " +
          "entry is checked against the release key in this version's code, and only those Minerval signed are kept: a " +
          "file cannot invent a release, withdraw one or change its facts.",
        body: ENTRIES_BODY,
      },
      preHandler: administratorSession,
      handler: async (request, reply) => reply.send(await acceptReleaseEntries(request.body.entries)),
    });

    app.post<{ Body: { version: string; step: string } }>("/setup/releases/steps", {
      schema: {
        tags: ["setup"],
        summary: "Mark an operator step of a release done (administrators, signed in)",
        description:
          "A release's notes may give steps the operator takes on the machine. Health shows each until an administrator " +
          "says here that it was done. Logged with who said so.",
        body: {
          type: "object",
          required: ["version", "step"],
          additionalProperties: false,
          properties: { version: VERSION, step: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
      preHandler: administratorSession,
      handler: async (request, reply) => {
        const result = await markReleaseStepDone({
          version: request.body.version,
          step: request.body.step,
          actorId: request.auth!.userId!,
        });
        if (!result.ok) return reply.code(404).send({ error: result.message, code: result.code });
        return reply.send({ done: true });
      },
    });
  }
}
