/**
 * Gives each request that writes the label it works at
 * (server/request-labels.ts has the rule for every route and the reasons).
 *
 * How it is wired. Registered only in a members-only deployment, after the
 * route catalog. As each route registers, onRoute looks its rule up and
 *
 *  - adds a `label` field to the body schema of a route where the person
 *    names one (for something new), or may name one (for work on a node
 *    that is already there, at a label that reads the node's), so the
 *    OpenAPI document shows it. The catalog recorded the
 *    route before this hook ran, so the MCP tool built from the route has
 *    no such parameter: a key or a token works at its own label and an
 *    agent holding one is not offered a choice;
 *  - wraps the route's handler. The wrapper runs after every guard the
 *    route lists (sign-in, permission, quota), decides the label, and runs
 *    the handler with that label on the async context, beside the
 *    clearance the members-only hook put there. The database client reads
 *    both (db/clearance.ts): the request then reads what the label and the
 *    person's clearance both read, and adds rows at the label alone.
 *
 * Where the deployment's only label is `public` the wrapper asks one
 * remembered question (is there a second label?) and calls the handler as
 * it was. On the public graph nothing here is registered at all.
 *
 * Work a handler starts and does not wait for (a Grantmaker's turn, the
 * Assistant's) is started inside the wrapper, so it inherits the label.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { deploymentHoldsLabels, rawQuery } from "../../db/client.js";
import { PUBLIC_LABEL } from "../../labels.js";
import { runWithUsageContext } from "../../llm/usage-context.js";
import { membersOnly, standingOf } from "../../permissions.js";
import { CARRIERS, REQUEST_LABELS, takesChosenLabel, type RequestLabelRule } from "../request-labels.js";
import type { FixedLabel, RequestAuth } from "./auth.js";
import { routeKey } from "./route-catalog.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `label` field as the OpenAPI document shows it on a route that takes one. */
export const LABEL_FIELD = {
  type: "string",
  description:
    "Which label this is for: who may read it. Required from a signed-in session where the " +
    "deployment holds material at more than one label, and it must be a label the account may " +
    "read (GET /labels/mine lists them and says who reads each). There is no default. A " +
    "request made with an API key or an access token leaves it out: a key and a token each " +
    "work at one label, fixed when they were made.",
} as const;

/** The `label` field on a route that starts work on a node that is already there. */
export const WORK_LABEL_FIELD = {
  type: "string",
  description:
    "Optional. The label the work is done at. Left out, it is the node's own label. A node can " +
    "carry a judgment at each label, so a signed-in person may instead name a label they may read " +
    "that reads the node's label, to have the node worked on at that label: an internal " +
    "assessment of a public claim, say. What that work writes is read only at the label named, and " +
    "the node's own judgment stays as it is. A request made with an API key or an access token " +
    "leaves it out: its work is at the one label the key or token was made for.",
} as const;

const quoted = (labels: readonly string[]) => labels.map((l) => `"${l}"`).join(", ");

/** The credential as the sentence names it: the Assistant is told of "this conversation". */
const credentialName = (fixed: FixedLabel) => (fixed.of === "Assistant conversation" ? "conversation" : fixed.of);

/** What a refusal says, in one place. Each is a sentence a person or an agent reads. */
export const LABEL_MESSAGES = {
  required: (choices: readonly string[]) =>
    `This starts something new, and this deployment holds material at more than one label, so ` +
    `the request has to say which label it is for. Send "label" with one of: ${quoted(choices)}. ` +
    `There is no default, so that nothing is filed as public by omission. GET /labels/mine says ` +
    `who reads each label.`,
  notReadable: (named: string, choices: readonly string[]) =>
    `The request named the label "${named}". This account can add material only at a label it ` +
    `may read: ${quoted(choices)}.`,
  fixed: (fixed: FixedLabel, asked: string) =>
    `This ${credentialName(fixed)} works at the label "${fixed.label}", fixed when it was ` +
    `${fixed.of === "Assistant conversation" ? "started" : "made"}, and the request named ` +
    `"${asked}". It does not choose a label for each request. Leave "label" out.`,
  mismatch: (fixed: FixedLabel, noun: string, rowLabel: string) =>
    `This ${credentialName(fixed)} works at the label "${fixed.label}", and the ${noun} this request is about ` +
    `is labeled "${rowLabel}". It can read that ${noun}, and it acts only on what carries its own ` +
    `label, so that nothing read at one label is written where another label's readers see it. ` +
    (fixed.of === "Assistant conversation"
      ? `Your user can do this themselves from the ${noun}'s page, or in a conversation started at "${rowLabel}".`
      : `Use a credential made for "${rowLabel}".`),
  doesNotRead: (named: string, noun: string, rowLabel: string, choices: readonly string[]) =>
    `The request named the label "${named}", and the ${noun} is labeled "${rowLabel}", which "${named}" ` +
    `does not read. Work on a ${noun} is done at the ${noun}'s own label or at a label that reads it, ` +
    `because the work has to read what it is about. ` +
    (choices.length > 0
      ? `For this ${noun} this account may name: ${quoted(choices)}. `
      : "") +
    `Leave "label" out for the ${noun}'s own label.`,
  notFound: (noun: string) => `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found`,
  credentialRequired:
    `This endpoint works at the label of the API key or access token that calls it, and this ` +
    `request comes from a signed-in session, which has no label of its own. Call it with a key ` +
    `or a token.`,
  credentialNotReadable: (fixed: FixedLabel) =>
    `This ${credentialName(fixed)} works at the label "${fixed.label}", which this account may no longer ` +
    `read, so it is refused. A run or a credential never reads more than the person it acts for.`,
  unknownOnOneLabel: (named: string) =>
    `The request named the label "${named}", and this deployment has one label, "${PUBLIC_LABEL}".`,
} as const;

type Refusal = { status: 400 | 403 | 404 | 409; code: string; error: string } & Record<string, unknown>;
type Decision = { label?: string } | { refusal: Refusal };

/**
 * Send a refusal as written. Routes declare response schemas for their own
 * error shapes, and a body sent as an object would be serialized through
 * them and lose its fields (as in server/require-permission.ts).
 */
function sendRefusal(reply: FastifyReply, refusal: Refusal): FastifyReply {
  const { status, ...body } = refusal;
  return reply.code(status).type("application/json; charset=utf-8").send(JSON.stringify(body));
}

/**
 * The label a person named for something new, checked against what they may
 * read, or the fixed label of the credential the request came with. Used by
 * the wrapper below, and by the two routes that make a credential and so
 * take the label it will work at (routes/api-keys.ts, routes/oauth.ts).
 * `held` is whether the deployment holds more than one label.
 */
export function chooseLabel(
  auth: RequestAuth | null | undefined,
  named: unknown,
  held: boolean
): Decision {
  if (!held) {
    // One label: nothing is asked. A name other than the one label there is
    // can only be a mistake, and saying so is kinder than ignoring it.
    if (typeof named === "string" && named !== PUBLIC_LABEL) {
      return { refusal: { status: 400, code: "UNKNOWN_LABEL", error: LABEL_MESSAGES.unknownOnOneLabel(named) } };
    }
    return {};
  }
  const fixed = auth?.fixedLabel;
  if (fixed) {
    if (named !== undefined && named !== null && named !== fixed.label) {
      return {
        refusal: { status: 400, code: "LABEL_FIXED", error: LABEL_MESSAGES.fixed(fixed, String(named)), label: fixed.label },
      };
    }
    return { label: fixed.label };
  }
  const choices = standingOf(auth).clearance;
  if (typeof named !== "string" || named.length === 0) {
    return {
      refusal: { status: 400, code: "LABEL_REQUIRED", error: LABEL_MESSAGES.required(choices), labels: [...choices] },
    };
  }
  if (!choices.includes(named)) {
    // The same answer whether or not a label of that name exists: the names
    // of labels a person may not read are not theirs to learn.
    return {
      refusal: {
        status: 403,
        code: "LABEL_NOT_READABLE",
        error: LABEL_MESSAGES.notReadable(named, choices),
        labels: [...choices],
      },
    };
  }
  return { label: named };
}

/** The label a request on `rule` works at, or the refusal. */
export async function decideRequestLabel(
  rule: RequestLabelRule,
  request: Pick<FastifyRequest, "auth" | "params" | "body">
): Promise<Decision> {
  const held = await deploymentHoldsLabels();
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (!held) return takesChosenLabel(rule) ? chooseLabel(request.auth, body.label, false) : {};

  const fixed = request.auth?.fixedLabel;
  if (rule.rule === "none") return {};
  if (rule.rule === "credential") {
    if (fixed) return { label: fixed.label };
    return {
      refusal: { status: 400, code: "CREDENTIAL_LABEL_REQUIRED", error: LABEL_MESSAGES.credentialRequired },
    };
  }
  if (rule.rule === "chosen") return chooseLabel(request.auth, body.label, true);

  const container = (rule.in === "params" ? request.params : request.body) as Record<string, unknown> | undefined;
  const id = container?.[rule.field];
  if (id === undefined || id === null || id === "") {
    if (rule.otherwise === "chosen") return chooseLabel(request.auth, body.label, true);
    // Every "from" route requires the id in its schema or its URL, so a
    // request without one is answered by the route's own validation.
    return {};
  }
  const carrier = CARRIERS[rule.carrier];
  // Read on the request's own connection, so a row the person may not read
  // is a row that is not there.
  const rows =
    typeof id === "string" && UUID_RE.test(id)
      ? await rawQuery<{ sensitivity_label: string }>(
          `SELECT sensitivity_label FROM ${carrier.table} WHERE id = $1`,
          [id]
        )
      : [];
  const rowLabel = rows[0]?.sensitivity_label;
  if (rowLabel === undefined) {
    return { refusal: { status: 404, code: "NOT_FOUND", error: LABEL_MESSAGES.notFound(carrier.noun) } };
  }
  if (rule.orReader) {
    // Work on the row, at the row's own label or at one that reads it. The
    // row was read on the request's own connection, so a credential's label
    // reads it, and the credential's work is at its own label.
    if (fixed) {
      if (body.label !== undefined && body.label !== null && body.label !== fixed.label) {
        return {
          refusal: { status: 400, code: "LABEL_FIXED", error: LABEL_MESSAGES.fixed(fixed, String(body.label)), label: fixed.label },
        };
      }
      return { label: fixed.label };
    }
    if (body.label === undefined || body.label === null || body.label === "" || body.label === rowLabel) {
      return { label: rowLabel };
    }
    const held = standingOf(request.auth).clearance;
    const named = String(body.label);
    const readers = await rawQuery<{ name: string }>(
      `SELECT l.name FROM labels l
        WHERE l.name = ANY($1::text[]) AND $2 = ANY (minerval_labels_readable_from(ARRAY[l.name]))`,
      [[...held], rowLabel]
    );
    const choices = readers.map((r) => r.name).sort();
    if (!held.includes(named)) {
      return {
        refusal: { status: 403, code: "LABEL_NOT_READABLE", error: LABEL_MESSAGES.notReadable(named, held), labels: [...held] },
      };
    }
    if (!choices.includes(named)) {
      return {
        refusal: {
          status: 400,
          code: "LABEL_DOES_NOT_READ",
          error: LABEL_MESSAGES.doesNotRead(named, carrier.noun, rowLabel, choices),
          labels: choices,
        },
      };
    }
    return { label: named };
  }
  if (fixed && rowLabel !== fixed.label) {
    return {
      refusal: {
        status: 409,
        code: "LABEL_MISMATCH",
        error: LABEL_MESSAGES.mismatch(fixed, carrier.noun, rowLabel),
        label: fixed.label,
      },
    };
  }
  if (rule.otherwise === "chosen" && body.label !== undefined && body.label !== null && body.label !== rowLabel) {
    // The row decides. A label named beside it that disagrees is refused
    // and not ignored, so nobody believes they filed somewhere they did not.
    return {
      refusal: {
        status: 400,
        code: "LABEL_FOLLOWS_ROW",
        error:
          `The request named the label "${String(body.label)}", and the ${carrier.noun} it is about is ` +
          `labeled "${rowLabel}". What is filed about a ${carrier.noun} carries that ${carrier.noun}'s label. ` +
          `Leave "label" out.`,
      },
    };
  }
  return { label: rowLabel };
}

type Handler = (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => unknown;

/**
 * Register before any route and after the route catalog (see the module
 * comment). Registers nothing where the deployment is not members-only.
 */
export async function registerRequestLabel(app: FastifyInstance): Promise<void> {
  if (!membersOnly()) return;

  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((m) => String(m).toUpperCase());
    const rules = methods
      .filter((m) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS")
      .map((m) => REQUEST_LABELS[routeKey(m, route.url)])
      .filter((r): r is RequestLabelRule => r !== undefined);
    const rule = rules[0];
    if (!rule) return;

    const worksAtAReader = rule.rule === "from" && rule.orReader === true;
    if (takesChosenLabel(rule) || worksAtAReader) {
      const body = (route.schema?.body ?? { type: "object" }) as { properties?: Record<string, unknown> };
      // A new schema object: route schemas are often shared constants, and
      // the catalog keeps the one without the field for the MCP tool.
      route.schema = {
        ...route.schema,
        body: {
          ...body,
          properties: { ...(body.properties ?? {}), label: worksAtAReader ? WORK_LABEL_FIELD : LABEL_FIELD },
        },
      };
    }

    if (rule.rule === "none") return;
    const handler = route.handler as Handler;
    route.handler = async function labelled(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      const decision = await decideRequestLabel(rule, request);
      if ("refusal" in decision) return sendRefusal(reply, decision.refusal);
      if (decision.label === undefined) return handler.call(this, request, reply);
      return runWithUsageContext({ label: decision.label }, () => handler.call(this, request, reply));
    };
  });
}
