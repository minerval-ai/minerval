/**
 * Connections: agents read an organization's data where it lives
 * (docs/connections.md).
 *
 * Most of what an organization knows is not in documents someone will
 * upload. It is in a warehouse, a wiki, a ticket system, a log store. A
 * connection points the deployment at an MCP server over one such system,
 * and the agents that weigh evidence are given the server's reading tools.
 * It is the second of the three ways material comes in, beside a document
 * and a set of files.
 *
 * The rules, each with where it is kept:
 *
 *  - A connection is an administrator's to add and change, from a signed-in
 *    session, and every change is logged (services/connection-service.ts,
 *    routes/connections.ts). Connections exist only in a members-only
 *    deployment; the public graph has none and runs none of this.
 *  - Which of a server's tools agents are offered is the administrator's
 *    choice, tool by tool. The server's own marking of a tool as read-only
 *    is a hint. Nothing is offered that was not picked, and a pick holds
 *    only for the definition it was made on: a tool whose name, description,
 *    schema or markings later differ is withdrawn until an administrator
 *    looks again (toolDefinitionHash below).
 *  - The deployment cannot prove a tool only reads. What keeps a connection
 *    from writing is the credential the organization grants at its own
 *    system, which is why the administrator is asked for a read-only one
 *    (CONNECTION_NOTICE below).
 *  - A run is offered a connection when the label it works at reads the
 *    connection's label (labelsReadableFrom, the one definition of what a
 *    label reads), and is told in its brief which connections it has and
 *    whose system each is (llm/tools/connection-tools.ts).
 *  - Every call is stored whole with its hash (connection_calls). A call is
 *    not a source until an agent's work rests on it: keep_reading then makes
 *    the source row a judgment can cite, labelled with the connection's
 *    label, belonging to the connection's party, with that party's stake
 *    recorded (services/reading-service.ts).
 *
 * This file holds what the rest shares and needs no database: the names,
 * the shape of a tool's name as an agent sees it, the hash a pick is held
 * to, and the sentences an administrator is shown.
 */
import { createHash } from "node:crypto";
import { canonicalContent } from "./services/run-log.js";

/** How the deployment speaks to a connection's server. */
export const CONNECTION_TRANSPORTS = ["streamable_http", "sse"] as const;
export type ConnectionTransport = (typeof CONNECTION_TRANSPORTS)[number];

export function isConnectionTransport(value: unknown): value is ConnectionTransport {
  return typeof value === "string" && (CONNECTION_TRANSPORTS as readonly string[]).includes(value);
}

/** A connection's name is shown to administrators and to agents, so it is kept to a name. */
export const CONNECTION_NAME_MAX_CHARS = 120;
/** The stake is recorded on every reading kept, at the length a source's interest takes. */
export const CONNECTION_STAKE_MAX_CHARS = 1000;

/**
 * What stands between a connection's prefix and the server's own tool name
 * in the name an agent is offered: `warehouse__run_query`. No built-in tool
 * has it in its name (tests/unit/connections.test.ts holds that against the
 * list of every tool, TOOL_READS), and a prefix cannot contain it, so a
 * connection's tool can collide neither with a built-in tool nor with
 * another connection's.
 */
export const CONNECTION_TOOL_SEPARATOR = "__";

/**
 * A connection's prefix: a short lower-case word, with single underscores
 * between its parts. It is written into every tool name the connection
 * offers and into the address of every reading kept from it.
 */
export const TOOL_PREFIX_PATTERN = "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$";
export const TOOL_PREFIX_MAX_CHARS = 24;
const TOOL_PREFIX_RE = new RegExp(TOOL_PREFIX_PATTERN);

export function isToolPrefix(value: string): boolean {
  return value.length <= TOOL_PREFIX_MAX_CHARS && TOOL_PREFIX_RE.test(value);
}

/** A prefix made from a connection's name, for an administrator who gave none. */
export function toolPrefixFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "c$1")
    .slice(0, TOOL_PREFIX_MAX_CHARS)
    .replace(/_+$/g, "");
  return slug || "connection";
}

/** The name the model APIs take for a tool. */
const OFFERABLE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** A server's tool as an agent is offered it. */
export function offeredToolName(prefix: string, tool: string): string {
  return `${prefix}${CONNECTION_TOOL_SEPARATOR}${tool}`;
}

/**
 * Why a server's tool cannot be offered under this prefix, or null when it
 * can: the model APIs take a tool name of letters, digits, underscores and
 * hyphens, at most 64 characters.
 */
export function offeredNameProblem(prefix: string, tool: string): string | null {
  const name = offeredToolName(prefix, tool);
  if (OFFERABLE_TOOL_NAME.test(name)) return null;
  return (
    `"${tool}" would be offered as "${name}", which a model cannot be given as a tool name: ` +
    `one is letters, digits, underscores and hyphens, at most 64 characters.`
  );
}

/** Whether a tool name is one a connection offers, by its shape. */
export function isConnectionToolName(name: string): boolean {
  return name.includes(CONNECTION_TOOL_SEPARATOR);
}

/** The prefix and the server's tool name in an offered name, or null when it is not one. */
export function parseOfferedToolName(name: string): { prefix: string; tool: string } | null {
  const at = name.indexOf(CONNECTION_TOOL_SEPARATOR);
  if (at <= 0) return null;
  const prefix = name.slice(0, at);
  const tool = name.slice(at + CONNECTION_TOOL_SEPARATOR.length);
  return isToolPrefix(prefix) && tool.length > 0 ? { prefix, tool } : null;
}

/**
 * The environment variable that holds a connection's credential must be
 * named with this prefix. An administrator names the variable, and the
 * deployment sends its value to the address the administrator gave. Without
 * the prefix, naming the variable of the database password or a model key
 * and pointing a connection at one's own server would hand over a secret
 * the administrator was never given. So only a variable the operator named
 * for a connection can be sent.
 */
export const CREDENTIAL_ENV_PREFIX = "CONNECTION_";
export const CREDENTIAL_ENV_PATTERN = "^CONNECTION_[A-Z0-9_]{1,80}$";
const CREDENTIAL_ENV_RE = new RegExp(CREDENTIAL_ENV_PATTERN);

export function isCredentialEnvName(value: string): boolean {
  return CREDENTIAL_ENV_RE.test(value);
}

/** A header name as HTTP takes one. */
export const CREDENTIAL_HEADER_PATTERN = "^[A-Za-z0-9-]{1,64}$";
const CREDENTIAL_HEADER_RE = new RegExp(CREDENTIAL_HEADER_PATTERN);

export function isCredentialHeader(value: string): boolean {
  return CREDENTIAL_HEADER_RE.test(value);
}

/**
 * The headers that carry a connection's credential. In `Authorization` it
 * is sent as a bearer token, which is what an MCP server over HTTP expects
 * there; in any other header it is sent as it is.
 */
export function credentialHeaders(header: string, credential: string): Record<string, string> {
  return header.toLowerCase() === "authorization"
    ? { Authorization: `Bearer ${credential}` }
    : { [header]: credential };
}

/** How long a call may go unanswered, within what an administrator may set. */
export const CONNECTION_TIMEOUT_SECONDS = { default: 120, min: 5, max: 900 } as const;

/**
 * The most text one call's result may be. A connection's calls cost the
 * organization's system and no owls, so the run's budget does not bound
 * what a call pulls back, and a result is held whole in memory and stored
 * whole in one row. Past this size a call is recorded as failed and the
 * agent is told why, in the brief before it calls and in the refusal. It is
 * a count because nothing prices the bytes.
 */
export const CONNECTION_RESULT_MAX_CHARS = 2_000_000;

/** A server's tool as the server lists it: what a pick is made on. */
export interface ServerToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  /** The server's own markings (MCP tool annotations), as given; null when it gave none. */
  annotations: Record<string, unknown> | null;
}

/**
 * The hash an administrator's pick is held to: SHA-256 over the tool's
 * name, description, input schema and markings, as canonical JSON. A tool
 * whose hash at the server differs from the one picked is a different tool
 * from the one the administrator looked at, and is not offered.
 */
export function toolDefinitionHash(tool: ServerToolDefinition): string {
  return createHash("sha256")
    .update(
      canonicalContent({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? null,
        annotations: tool.annotations ?? null,
      }),
      "utf8"
    )
    .digest("hex");
}

/**
 * The server's word on whether a tool only reads: true, false, or null when
 * it does not say. A hint: a server can mark a tool that writes as
 * read-only, and most servers mark nothing.
 */
export function readOnlyHint(annotations: Record<string, unknown> | null | undefined): boolean | null {
  const hint = annotations?.readOnlyHint;
  return typeof hint === "boolean" ? hint : null;
}

/**
 * Whether the server itself marks the tool as one that changes things:
 * `readOnlyHint: false` or `destructiveHint: true`. Such a tool cannot be
 * picked. A tool with no marking can be: whether it only reads is then the
 * administrator's judgment of the system, which the markings never settled.
 */
export function markedAsWriting(annotations: Record<string, unknown> | null | undefined): boolean {
  return annotations?.readOnlyHint === false || annotations?.destructiveHint === true;
}

/**
 * What an administrator is told where connections are added and where a
 * connection's tools are picked. The routes return it with what they serve,
 * so a page shows the same words.
 */
export const CONNECTION_NOTICE =
  "A connection is for reading. Grant it a read-only credential at the system itself: that " +
  "credential is what keeps an agent from changing anything there. This deployment cannot prove " +
  "that a tool only reads. A server's marking of a tool as read-only is a hint, shown beside each " +
  "tool, and a tool can write or send whatever its marking says. So agents are offered only the " +
  "tools you pick, one by one, and a tool that writes or sends is not meant to be picked. A tool " +
  "the server itself marks as writing cannot be. A tool whose name, description, schema or " +
  "markings later change at the server is withdrawn until an administrator looks at it again.";

/**
 * A reading's address: what `sources.url` holds for a source kept from a
 * connection, and what an agent cites it by. It is not a web address and
 * nothing fetches it: the reading exists only as the deployment stored it.
 */
export const READING_ADDRESS_SCHEME = "reading:";

export function readingAddress(prefix: string, callId: string): string {
  return `${READING_ADDRESS_SCHEME}${prefix}/${callId}`;
}

export function isReadingAddress(value: string): boolean {
  return value.startsWith(READING_ADDRESS_SCHEME);
}
