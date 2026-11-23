/**
 * The deployment's settings, as its administrators read and change them
 * (services/settings-service.ts; docs/settings.md). Mounted only where
 * READS=members (server/app.ts): the public graph has no administrators,
 * and its settings are its machine's.
 *
 *   GET    /settings: every setting in the registry, with its value, the
 *     layer it comes from, its default, whether a change applies live, and
 *     for a key only whether one is set (administer).
 *   GET    /settings/file: what is set in the app, as a config file, for
 *     starting another deployment the same way or handing a setting to
 *     whoever runs the machine. Never a secret (administer).
 *   PUT    /settings/:key: set a value, with a reason (administer).
 *   DELETE /settings/:key: return it to its default, with a reason
 *     (administer).
 *   POST   /setup/restart: end the API's process, to be started again
 *     (administer, from a signed-in session).
 *
 * A change is checked before it is saved, logged in the same transaction,
 * and in force in this process at once.
 *
 * The reads and the two writes are MCP tools (mcp/route-tools.ts). A key
 * someone outside issued is given only from a signed-in session: over MCP
 * or with an API key the route refuses it and says where to give it, so no
 * key passes through a model's context. The restart is not a tool: it ends
 * every run in flight, and is a person's act in their session.
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import { configFieldProblem } from "../config.js";
import { renderConfigFile } from "../config-file.js";
import {
  SETTING_REASON_MAX_CHARS,
  listSettings,
  logRestartRequested,
  resetSetting,
  setSetting,
  storedSettingsForFile,
  type SettingFailure,
} from "../services/settings-service.js";
import { endProcessSoon } from "../services/restart.js";
import { storedSettingsFacts } from "../preflight.js";

const STATUS: Record<SettingFailure, number> = {
  UNKNOWN_SETTING: 404,
  RETIRED: 410,
  ON_THE_MACHINE: 409,
  FIXED_ON_THE_MACHINE: 409,
  INVALID_VALUE: 400,
  SECRET_NEEDS_SESSION: 403,
  NO_SEALING_KEY: 409,
  HELD_BY_WORK: 409,
  WOULD_FAIL_CHECK: 409,
  NOT_SET: 404,
};

const KEY_PARAM = {
  type: "object",
  required: ["key"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        'The setting, by its name in the list of settings (for example "models.steward") or by its environment variable ("STEWARD_MODEL").',
    },
  },
} as const;

const REASON = {
  type: "string",
  maxLength: SETTING_REASON_MAX_CHARS,
  description: "Why, in a sentence. Kept with the change in the administrators' log.",
} as const;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const administrator = [app.authenticate, app.requireUser, requirePermission("administer")];
  const administratorSession = [app.authenticate, app.requireSession, app.requireUser, requirePermission("administer")];

  app.get("/settings", {
    schema: {
      tags: ["settings"],
      summary: "Every setting of this deployment, with its value and where the value comes from (administrators)",
      description:
        "Each setting has `key` (its name), `about` (what it decides), `value` and `default` as the config file " +
        "would write them, and `source`: \"environment\" or \"file\" where whoever runs the machine set it, which " +
        "fixes it; \"app\" where an administrator set it here; \"default\" otherwise. `changeable` says whether it can " +
        "be changed here now, and `fixed_by` says where it is changed when it cannot. `applies` is \"live\" for a " +
        "setting in force within seconds of a change and \"restart\" for one read only where the API starts; " +
        "`waiting` holds a saved value the API is not yet running with. A key someone outside issued (`secret`) is " +
        "never returned: `is_set` says whether one is set and `last_four` its last four characters. `problem` says " +
        "why the settings saved in the app are not in force, when together with the machine's they cannot be used.",
    },
    preHandler: administrator,
    handler: async (_request, reply) => reply.send(await listSettings()),
  });

  app.get("/settings/file", {
    schema: {
      tags: ["settings"],
      summary: "What is set in the app, written as a config file (administrators)",
      description:
        "The settings an administrator has set in the app, as the text of a config file (docs/deployment.md): to " +
        "start another deployment the same way, or to hand a setting to whoever runs the machine to fix there. It " +
        "holds no secret: a key given in the app is never written out.",
    },
    preHandler: administrator,
    handler: async (_request, reply) =>
      reply.send({ toml: renderConfigFile(storedSettingsForFile(), configFieldProblem) }),
  });

  app.put<{ Params: { key: string }; Body: { value: unknown; reason?: string } }>("/settings/:key", {
    schema: {
      tags: ["settings"],
      summary: "Set one of this deployment's settings (administrators)",
      description:
        "`value` is the setting as the config file would write it: text, a number, true or false, a list of text, " +
        "or for a setting written as groups a list of objects. The value is checked, then the whole configuration " +
        "with it, then the deployment's own checks: a change that would make a check that holds agent work fail is " +
        "refused with that check's sentence, and one that would make another check fail is saved with the sentence " +
        "in `warnings`. `in_force` says whether the change is in force now or waits for the API to be started again. " +
        "The change is logged with who made it and the reason given. A setting whoever runs the machine has fixed is " +
        "refused, saying where it is set. A key (`secret` in the list) is refused here unless the request comes from " +
        "a signed-in session: it is given on the settings page, so that no key passes through a tool call.",
      params: KEY_PARAM,
      body: {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: {
          value: {
            description:
              "The value, as the config file would write it: text, a number, true or false, a list of text, or a list of objects.",
          },
          reason: REASON,
        },
      },
    },
    preHandler: administrator,
    handler: async (request, reply) => {
      const outcome = await setSetting({
        key: request.params.key,
        value: request.body.value,
        reason: request.body.reason,
        actorId: request.auth!.userId!,
        fromSession: request.auth!.isSession === true || request.auth!.method === "dev_bypass",
      });
      if (!outcome.ok) return reply.code(STATUS[outcome.code]).send({ error: outcome.message, code: outcome.code });
      return reply.send(outcome);
    },
  });

  app.delete<{ Params: { key: string }; Body: { reason?: string } | undefined }>("/settings/:key", {
    schema: {
      tags: ["settings"],
      summary: "Return one of this deployment's settings to its default (administrators)",
      description:
        "Removes what an administrator set in the app, so the setting is on the code's default again. Checked and " +
        "logged as a change is. Refused where nothing is set in the app for it.",
      params: KEY_PARAM,
      body: { type: "object", additionalProperties: false, properties: { reason: REASON } },
    },
    preHandler: administrator,
    handler: async (request, reply) => {
      const outcome = await resetSetting({
        key: request.params.key,
        reason: request.body?.reason,
        actorId: request.auth!.userId!,
      });
      if (!outcome.ok) return reply.code(STATUS[outcome.code]).send({ error: outcome.message, code: outcome.code });
      return reply.send(outcome);
    },
  });

  app.post<{ Body: { reason?: string } | undefined }>("/setup/restart", {
    schema: {
      tags: ["setup"],
      summary: "End the API's process, to be started again with the settings as they now are (administrators, signed in)",
      description:
        "Some settings are read only where the API starts. This ends the API's process the way the machine would, " +
        "giving requests in flight their time; whatever runs the deployment starts it again. Every run in flight " +
        "ends and hands its work back to be taken up again. Logged. Only from a signed-in session.",
      body: { type: "object", additionalProperties: false, properties: { reason: REASON } },
    },
    preHandler: administratorSession,
    handler: async (request, reply) => {
      const waiting = storedSettingsFacts().waiting;
      await logRestartRequested({ actorId: request.auth!.userId!, waiting, reason: request.body?.reason });
      endProcessSoon();
      return reply.code(202).send({ restarting: true, waiting });
    },
  });
}
