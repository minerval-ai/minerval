/**
 * Connections: agents read an organization's data where it lives, and
 * write there only where an administrator grants a tool for it
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
 *  - A tool is picked as one that reads unless an administrator grants it
 *    to write: an acknowledgement of what that means and a reason, kept on
 *    the tool and shown to administrators and to every agent offered it
 *    (WRITE_ACKNOWLEDGEMENT below). A tool the server itself marks as
 *    writing can be picked no other way. A write grant is part of the pick,
 *    so it falls with it when the tool's definition changes.
 *  - The deployment cannot prove what a tool does. What limits a connection
 *    is the credential the organization grants at its own system, which is
 *    why the administrator is asked for the narrowest one that allows what
 *    they granted: read-only where no tool is granted to write
 *    (CONNECTION_NOTICE below).
 *  - A write through a connection is a write at the connection's label: its
 *    arguments are the content, and they land in a system whose readers are
 *    that label's. So a tool granted to write is offered only to a run that
 *    works at the connection's own label, never to one that merely reads it
 *    (services/connection-service.ts, connectionsOfferedAt).
 *  - A call to a tool granted to write is listed for administrators with
 *    what was sent and what came back, may be made to wait for an
 *    administrator before it is sent, and, like any tool an administrator
 *    priced, is charged to the run's budget (services/reading-service.ts).
 *  - A run is offered a connection when the label it works at reads the
 *    connection's label (labelsReadableFrom, the one definition of what a
 *    label reads), and is told in its brief which connections it has and
 *    whose system each is (llm/tools/connection-tools.ts).
 *  - Every call is stored whole with its hash (connection_calls). A call is
 *    not a source until an agent's work rests on it: keep_reading then makes
 *    the source row a judgment can cite, belonging to the connection's
 *    party, with that party's stake recorded where an administrator gave
 *    one (it is optional: for an organization's own system there is usually
 *    nothing to say beyond whose it is). The call and the source carry
 *    the label of the run that made the call, since the arguments are that
 *    run's own words (services/reading-service.ts).
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
/** A stake, where given, is recorded on every reading kept, at the length a source's interest takes. */
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

/**
 * The roles a connection may be offered to, which an administrator ticks
 * one by one on the connection (`offered_to`). Every agent that works at a
 * label whose clearance reads the connection's may be offered it: an agent
 * directing the graph, or answering a person, at a label should be able to
 * read what that label's systems hold. Each role here runs a tool loop at
 * the label of its work. Not listed, and never offered: the mathematics
 * solver, whose tools are fixed when its run starts and a test holds them.
 */
export const CONNECTION_ROLES = [
  "steward",
  "researcher",
  "lookout",
  "grantmaker",
  "program_officer",
  "correspondent",
  "curator",
  "consistency_checker",
  "contribution_reviewer",
  "dispute_arbitrator",
  "audit",
  "redactor",
  "matcher",
  "extractor",
  "tagger",
  "assistant",
] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];

export function isConnectionRole(value: unknown): value is ConnectionRole {
  return typeof value === "string" && (CONNECTION_ROLES as readonly string[]).includes(value);
}

/**
 * Each role as an administrator is shown it: its name, whether it may keep
 * a reading as a source (only where its work records sources), and, for a
 * role a new connection is not offered to unless ticked, why not.
 */
export const CONNECTION_ROLE_INFO: Readonly<
  Record<ConnectionRole, { name: string; keeps: "yes" | "when_recording" | "no"; offFirst?: string }>
> = {
  steward: { name: "Claim and Question Stewards", keeps: "yes" },
  researcher: { name: "Researchers", keeps: "when_recording" },
  lookout: { name: "Lookouts", keeps: "no" },
  grantmaker: { name: "Grantmakers (conversation, planning and review passes)", keeps: "no" },
  program_officer: { name: "Program officers", keeps: "no" },
  correspondent: {
    name: "Correspondents",
    keeps: "no",
    offFirst:
      "A Correspondent's updates cite what they rest on, and it keeps no source, so a reading it cites is one its readers cannot open.",
  },
  curator: { name: "Curator", keeps: "no" },
  consistency_checker: { name: "Consistency Checker", keeps: "no" },
  contribution_reviewer: { name: "Contribution Reviewer", keeps: "no" },
  dispute_arbitrator: { name: "Dispute Arbitrator", keeps: "no" },
  audit: {
    name: "Audit",
    keeps: "no",
    offFirst:
      "Audit judges the record as it stands, and one of its passes tells the readers of its log that it was handed no operator data.",
  },
  redactor: {
    name: "Redactor",
    keeps: "no",
    offFirst: "The Redactor decides what of a page leaves for readers who do not read its label; it works from the page and the sources it rests on.",
  },
  matcher: {
    name: "Matcher",
    keeps: "no",
    offFirst: "The Matcher runs on every claim extracted, and each run would carry the connection's tool definitions.",
  },
  extractor: {
    name: "Extractor",
    keeps: "no",
    offFirst: "The Extractor runs on every source, reading the text it is handed, and each run would carry the connection's tool definitions.",
  },
  tagger: {
    name: "Tagger",
    keeps: "no",
    offFirst: "The Tagger runs on every new node, and each run would carry the connection's tool definitions.",
  },
  assistant: { name: "The Assistant, for people who may open raw sources at the connection's label", keeps: "no" },
};

/** The roles a new connection is offered to until an administrator says otherwise. */
export const DEFAULT_CONNECTION_ROLES: readonly ConnectionRole[] = CONNECTION_ROLES.filter(
  (role) => CONNECTION_ROLE_INFO[role].offFirst === undefined
);

/** How long a call may go unanswered, within what an administrator may set. */
export const CONNECTION_TIMEOUT_SECONDS = { default: 120, min: 5, max: 900 } as const;

/**
 * The most text one call's result may be. A connection's calls cost the
 * organization's system and, unless an administrator priced a tool, no
 * owls, and a price is by the call, so the run's budget does not bound
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
 * `readOnlyHint: false` or `destructiveHint: true`. Such a tool can be
 * picked only under a write grant. A tool with no marking can be picked
 * either way: whether it only reads is then the administrator's judgment of
 * the system, which the markings never settled.
 */
export function markedAsWriting(annotations: Record<string, unknown> | null | undefined): boolean {
  return annotations?.readOnlyHint === false || annotations?.destructiveHint === true;
}

/**
 * What an administrator is told where connections are added and where a
 * connection's tools are picked. The routes return it with what they serve,
 * so a page shows the same words.
 *
 * It says, in this order: what the default is and what changes it; that the
 * deployment's own checks are not proof; what does limit a tool, and so
 * which credential to grant; and what is recorded and watched.
 */
export const CONNECTION_NOTICE =
  "A connection reads, unless you grant one of its tools to write. Agents are offered only the tools " +
  "you pick, one by one. A tool picked plainly is picked as one that reads. A tool that writes or " +
  "sends is offered only under a write grant: you acknowledge that agents will change things at that " +
  "system through it and give your reason, and both are kept, shown here, and told to every agent " +
  "offered the tool. A tool the server itself marks as writing can be picked no other way. This " +
  "deployment cannot prove what a tool does. A server's marking is a hint, shown beside each tool, " +
  "and a tool picked as reading can write or send whatever its marking says. What limits a " +
  "connection is the credential you grant it at the system itself: grant the narrowest one that " +
  "allows what you have granted here, and a read-only one where no tool is granted to write. Every " +
  "call is recorded and is never sent twice. Calls to a tool granted to write are listed with what " +
  "was sent and what came back, and you can have them wait for an administrator before they are " +
  "sent. A tool whose name, description, schema or markings later change at the server is " +
  "withdrawn, its write grant with it, until an administrator looks at it again.";

/**
 * What an administrator acknowledges when granting a tool to write. The
 * grant keeps these words as they were when it was made, beside the
 * administrator's own reason, so that a later reader sees what was agreed
 * to and not what a later build says.
 */
export const WRITE_ACKNOWLEDGEMENT =
  "I have read this tool's description and schema. Agents offered it will change or send things at " +
  "this system through it, with the credential this connection holds, on their own judgment and " +
  "without asking first unless its calls are held. This deployment cannot undo a call once it is sent.";

/** An administrator's reason for a write grant is told to every agent offered the tool, so it is kept to a few sentences. */
export const WRITE_REASON_MAX_CHARS = 1000;

/**
 * The most an administrator may price one call at, in micro-USD ($100).
 * The price is what the organization says a call costs it; a figure past
 * this is far more likely a slip of the hand than a price.
 */
export const CALL_PRICE_MAX_MICRO_USD = 100_000_000;

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
