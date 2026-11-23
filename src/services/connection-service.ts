/**
 * Connections as an administrator keeps them, and as a run is offered them
 * (src/connections.ts; the tables are in db/schema.ts).
 *
 * The administrator's side: add a connection, change it, look at the tools
 * its server lists, and pick which of them agents are offered: as tools
 * that read, or, under a write grant the administrator acknowledges and
 * gives a reason for, as tools that write. Every change to what agents may
 * read or write writes a row to administrative_events in the same
 * transaction, as a label or a party does (permission-service.ts).
 *
 * The run's side: connectionsOfferedAt answers which connections a run at a
 * label has, with the tools it is offered from each. It asks each server
 * for its tools as they are now and offers a tool only where the server's
 * definition is still the one an administrator picked. A tool that differs
 * is withdrawn then and there, and stays withdrawn until an administrator
 * looks again: the pick was a person's judgment of one definition, and
 * nothing here may extend it to another. A tool granted to write is offered
 * only to a run at the connection's own label, and never to the Assistant
 * (connectionsOfferedAt says why); a run that would otherwise have had it
 * is told that it does not, and the reason.
 *
 * Nothing in this file reads a credential in the clear once it is kept. A
 * connection either names the environment variable that holds its
 * credential, and this file reports whether that variable is set
 * (connection-client.ts), or was given its credential in the app, which
 * this file seals as it arrives and stores sealed (connection-credential.ts).
 * A sealed credential is opened only by the client, at the moment of a
 * call, and by resealStoredCredentials, which seals it again under a new key.
 */
import { randomUUID } from "node:crypto";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import {
  CALL_PRICE_MAX_MICRO_USD,
  CONNECTION_NAME_MAX_CHARS,
  CONNECTION_STAKE_MAX_CHARS,
  CONNECTION_TIMEOUT_SECONDS,
  CREDENTIAL_ENV_PREFIX,
  TOOL_PREFIX_MAX_CHARS,
  isConnectionTransport,
  isCredentialEnvName,
  isCredentialHeader,
  isToolPrefix,
  markedAsWriting,
  offeredNameProblem,
  offeredToolName,
  readOnlyHint,
  toolDefinitionHash,
  toolPrefixFromName,
  WRITE_ACKNOWLEDGEMENT,
  WRITE_REASON_MAX_CHARS,
  CONNECTION_TRANSPORTS,
  CONNECTION_ROLES,
  DEFAULT_CONNECTION_ROLES,
  isConnectionRole,
  type ConnectionRole,
  type ServerToolDefinition,
} from "../connections.js";
import {
  credentialPresent,
  listServerTools,
  type ConnectionFailure,
  type ConnectionTarget,
} from "./connection-client.js";
import {
  CREDENTIAL_KEY_ENV,
  cleanCredential,
  credentialKeys,
  keyIsHere,
  openCredential,
  sealCredential,
  type SealedCredential,
} from "./connection-credential.js";
import { mayOpenRawSources, withheldCallResult, type WithheldSourceText } from "../raw-sources.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { labelsReadableFrom, logAdministrativeEvent } from "./permission-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

/** Why a tool an administrator picked is no longer offered. */
export type WithdrawnReason = "changed" | "missing" | "address_changed";

/**
 * How long a run waits for a server to list its tools when the run's
 * toolset is being put together. The run cannot start until it knows what
 * it is offered, so a server that does not answer is given this long and no
 * longer, whatever the connection's own timeout for a call; the run is then
 * told the connection did not answer.
 */
const RUN_START_LIST_TIMEOUT_SECONDS = 20;

// ---- rows and views ---------------------------------------------------------

interface ConnectionRow {
  id: string;
  name: string;
  tool_prefix: string;
  transport: string;
  url: string;
  credential_env: string | null;
  credential_sealed: string | null;
  credential_key_id: string | null;
  credential_set_at: Date | null;
  credential_header: string;
  party_id: string;
  party_name: string;
  party_is_own: boolean;
  stake: string | null;
  sensitivity_label: string;
  offered_to: string[];
  calls_per_minute: number | null;
  timeout_seconds: number;
  enabled: boolean;
  last_checked_at: Date | null;
  last_answered_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ToolRow {
  connection_id: string;
  name: string;
  description: string;
  input_schema: unknown;
  annotations: Record<string, unknown> | null;
  definition_hash: string;
  listed: boolean;
  seen_at: Date;
  offered: boolean;
  offered_at: Date | null;
  withdrawn_at: Date | null;
  withdrawn_reason: string | null;
  writes: boolean;
  write_reason: string | null;
  write_acknowledgement: string | null;
  write_granted_by: string | null;
  write_granted_by_name: string | null;
  write_granted_at: Date | null;
  write_held: boolean;
  call_price_micro_usd: number;
  calls: number;
  readings_kept: number;
  writes_made: number;
  writes_held: number;
}

const CONNECTION_SELECT = `
  SELECT c.id, c.name, c.tool_prefix, c.transport, c.url, c.credential_env,
         c.credential_sealed, c.credential_key_id, c.credential_set_at, c.credential_header,
         c.party_id, p.name AS party_name, p.is_own_organization AS party_is_own, c.stake,
         c.sensitivity_label, c.offered_to, c.calls_per_minute, c.timeout_seconds, c.enabled,
         c.last_checked_at, c.last_answered_at, c.last_error, c.last_error_at, c.created_at, c.updated_at
    FROM connections c
    JOIN parties p ON p.id = c.party_id`;

const TOOL_SELECT = `
  SELECT t.connection_id, t.name, t.description, t.input_schema, t.annotations, t.definition_hash,
         t.listed, t.seen_at, t.offered, t.offered_at, t.withdrawn_at, t.withdrawn_reason,
         t.writes, t.write_reason, t.write_acknowledgement, t.write_granted_by, t.write_granted_at,
         t.write_held, t.call_price_micro_usd,
         (SELECT g.display_name FROM contributors g WHERE g.id = t.write_granted_by) AS write_granted_by_name,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name) AS calls,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name AND k.source_id IS NOT NULL) AS readings_kept,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name AND k.writes) AS writes_made,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name AND k.outcome = 'held') AS writes_held
    FROM connection_tools t`;

export interface ConnectionToolView {
  /** The tool's name at the server. */
  name: string;
  /** The name an agent is offered it under. */
  offered_as: string;
  description: string;
  input_schema: unknown;
  /** The server's own markings, as given; null when it gave none. */
  annotations: Record<string, unknown> | null;
  /** The server's word that the tool only reads: true, false, or null when it does not say. A hint. */
  read_only_hint: boolean | null;
  /** The server itself marks the tool as one that changes things, so it can be picked only under a write grant. */
  marked_as_writing: boolean;
  /** What a pick of this tool must name: the hash of the definition shown here. */
  definition_hash: string;
  /** Whether the server listed the tool when an administrator last looked. */
  listed: boolean;
  seen_at: string;
  offered: boolean;
  offered_at: string | null;
  /** Set when a tool that was offered stopped being offered without an administrator's act. */
  withdrawn: { at: string; reason: string } | null;
  /**
   * The write grant the tool was picked under: the administrator's reason,
   * the words they acknowledged, who and when, and whether its calls wait
   * for an administrator before they are sent. Null for a tool picked as
   * one that reads, and for a tool not picked. On a withdrawn tool it is
   * what was granted, and offers nothing until the tool is picked again.
   */
  write_grant: {
    reason: string;
    acknowledgement: string;
    granted_by: { id: string; name: string } | null;
    granted_at: string;
    held: boolean;
  } | null;
  /** What one answered call is charged to the run's budget, in owls; 0 for a tool whose calls are not charged. */
  owls_per_call: number;
  calls: number;
  readings_kept: number;
  /** Calls made while the tool was granted to write, and how many of them wait for an administrator now. */
  writes_made: number;
  writes_held: number;
}

export interface ConnectionView {
  id: string;
  name: string;
  tool_prefix: string;
  transport: string;
  url: string;
  credential: {
    /**
     * Where the credential comes from: `stored`, given on the connection's
     * page and kept sealed; `environment`, the variable `env` names; or
     * null when the server asks for none.
     */
    source: "stored" | "environment" | null;
    /** The name of the environment variable that holds the credential; null when it is not taken from one. */
    env: string | null;
    header: string;
    /**
     * Whether a call would carry the credential: the variable is set where
     * the deployment runs, or the key that sealed the stored one is. True
     * when the server asks for none. Never the value.
     */
    set: boolean;
    /** The credential given on the page: when, and whether the key that sealed it is the current one. Null when none was. */
    stored: { given_at: string; key: "current" | "previous" | "missing" } | null;
  };
  party: { id: string; name: string; is_own_organization: boolean };
  /** What the party stands to gain or lose from what the system shows, where an administrator gave it; recorded on every reading kept. */
  stake: string | null;
  label: string;
  /** The roles a run is offered the connection in (CONNECTION_ROLES), in that list's order. */
  offered_to: ConnectionRole[];
  calls_per_minute: number | null;
  timeout_seconds: number;
  enabled: boolean;
  state: {
    /** off | never_checked | answering | failing */
    status: "off" | "never_checked" | "answering" | "failing";
    last_checked_at: string | null;
    last_answered_at: string | null;
    last_error: { at: string; message: string } | null;
  };
  tools: ConnectionToolView[];
  created_at: string;
  updated_at: string;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toolView(prefix: string, t: ToolRow): ConnectionToolView {
  return {
    name: t.name,
    offered_as: offeredToolName(prefix, t.name),
    description: t.description,
    input_schema: t.input_schema,
    annotations: t.annotations,
    read_only_hint: readOnlyHint(t.annotations),
    marked_as_writing: markedAsWriting(t.annotations),
    definition_hash: t.definition_hash,
    listed: t.listed,
    seen_at: iso(t.seen_at)!,
    offered: t.offered,
    offered_at: iso(t.offered_at),
    withdrawn: t.withdrawn_at ? { at: iso(t.withdrawn_at)!, reason: t.withdrawn_reason ?? "changed" } : null,
    write_grant:
      t.writes && t.write_reason !== null && t.write_acknowledgement !== null
        ? {
            reason: t.write_reason,
            acknowledgement: t.write_acknowledgement,
            granted_by:
              t.write_granted_by !== null ? { id: t.write_granted_by, name: t.write_granted_by_name ?? "" } : null,
            granted_at: iso(t.write_granted_at)!,
            held: t.write_held,
          }
        : null,
    owls_per_call: microUsdToOwls(t.call_price_micro_usd),
    calls: t.calls,
    readings_kept: t.readings_kept,
    writes_made: t.writes_made,
    writes_held: t.writes_held,
  };
}

function connectionView(c: ConnectionRow, tools: ToolRow[]): ConnectionView {
  const failing =
    c.last_error_at !== null && (c.last_answered_at === null || c.last_error_at > c.last_answered_at);
  return {
    id: c.id,
    name: c.name,
    tool_prefix: c.tool_prefix,
    transport: c.transport,
    url: c.url,
    credential: credentialView(c),
    party: { id: c.party_id, name: c.party_name, is_own_organization: c.party_is_own },
    stake: c.stake,
    label: c.sensitivity_label,
    offered_to: rolesInOrder(c.offered_to),
    calls_per_minute: c.calls_per_minute,
    timeout_seconds: c.timeout_seconds,
    enabled: c.enabled,
    state: {
      status: !c.enabled ? "off" : failing ? "failing" : c.last_answered_at ? "answering" : "never_checked",
      last_checked_at: iso(c.last_checked_at),
      last_answered_at: iso(c.last_answered_at),
      last_error: failing && c.last_error ? { at: iso(c.last_error_at)!, message: c.last_error } : null,
    },
    tools: tools.filter((t) => t.connection_id === c.id).map((t) => toolView(c.tool_prefix, t)),
    created_at: iso(c.created_at)!,
    updated_at: iso(c.updated_at)!,
  };
}

/** Known roles, once each, in CONNECTION_ROLES order. A role a later build dropped is left out. */
function rolesInOrder(roles: readonly string[]): ConnectionRole[] {
  const set = new Set(roles);
  return CONNECTION_ROLES.filter((role) => set.has(role));
}

/** What a connection's view says of its credential, read from the row and the keys set now. Nothing is opened. */
function credentialView(
  c: Pick<ConnectionRow, "credential_env" | "credential_sealed" | "credential_key_id" | "credential_set_at" | "credential_header">
): ConnectionView["credential"] {
  if (c.credential_sealed !== null && c.credential_key_id !== null) {
    const keys = credentialKeys();
    const key = keys.current?.id === c.credential_key_id ? "current" : keyIsHere(c.credential_key_id, keys) ? "previous" : "missing";
    return {
      source: "stored",
      env: null,
      header: c.credential_header,
      set: key !== "missing",
      stored: { given_at: iso(c.credential_set_at)!, key },
    };
  }
  return {
    source: c.credential_env !== null ? "environment" : null,
    env: c.credential_env,
    header: c.credential_header,
    set: credentialPresent(c.credential_env),
    stored: null,
  };
}

/**
 * How many connections, or how many of one connection's calls, exist at
 * every label. The lists an administrator is served hold what their
 * clearance reads (the database sees to that), and administering does not
 * by that alone let a person read at a label. So that a list is not taken
 * for the whole, it comes with how many rows it leaves out: a number, and
 * nothing of any row.
 */
const COUNT_REASON =
  "An administrator is told how many connections, and how many of a connection's calls, their clearance leaves out of a list; the count is of rows at every label.";

async function countAtEveryLabel(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await withSystemClearance(COUNT_REASON, () => rawQuery<{ n: number }>(sql, params));
  return row?.n ?? 0;
}

/** What a list says of the rows it leaves out; null when it leaves none out. */
export function notShownNote(n: number, what: "connections" | "calls"): string | null {
  if (n <= 0) return null;
  return what === "connections"
    ? n === 1
      ? "1 more connection is at a label this account does not read, and is not listed. An administrator who reads at that label sees it."
      : `${n} more connections are at labels this account does not read, and are not listed. An administrator who reads at those labels sees them.`
    : n === 1
      ? "1 more call was made by work at a label this account does not read, and is not listed."
      : `${n} more calls were made by work at labels this account does not read, and are not listed.`;
}

/** How many connections the caller's clearance leaves out of `listed`. */
export async function connectionsNotShown(listed: number): Promise<number> {
  return Math.max(0, (await countAtEveryLabel(`SELECT count(*)::int AS n FROM connections`)) - listed);
}

/** Every connection the caller reads, with its tools, by name. */
export async function listConnections(): Promise<ConnectionView[]> {
  const [rows, tools] = await Promise.all([
    rawQuery<ConnectionRow>(`${CONNECTION_SELECT} ORDER BY lower(c.name)`),
    rawQuery<ToolRow>(`${TOOL_SELECT} ORDER BY t.name`),
  ]);
  return rows.map((c) => connectionView(c, tools));
}

export async function getConnection(id: string): Promise<ConnectionView | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await rawQuery<ConnectionRow>(`${CONNECTION_SELECT} WHERE c.id = $1`, [id]);
  if (!row) return null;
  const tools = await rawQuery<ToolRow>(`${TOOL_SELECT} WHERE t.connection_id = $1 ORDER BY t.name`, [id]);
  return connectionView(row, tools);
}

function sealedOf(c: Pick<ConnectionRow, "credential_sealed" | "credential_key_id">): SealedCredential | null {
  return c.credential_sealed !== null && c.credential_key_id !== null
    ? { sealed: c.credential_sealed, keyId: c.credential_key_id }
    : null;
}

function targetOf(
  c: Pick<
    ConnectionRow,
    "id" | "transport" | "url" | "credential_env" | "credential_sealed" | "credential_key_id" | "credential_header" | "timeout_seconds"
  >
): ConnectionTarget {
  return {
    connectionId: c.id,
    transport: c.transport,
    url: c.url,
    credentialEnv: c.credential_env,
    credentialSealed: sealedOf(c),
    credentialHeader: c.credential_header,
    timeoutSeconds: c.timeout_seconds,
  };
}

// ---- adding and changing ----------------------------------------------------

export type ConnectionFailureCode =
  | "INVALID_NAME"
  | "INVALID_TOOL_PREFIX"
  | "INVALID_TRANSPORT"
  | "INVALID_URL"
  | "INVALID_CREDENTIAL_ENV"
  | "INVALID_CREDENTIAL"
  | "NO_CREDENTIAL_KEY"
  | "INVALID_CREDENTIAL_HEADER"
  | "INVALID_STAKE"
  | "INVALID_RATE"
  | "INVALID_TIMEOUT"
  | "INVALID_ROLE"
  | "UNKNOWN_PARTY"
  | "UNKNOWN_LABEL"
  | "NAME_TAKEN"
  | "TOOL_PREFIX_TAKEN"
  | "NOT_FOUND"
  | "LABEL_IS_KEPT"
  | "NOTHING_TO_CHANGE";

type Refusal = { ok: false; code: ConnectionFailureCode; message: string };
const refuse = (code: ConnectionFailureCode, message: string): Refusal => ({ ok: false, code, message });

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ?? e?.cause?.constraint;
}

/**
 * Why an address cannot be a connection's, or null when it can. An address
 * is stored and shown, so it may not carry a credential: not as a user and
 * password, and not as a key in its query.
 */
function urlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "A connection's address is the URL of its MCP server, starting http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "A connection's address is the URL of its MCP server, starting http:// or https://.";
  }
  if (url.username || url.password) {
    return (
      "A connection's address must not carry a user name or password: an address is stored and shown. " +
      "Give the credential as the connection's credential, which is kept sealed, or name the environment " +
      "variable that holds it in credential_env."
    );
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password|auth|credential/i.test(key)) {
      return (
        `A connection's address must not carry a credential, and its query has "${key}": an address is ` +
        `stored and shown. Give the credential as the connection's credential, which is kept sealed, or ` +
        `name the environment variable that holds it in credential_env.`
      );
    }
  }
  return null;
}

export interface ConnectionSettings {
  name?: string;
  toolPrefix?: string;
  transport?: string;
  url?: string;
  credentialEnv?: string | null;
  credentialHeader?: string;
  partyId?: string;
  label?: string;
  stake?: string | null;
  callsPerMinute?: number | null;
  timeoutSeconds?: number;
  enabled?: boolean;
  /** The roles a run is offered the connection in. */
  offeredTo?: readonly string[];
}

/** The settings as they will be stored, or the first thing wrong with them. */
function cleanSettings(input: ConnectionSettings): { ok: true; value: ConnectionSettings } | Refusal {
  const out: ConnectionSettings = {};
  if (input.name !== undefined) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > CONNECTION_NAME_MAX_CHARS) {
      return refuse("INVALID_NAME", `A connection needs a name of at most ${CONNECTION_NAME_MAX_CHARS} characters.`);
    }
    // The name is written into what agents are told, inside quotation marks.
    if (/["\n\r]/.test(name)) return refuse("INVALID_NAME", "A connection's name is one line with no quotation marks.");
    out.name = name;
  }
  if (input.toolPrefix !== undefined) {
    const prefix = input.toolPrefix.trim();
    if (!isToolPrefix(prefix)) {
      return refuse(
        "INVALID_TOOL_PREFIX",
        `tool_prefix is a short lower-case word that starts each of the connection's tool names: letters and ` +
          `digits, with single underscores between parts, starting with a letter, at most ${TOOL_PREFIX_MAX_CHARS} characters.`
      );
    }
    out.toolPrefix = prefix;
  }
  if (input.transport !== undefined) {
    if (!isConnectionTransport(input.transport)) {
      return refuse("INVALID_TRANSPORT", `transport is one of: ${CONNECTION_TRANSPORTS.join(", ")}.`);
    }
    out.transport = input.transport;
  }
  if (input.url !== undefined) {
    const url = input.url.trim();
    const problem = urlProblem(url);
    if (problem) return refuse("INVALID_URL", problem);
    out.url = url;
  }
  if (input.credentialEnv !== undefined) {
    const env = input.credentialEnv === null ? null : input.credentialEnv.trim();
    if (env !== null && !isCredentialEnvName(env)) {
      return refuse(
        "INVALID_CREDENTIAL_ENV",
        `credential_env is the name of the environment variable that holds the credential, never the ` +
          `credential itself, and the name starts ${CREDENTIAL_ENV_PREFIX} (capital letters, digits and ` +
          `underscores after it). Only a variable named for a connection is ever sent to one.`
      );
    }
    out.credentialEnv = env;
  }
  if (input.credentialHeader !== undefined) {
    const header = input.credentialHeader.trim();
    if (!isCredentialHeader(header)) {
      return refuse("INVALID_CREDENTIAL_HEADER", "credential_header is the name of one HTTP header.");
    }
    out.credentialHeader = header;
  }
  if (input.stake !== undefined) {
    // Optional: an empty one is none, and none is recorded on what is kept.
    const stake = input.stake === null ? "" : input.stake.trim();
    if (stake.length > CONNECTION_STAKE_MAX_CHARS) {
      return refuse(
        "INVALID_STAKE",
        `A connection's stake is a sentence or two (at most ${CONNECTION_STAKE_MAX_CHARS} characters): what the ` +
          `party whose system it is stands to gain or lose from what the system shows.`
      );
    }
    out.stake = stake || null;
  }
  if (input.callsPerMinute !== undefined) {
    const rate = input.callsPerMinute;
    if (rate !== null && (!Number.isInteger(rate) || rate < 1 || rate > 6000)) {
      return refuse("INVALID_RATE", "calls_per_minute is a whole number of calls from 1 to 6000, or null for no rate.");
    }
    out.callsPerMinute = rate;
  }
  if (input.timeoutSeconds !== undefined) {
    const t = input.timeoutSeconds;
    if (!Number.isInteger(t) || t < CONNECTION_TIMEOUT_SECONDS.min || t > CONNECTION_TIMEOUT_SECONDS.max) {
      return refuse(
        "INVALID_TIMEOUT",
        `timeout_seconds is a whole number from ${CONNECTION_TIMEOUT_SECONDS.min} to ${CONNECTION_TIMEOUT_SECONDS.max}.`
      );
    }
    out.timeoutSeconds = t;
  }
  if (input.partyId !== undefined) {
    if (!UUID_RE.test(input.partyId)) return refuse("UNKNOWN_PARTY", "No party has that id.");
    out.partyId = input.partyId;
  }
  if (input.label !== undefined) out.label = input.label.trim();
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  if (input.offeredTo !== undefined) {
    const unknown = input.offeredTo.filter((role) => !isConnectionRole(role));
    if (unknown.length > 0) {
      return refuse(
        "INVALID_ROLE",
        `offered_to names roles a connection may be offered to: ${CONNECTION_ROLES.join(", ")}. ` +
          `Not one of them: ${unknown.join(", ")}.`
      );
    }
    out.offeredTo = rolesInOrder(input.offeredTo);
  }
  return { ok: true, value: out };
}

async function partyAndLabelProblem(tx: TxQuery, s: ConnectionSettings): Promise<Refusal | null> {
  if (s.partyId !== undefined) {
    const found = await tx.query(`SELECT 1 FROM parties WHERE id = $1`, [s.partyId]);
    if (found.length === 0) return refuse("UNKNOWN_PARTY", "No party has that id.");
  }
  if (s.label !== undefined) {
    const found = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [s.label]);
    if (found.length === 0) return refuse("UNKNOWN_LABEL", `This deployment defines no label named "${s.label}".`);
  }
  return null;
}

function takenRefusal(err: unknown, s: ConnectionSettings): Refusal | null {
  if (sqlState(err) !== UNIQUE_VIOLATION) return null;
  if (constraintOf(err) === "uq_connections_tool_prefix") {
    return refuse("TOOL_PREFIX_TAKEN", `Another connection already uses the tool prefix "${s.toolPrefix}".`);
  }
  return refuse("NAME_TAKEN", `A connection named "${s.name}" already exists.`);
}

/**
 * Add a connection. It is saved first, with no tool offered, and then its
 * server is asked for its tools (lookAtConnection): a connection whose
 * server does not answer yet is still added, and shows as failing.
 */
export async function addConnection(
  input: ConnectionSettings & { name: string; url: string; partyId: string; label: string },
  actorId: string,
  /** The credential itself, given on the page, to be kept sealed; absent when it is named in credentialEnv or none is needed. */
  credential?: string
): Promise<{ ok: true; id: string } | Refusal> {
  const cleaned = cleanSettings(input);
  if (!cleaned.ok) return cleaned;
  const s = cleaned.value;
  s.toolPrefix ??= toolPrefixFromName(s.name!);
  if (!isToolPrefix(s.toolPrefix)) {
    return refuse("INVALID_TOOL_PREFIX", "No tool prefix could be made from the name; give one in tool_prefix.");
  }
  // The id is made here, not by the database, because a credential is
  // sealed to the connection it is for before the row exists.
  const id = randomUUID();
  const transport = s.transport ?? "streamable_http";
  const header = s.credentialHeader ?? "Authorization";
  let sealed: SealedCredential | null = null;
  if (credential !== undefined) {
    if (s.credentialEnv) return refuse("INVALID_CREDENTIAL", ONE_CREDENTIAL);
    const made = sealGiven(credential, header, { connectionId: id, url: s.url!, transport });
    if (!made.ok) return made;
    sealed = made.value;
  }
  try {
    return await withTransaction(async (tx) => {
      const problem = await partyAndLabelProblem(tx, s);
      if (problem) return problem;
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO connections
           (id, name, tool_prefix, transport, url, credential_env, credential_header, party_id, stake,
            sensitivity_label, calls_per_minute, timeout_seconds, enabled, created_by,
            credential_sealed, credential_key_id, credential_set_at, credential_set_by, offered_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 CASE WHEN $15::text IS NULL THEN NULL ELSE now() END,
                 CASE WHEN $15::text IS NULL THEN NULL ELSE $14::uuid END,
                 $17::text[])
         RETURNING id`,
        [
          id,
          s.name,
          s.toolPrefix,
          transport,
          s.url,
          s.credentialEnv ?? null,
          header,
          s.partyId,
          s.stake ?? null,
          s.label,
          s.callsPerMinute ?? null,
          s.timeoutSeconds ?? CONNECTION_TIMEOUT_SECONDS.default,
          s.enabled ?? true,
          actorId,
          sealed?.sealed ?? null,
          sealed?.keyId ?? null,
          [...(s.offeredTo ?? DEFAULT_CONNECTION_ROLES)],
        ]
      );
      await logAdministrativeEvent(tx, "connection_added", actorId, {
        connection_id: row!.id,
        party_id: s.partyId!,
        label: s.label!,
      });
      return { ok: true as const, id: row!.id };
    });
  } catch (err) {
    const taken = takenRefusal(err, s);
    if (taken) return taken;
    throw err;
  }
}

// ---- a credential given on the page -----------------------------------------

/** A connection takes its credential from one place. */
const ONE_CREDENTIAL =
  "A connection takes its credential from one place: give the credential itself, which is kept sealed, " +
  "or name the environment variable that holds it in credential_env. Not both.";

/** Clean a credential as given and seal it for the connection it is for, or say why it cannot be. */
function sealGiven(
  credential: string,
  header: string,
  binding: { connectionId: string; url: string; transport: string }
): { ok: true; value: SealedCredential } | Refusal {
  const clean = cleanCredential(credential, header);
  if (!clean.ok) return refuse("INVALID_CREDENTIAL", clean.message);
  const sealed = sealCredential(clean.value, binding);
  if (!sealed.ok) return refuse("NO_CREDENTIAL_KEY", sealed.message);
  return { ok: true, value: sealed.value };
}

/**
 * Give a connection its credential, or replace the one it has: sealed to
 * the connection, its address and its transport, and stored sealed. A
 * connection that named an environment variable no longer does, since a
 * connection takes its credential from one place. Logged as a change of
 * the connection, which names no value.
 */
export async function setStoredCredential(
  id: string,
  credential: string,
  actorId: string
): Promise<{ ok: true; id: string; replaced: boolean } | Refusal> {
  if (!UUID_RE.test(id)) return refuse("NOT_FOUND", "Connection not found");
  return withTransaction(async (tx) => {
    const [before] = await tx.query<{
      url: string;
      transport: string;
      credential_header: string;
      credential_env: string | null;
      credential_sealed: string | null;
    }>(
      `SELECT url, transport, credential_header, credential_env, credential_sealed FROM connections WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!before) return refuse("NOT_FOUND", "Connection not found");
    const made = sealGiven(credential, before.credential_header, {
      connectionId: id,
      url: before.url,
      transport: before.transport,
    });
    if (!made.ok) return made;
    await tx.query(
      `UPDATE connections
          SET credential_sealed = $2, credential_key_id = $3, credential_set_at = now(), credential_set_by = $4,
              credential_env = NULL, updated_at = now()
        WHERE id = $1`,
      [id, made.value.sealed, made.value.keyId, actorId]
    );
    const changed = ["stored_credential", ...(before.credential_env !== null ? ["credential_env"] : [])];
    await logAdministrativeEvent(tx, "connection_changed", actorId, { connection_id: id, changed: changed.join("\n") });
    return { ok: true as const, id, replaced: before.credential_sealed !== null };
  });
}

/** Remove the credential given on a connection's page. The connection's calls then go without one. */
export async function removeStoredCredential(id: string, actorId: string): Promise<{ ok: true; id: string } | Refusal> {
  if (!UUID_RE.test(id)) return refuse("NOT_FOUND", "Connection not found");
  return withTransaction(async (tx) => {
    const [before] = await tx.query<{ credential_sealed: string | null }>(
      `SELECT credential_sealed FROM connections WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!before) return refuse("NOT_FOUND", "Connection not found");
    if (before.credential_sealed === null) {
      return refuse("NOTHING_TO_CHANGE", "The connection has no credential given on its page to remove.");
    }
    await tx.query(
      `UPDATE connections
          SET credential_sealed = NULL, credential_key_id = NULL, credential_set_at = NULL, credential_set_by = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id]
    );
    await logAdministrativeEvent(tx, "connection_changed", actorId, {
      connection_id: id,
      changed: "stored_credential_removed",
    });
    return { ok: true as const, id };
  });
}

const RESEAL_REASON =
  "Moving every credential kept sealed to the current key reads the connections at every label; each is sealed again and written at its own label.";

/**
 * Seal every stored credential that a previous key sealed again under the
 * current key, so that the previous key can then be taken out of the
 * environment (scripts/reseal-connection-credentials.ts). Each is opened
 * and sealed again in this process, bound to the same connection, address
 * and transport, and written at its connection's label. One that does not
 * open is left as it is and named, to be given again on its page.
 */
export async function resealStoredCredentials(): Promise<
  | { ok: true; resealed: number; already_current: number; not_opened: Array<{ id: string; name: string }> }
  | { ok: false; message: string }
> {
  const keys = credentialKeys();
  if (!keys.current) {
    return { ok: false, message: keys.problem ?? `There is no current key to seal with: ${CREDENTIAL_KEY_ENV} is not set.` };
  }
  const currentId = keys.current.id;
  const rows = await withSystemClearance(RESEAL_REASON, () =>
    rawQuery<{
      id: string;
      name: string;
      url: string;
      transport: string;
      credential_sealed: string;
      credential_key_id: string;
      sensitivity_label: string;
    }>(
      `SELECT id, name, url, transport, credential_sealed, credential_key_id, sensitivity_label
         FROM connections WHERE credential_sealed IS NOT NULL ORDER BY lower(name)`
    )
  );
  let resealed = 0;
  let alreadyCurrent = 0;
  const notOpened: Array<{ id: string; name: string }> = [];
  for (const r of rows) {
    if (r.credential_key_id === currentId) {
      alreadyCurrent += 1;
      continue;
    }
    const binding = { connectionId: r.id, url: r.url, transport: r.transport };
    const opened = openCredential({ sealed: r.credential_sealed, keyId: r.credential_key_id }, binding, keys);
    if (!opened.ok) {
      notOpened.push({ id: r.id, name: r.name });
      continue;
    }
    const sealed = sealCredential(opened.credential, binding, keys);
    if (!sealed.ok) return { ok: false, message: sealed.message };
    // Written only where the row is still as it was read: a credential
    // given again, or an address changed, in the meantime stands.
    const written = await runAtLabel(r.sensitivity_label, `connection ${r.id}`, () =>
      rawQuery(
        `UPDATE connections SET credential_sealed = $2, credential_key_id = $3
          WHERE id = $1 AND credential_sealed = $4 AND url = $5 AND transport = $6
          RETURNING id`,
        [r.id, sealed.value.sealed, sealed.value.keyId, r.credential_sealed, r.url, r.transport]
      )
    );
    if (written.length > 0) resealed += 1;
  }
  return { ok: true, resealed, already_current: alreadyCurrent, not_opened: notOpened };
}

/** The settings a change may touch, as the route names them, with the column each is. */
const SETTING_COLUMNS: Array<[keyof ConnectionSettings, string, string]> = [
  ["name", "name", "name"],
  ["toolPrefix", "tool_prefix", "tool_prefix"],
  ["transport", "transport", "transport"],
  ["url", "url", "url"],
  ["credentialEnv", "credential_env", "credential_env"],
  ["credentialHeader", "credential_header", "credential_header"],
  ["partyId", "party_id", "party_id"],
  ["stake", "stake", "stake"],
  ["callsPerMinute", "calls_per_minute", "calls_per_minute"],
  ["timeoutSeconds", "timeout_seconds", "timeout_seconds"],
  ["enabled", "enabled", "enabled"],
  ["offeredTo", "offered_to", "offered_to"],
];

/**
 * Change a connection's settings. The log entry names which settings
 * changed, and for the party, which decides whose release a kept reading
 * takes, what it was before. A new address or transport is a different
 * server as far as anyone can tell, so every tool that was offered is
 * withdrawn until an administrator looks at what the new address lists.
 * Readings already kept are not touched: they carry the party the
 * connection had when they were read.
 *
 * A credential given on the page was given for one address, so a new
 * address or transport also removes it, and it is given again for the new
 * one (connection-credential.ts binds it there too). Naming an environment
 * variable for the credential removes one given on the page, since a
 * connection takes its credential from one place.
 *
 * The label is not a setting that changes. A row keeps the label it was
 * given (src/labels.ts), and the connection's tools, its calls and the
 * readings kept from it were recorded by work that read that label. The
 * same system read at another label is a second connection.
 */
export const CONNECTION_LABEL_IS_KEPT =
  "A connection keeps the label it was added at. To have the same system read at another label, add a " +
  "second connection at that label; this one can be switched off.";

export async function changeConnection(
  id: string,
  input: ConnectionSettings,
  actorId: string
): Promise<{ ok: true; id: string; withdrawn: string[]; storedCredentialRemoved: boolean } | Refusal> {
  if (!UUID_RE.test(id)) return refuse("NOT_FOUND", "Connection not found");
  const cleaned = cleanSettings(input);
  if (!cleaned.ok) return cleaned;
  const s = cleaned.value;
  try {
    return await withTransaction(async (tx) => {
      const [before] = await tx.query<Record<string, unknown>>(`SELECT * FROM connections WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) return refuse("NOT_FOUND", "Connection not found");
      if (s.label !== undefined && s.label !== before.sensitivity_label) {
        return refuse("LABEL_IS_KEPT", CONNECTION_LABEL_IS_KEPT);
      }
      delete s.label;
      const problem = await partyAndLabelProblem(tx, s);
      if (problem) return problem;

      const sets: string[] = [];
      const params: unknown[] = [id];
      const changed: string[] = [];
      for (const [key, column, routeName] of SETTING_COLUMNS) {
        const value = s[key];
        if (value === undefined || value === before[column]) continue;
        // A list of roles is the same list when it names the same roles.
        if (Array.isArray(value) && Array.isArray(before[column]) && rolesInOrder(value).join() === rolesInOrder(before[column] as string[]).join()) {
          continue;
        }
        params.push(value);
        sets.push(`${column} = $${params.length}`);
        changed.push(routeName);
      }
      if (changed.length === 0) return refuse("NOTHING_TO_CHANGE", "Nothing in the request differs from the connection as it is.");
      const moved = changed.includes("url") || changed.includes("transport");
      const storedCredentialRemoved =
        before.credential_sealed !== null && (moved || (changed.includes("credential_env") && s.credentialEnv !== null));
      if (storedCredentialRemoved) {
        sets.push(
          "credential_sealed = NULL",
          "credential_key_id = NULL",
          "credential_set_at = NULL",
          "credential_set_by = NULL"
        );
        changed.push("stored_credential_removed");
      }
      await tx.query(`UPDATE connections SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);

      const withdrawn = moved
        ? (
            await tx.query<{ name: string }>(
              `UPDATE connection_tools
                  SET offered = false, withdrawn_at = now(), withdrawn_reason = 'address_changed'
                WHERE connection_id = $1 AND offered
                RETURNING name`,
              [id]
            )
          ).map((r) => r.name)
        : [];

      await logAdministrativeEvent(tx, "connection_changed", actorId, {
        connection_id: id,
        changed: changed.join("\n"),
        ...(changed.includes("party_id")
          ? { party_id: s.partyId!, previous_party_id: before.party_id as string }
          : {}),
      });
      for (const tool of withdrawn) {
        await logAdministrativeEvent(tx, "connection_tool_withdrawn", actorId, {
          connection_id: id,
          tool,
          reason: "address_changed",
        });
      }
      return { ok: true as const, id, withdrawn, storedCredentialRemoved };
    });
  } catch (err) {
    const taken = takenRefusal(err, s);
    if (taken) return taken;
    throw err;
  }
}

// ---- the connection's state -------------------------------------------------

/**
 * The connection's state is the same whoever finds it out: that its server
 * answered, that it could not be reached, that a tool it lists has changed.
 * A run at a label that reads the connection's finds these out as often as
 * an administrator does, and a row is changed only by work at its own label
 * (db/clearance.ts), so what is learned about the connection is written at
 * the connection's label, whichever run or request learned it (the second
 * stamping rule, src/labels.ts).
 */
type AtItsLabel = { id: string; label: string };

function atConnectionLabel<T>(connection: AtItsLabel, fn: () => Promise<T>): Promise<T> {
  if (connection.label === currentLabel()) return fn();
  return runAtLabel(connection.label, `connection ${connection.id}`, fn);
}

/** Record that the connection's server answered just now. */
export async function noteConnectionAnswered(connection: AtItsLabel): Promise<void> {
  await atConnectionLabel(connection, () =>
    rawQuery(`UPDATE connections SET last_checked_at = now(), last_answered_at = now() WHERE id = $1`, [connection.id])
  );
}

/**
 * What the connection's row says of a call that failed for a reason the
 * deployment could not name. The error's own words came back to a call whose
 * arguments a run wrote, at that run's label, and a system can repeat an
 * argument in its error. Those words stay on the call's row, at the run's
 * label; the connection's row, which administrators at the connection's
 * label read, says this.
 */
export const CALL_FAILED_ON_CONNECTION =
  "a call failed for a reason this deployment could not name; what the system said is on the call's own record";
export const CALL_REFUSED_ON_CONNECTION =
  "the system refused the deployment's credential on a call; it may have expired or been withdrawn";

/** What the connection's row is given for a failure: the failure's own words, or fixed ones for a call's. */
function connectionRowMessage(failure: ConnectionFailure, during: "list" | "call"): string {
  if (during === "list") return failure.message;
  if (failure.kind === "failed") return CALL_FAILED_ON_CONNECTION;
  if (failure.kind === "credential_refused") return CALL_REFUSED_ON_CONNECTION;
  // credential_missing, no_answer, unreachable: fixed words about the connection, with no text from the system.
  return failure.message;
}

/**
 * Record that the connection's server could not be read just now, and why.
 * `during` says what was being asked: the server's list of tools, which
 * carries nothing of any run's, or a call a run composed.
 */
export async function noteConnectionFailed(
  connection: AtItsLabel,
  failure: ConnectionFailure,
  during: "list" | "call" = "list"
): Promise<void> {
  const message = connectionRowMessage(failure, during);
  await atConnectionLabel(connection, () =>
    rawQuery(
      `UPDATE connections SET last_checked_at = now(), last_error = $2, last_error_at = now() WHERE id = $1`,
      [connection.id, message]
    )
  );
}

// ---- looking at a server's tools --------------------------------------------

/**
 * Stop offering a tool that was offered, with the reason, and log it. Does
 * nothing to a tool that is not offered, so a withdrawal is logged once.
 */
async function withdrawTool(
  tx: TxQuery,
  connectionId: string,
  tool: string,
  reason: WithdrawnReason,
  actorId: string | null
): Promise<boolean> {
  const changed = await tx.query(
    `UPDATE connection_tools
        SET offered = false, withdrawn_at = now(), withdrawn_reason = $3
      WHERE connection_id = $1 AND name = $2 AND offered
      RETURNING name`,
    [connectionId, tool, reason]
  );
  if (changed.length === 0) return false;
  await logAdministrativeEvent(tx, "connection_tool_withdrawn", actorId, {
    connection_id: connectionId,
    tool,
    reason,
  });
  return true;
}

export type Looked =
  | { ok: true; answered: true; withdrawn: Array<{ name: string; reason: WithdrawnReason }> }
  | { ok: true; answered: false; failure: ConnectionFailure }
  | { ok: false; code: "NOT_FOUND"; message: string };

/**
 * An administrator looks at a connection: ask its server for its tools as
 * they are now and store each definition as given. This is what "an
 * administrator looks again" means. A tool that is new is stored and not
 * offered. A tool whose definition differs from the one stored is stored as
 * it now is, and if it was offered it no longer is, until it is picked
 * again on the definition now shown. A tool the server no longer lists is
 * kept as a row that says so while anything refers to it. Nothing here
 * offers a tool: that is always a pick (offerTools).
 */
export async function lookAtConnection(id: string, actorId: string): Promise<Looked> {
  if (!UUID_RE.test(id)) return { ok: false, code: "NOT_FOUND", message: "Connection not found" };
  const [row] = await rawQuery<ConnectionRow>(`${CONNECTION_SELECT} WHERE c.id = $1`, [id]);
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Connection not found" };

  const at = { id, label: row.sensitivity_label };
  const listed = await listServerTools(targetOf(row));
  if (!listed.ok) {
    await noteConnectionFailed(at, listed.failure);
    return { ok: true, answered: false, failure: listed.failure };
  }
  await noteConnectionAnswered(at);

  const withdrawn = await withTransaction(async (tx) => {
    const out: Array<{ name: string; reason: WithdrawnReason }> = [];
    const stored = await tx.query<{ name: string; definition_hash: string; offered: boolean }>(
      `SELECT name, definition_hash, offered FROM connection_tools WHERE connection_id = $1 FOR UPDATE`,
      [id]
    );
    const byName = new Map(stored.map((t) => [t.name, t]));
    const live = new Set<string>();
    for (const tool of listed.tools) {
      // A server that lists one name twice has listed one tool; the first stands.
      if (live.has(tool.name)) continue;
      live.add(tool.name);
      const hash = toolDefinitionHash(tool);
      const before = byName.get(tool.name);
      if (before && before.definition_hash !== hash && (await withdrawTool(tx, id, tool.name, "changed", actorId))) {
        out.push({ name: tool.name, reason: "changed" });
      }
      await tx.query(
        // The connection's label: a tool's name, description and schema are
        // the system describing itself, the same whoever looks (src/labels.ts).
        `INSERT INTO connection_tools
           (connection_id, name, description, input_schema, annotations, definition_hash, listed, seen_at, sensitivity_label)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, true, now(), $7)
         ON CONFLICT (connection_id, name) DO UPDATE
           SET description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
               annotations = EXCLUDED.annotations, definition_hash = EXCLUDED.definition_hash,
               listed = true, seen_at = now()`,
        [
          id,
          tool.name,
          tool.description,
          JSON.stringify(tool.inputSchema ?? null),
          tool.annotations === null ? null : JSON.stringify(tool.annotations),
          hash,
          row.sensitivity_label,
        ]
      );
    }
    for (const t of stored) {
      if (live.has(t.name)) continue;
      if (await withdrawTool(tx, id, t.name, "missing", actorId)) out.push({ name: t.name, reason: "missing" });
      // A tool that is gone and was never called leaves nothing to show.
      await tx.query(
        `DELETE FROM connection_tools t
          WHERE t.connection_id = $1 AND t.name = $2 AND t.withdrawn_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM connection_calls k WHERE k.connection_id = t.connection_id AND k.tool = t.name)`,
        [id, t.name]
      );
      await tx.query(`UPDATE connection_tools SET listed = false WHERE connection_id = $1 AND name = $2`, [id, t.name]);
    }
    return out;
  });
  return { ok: true, answered: true, withdrawn };
}

// ---- picking ----------------------------------------------------------------

export type OfferFailureCode =
  | "NOT_FOUND"
  | "UNKNOWN_TOOL"
  | "TOOL_CHANGED"
  | "TOOL_NOT_LISTED"
  | "MARKED_AS_WRITING"
  | "WRITE_NOT_ACKNOWLEDGED"
  | "WRITE_REASON_NEEDED"
  | "HELD_NEEDS_WRITE_GRANT"
  | "INVALID_PRICE"
  | "NAME_NOT_OFFERABLE"
  | "SCHEMA_NOT_OFFERABLE";

/** One tool in a pick: the definition the administrator read, and the terms it is offered on. */
export interface ToolPick {
  name: string;
  definitionHash: string;
  /**
   * Present to pick the tool as one that writes: the administrator
   * acknowledges WRITE_ACKNOWLEDGEMENT and gives their reason. Absent, the
   * tool is picked as one that reads.
   */
  writes?: { acknowledged: boolean; reason: string };
  /** A write call waits for an administrator before it is sent. Only with `writes`. */
  held?: boolean;
  /** What one answered call is charged to the run's budget, in owls. Absent or 0: not charged. */
  owlsPerCall?: number;
}

/**
 * Set which of a connection's tools agents are offered: the whole set, each
 * tool named with the hash of the definition the administrator looked at,
 * and with the terms it is offered on. A pick is refused when the tool
 * stored is not that definition (it changed between looking and picking),
 * when the server no longer lists it, when the server itself marks it as
 * writing and the pick carries no write grant, when a write grant is not
 * acknowledged or gives no reason, or when the tool's name or schema could
 * not be given to a model. Either every pick in the request stands or none
 * does.
 *
 * The request is the whole of what is offered and on what terms. A tool
 * left out is no longer offered and loses its write grant and its price; a
 * tool named without `writes` is picked as one that reads, so a write grant
 * it had is revoked. A write grant restated with the reason it already has,
 * on a tool still offered, is the same grant, by whoever made it; a new
 * reason, or a pick of a tool that was not offered, is a new one.
 */
export async function offerTools(
  id: string,
  picks: ReadonlyArray<ToolPick>,
  actorId: string
): Promise<
  | { ok: true; offered: string[]; noLongerOffered: string[]; writeGranted: string[]; writeRevoked: string[] }
  | { ok: false; code: OfferFailureCode; message: string }
> {
  const no = (code: OfferFailureCode, message: string) => ({ ok: false as const, code, message });
  if (!UUID_RE.test(id)) return no("NOT_FOUND", "Connection not found");
  return withTransaction(async (tx) => {
    const [connection] = await tx.query<{ tool_prefix: string }>(
      `SELECT tool_prefix FROM connections WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!connection) return no("NOT_FOUND", "Connection not found");
    const stored = await tx.query<{
      name: string;
      definition_hash: string;
      listed: boolean;
      offered: boolean;
      annotations: Record<string, unknown> | null;
      input_schema: unknown;
      writes: boolean;
      write_reason: string | null;
      write_held: boolean;
      call_price_micro_usd: number;
    }>(
      `SELECT name, definition_hash, listed, offered, annotations, input_schema,
              writes, write_reason, write_held, call_price_micro_usd
         FROM connection_tools WHERE connection_id = $1 FOR UPDATE`,
      [id]
    );
    const byName = new Map(stored.map((t) => [t.name, t]));
    interface Terms {
      hash: string;
      writeReason: string | null;
      held: boolean;
      priceMicroUsd: number;
    }
    const wanted = new Map<string, Terms>();
    for (const pick of picks) {
      const name = pick.name;
      const tool = byName.get(name);
      if (!tool) {
        return no("UNKNOWN_TOOL", `The connection has no tool named "${name}" on record. Look at the connection again to see what its server lists.`);
      }
      if (!tool.listed) {
        return no("TOOL_NOT_LISTED", `The server no longer listed "${name}" when the connection was last looked at, so it cannot be offered.`);
      }
      if (tool.definition_hash !== pick.definitionHash) {
        return no(
          "TOOL_CHANGED",
          `"${name}" is not the definition this pick was made on: it has changed since. Read the connection again and pick the tool as it now is.`
        );
      }
      let writeReason: string | null = null;
      if (pick.writes !== undefined) {
        if (pick.writes.acknowledged !== true) {
          return no(
            "WRITE_NOT_ACKNOWLEDGED",
            `"${name}" can be granted to write only when you acknowledge what that means: ${WRITE_ACKNOWLEDGEMENT}`
          );
        }
        writeReason = pick.writes.reason.trim();
        if (!writeReason || writeReason.length > WRITE_REASON_MAX_CHARS) {
          return no(
            "WRITE_REASON_NEEDED",
            `A write grant for "${name}" needs your reason, in a sentence or two (at most ${WRITE_REASON_MAX_CHARS} ` +
              `characters): why agents should be able to write to this system through it. Every agent offered the tool is told it.`
          );
        }
      } else if (markedAsWriting(tool.annotations)) {
        return no(
          "MARKED_AS_WRITING",
          `The server itself marks "${name}" as a tool that changes things, so it is offered to agents only under a ` +
            `write grant: pick it with \`writes\`, acknowledging what that means and giving your reason.`
        );
      }
      if (pick.held === true && writeReason === null) {
        return no(
          "HELD_NEEDS_WRITE_GRANT",
          `Only calls to a tool granted to write wait for an administrator, and "${name}" is picked as one that reads.`
        );
      }
      const owls = pick.owlsPerCall ?? 0;
      const priceMicroUsd = Number.isFinite(owls) ? owlsToMicroUsd(owls) : -1;
      if (priceMicroUsd < 0 || priceMicroUsd > CALL_PRICE_MAX_MICRO_USD) {
        return no(
          "INVALID_PRICE",
          `owls_per_call for "${name}" is what one call is charged to the run's budget: 0 for no charge, ` +
            `and at most ${microUsdToOwls(CALL_PRICE_MAX_MICRO_USD)} owls.`
        );
      }
      const nameProblem = offeredNameProblem(connection.tool_prefix, name);
      if (nameProblem) return no("NAME_NOT_OFFERABLE", nameProblem);
      // A model is given a tool's schema as it stands, and a request that
      // carries one it cannot take is refused whole: one such tool would
      // fail every run that was offered it.
      const schema = tool.input_schema as { type?: unknown } | null;
      if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") {
        return no(
          "SCHEMA_NOT_OFFERABLE",
          `"${name}" cannot be offered: its input schema is not a JSON Schema of type "object", which is what a model takes for a tool.`
        );
      }
      wanted.set(name, { hash: pick.definitionHash, writeReason, held: pick.held === true, priceMicroUsd });
    }

    const offered: string[] = [];
    const noLongerOffered: string[] = [];
    const writeGranted: string[] = [];
    const writeRevoked: string[] = [];
    for (const tool of stored) {
      const terms = wanted.get(tool.name);
      if (terms && !tool.offered) offered.push(tool.name);
      if (!terms && tool.offered) noLongerOffered.push(tool.name);
      // The tool as it stood for agents before this request: a grant on a
      // tool that was not offered granted nothing.
      const wrote = tool.offered && tool.writes;
      const sameGrant = wrote && terms !== undefined && terms.writeReason === tool.write_reason;
      if (!terms || terms.writeReason === null) {
        // Left out, or picked as one that reads: no grant, and for a tool
        // left out, no price either.
        if (wrote) {
          writeRevoked.push(tool.name);
          await logAdministrativeEvent(tx, "connection_tool_write_revoked", actorId, { connection_id: id, tool: tool.name });
        }
        await tx.query(
          `UPDATE connection_tools
              SET writes = false, write_reason = NULL, write_acknowledgement = NULL, write_granted_by = NULL,
                  write_granted_at = NULL, write_held = false, call_price_micro_usd = $3
            WHERE connection_id = $1 AND name = $2`,
          [id, tool.name, terms?.priceMicroUsd ?? 0]
        );
      } else if (sameGrant) {
        await tx.query(
          `UPDATE connection_tools SET write_held = $3, call_price_micro_usd = $4 WHERE connection_id = $1 AND name = $2`,
          [id, tool.name, terms.held, terms.priceMicroUsd]
        );
      } else {
        writeGranted.push(tool.name);
        await tx.query(
          `UPDATE connection_tools
              SET writes = true, write_reason = $3, write_acknowledgement = $4, write_granted_by = $5,
                  write_granted_at = now(), write_held = $6, call_price_micro_usd = $7
            WHERE connection_id = $1 AND name = $2`,
          [id, tool.name, terms.writeReason, WRITE_ACKNOWLEDGEMENT, actorId, terms.held, terms.priceMicroUsd]
        );
        await logAdministrativeEvent(tx, "connection_tool_write_granted", actorId, {
          connection_id: id,
          tool: tool.name,
          write_reason: terms.writeReason,
          held: String(terms.held),
        });
      }
      // The terms of a tool that stays as it was, changed: whether its
      // write calls wait, and what a call costs a run.
      if (terms && tool.offered) {
        const changed = [
          ...(sameGrant && terms.held !== tool.write_held ? ["held"] : []),
          ...(terms.priceMicroUsd !== tool.call_price_micro_usd ? ["owls_per_call"] : []),
        ];
        if (changed.length > 0) {
          await logAdministrativeEvent(tx, "connection_tool_terms_changed", actorId, {
            connection_id: id,
            tool: tool.name,
            changed: changed.join("\n"),
            held: String(terms.held),
            price_micro_usd: String(terms.priceMicroUsd),
          });
        }
      }
    }
    // A pick, and a tool left out, each settle the tool's state: a
    // withdrawal recorded against an earlier pick no longer describes it.
    await tx.query(
      `UPDATE connection_tools
          SET offered = (name = ANY($2::text[])),
              offered_by = CASE WHEN name = ANY($2::text[]) AND NOT offered THEN $3::uuid ELSE offered_by END,
              offered_at = CASE WHEN name = ANY($2::text[]) AND NOT offered THEN now() ELSE offered_at END,
              withdrawn_at = NULL, withdrawn_reason = NULL
        WHERE connection_id = $1`,
      [id, [...wanted.keys()], actorId]
    );
    if (offered.length > 0 || noLongerOffered.length > 0) {
      await logAdministrativeEvent(tx, "connection_tools_offered", actorId, {
        connection_id: id,
        offered: offered.sort().join("\n"),
        no_longer_offered: noLongerOffered.sort().join("\n"),
      });
    }
    return {
      ok: true as const,
      offered: offered.sort(),
      noLongerOffered: noLongerOffered.sort(),
      writeGranted: writeGranted.sort(),
      writeRevoked: writeRevoked.sort(),
    };
  });
}

// ---- what a run is offered --------------------------------------------------

/** One of a connection's tools as a run is offered it. */
export interface OfferedTool {
  /** The tool's name at the server. */
  name: string;
  /** The name the run calls it by. */
  offeredAs: string;
  description: string;
  inputSchema: unknown;
  /** The hash of the definition the tool was picked on, which is the one the run is offered. */
  definitionHash: string;
  /**
   * Set for a tool granted to write: the administrator's reason, and
   * whether a call waits for an administrator before it is sent. Null for a
   * tool picked as one that reads.
   */
  writes: { reason: string; held: boolean } | null;
  /** What one answered call is charged to the run's budget; 0 when calls are not charged. */
  priceMicroUsd: number;
}

/**
 * Why a run is not offered a tool granted to write that its connection has.
 * `label`: the run works at a label that reads the connection's and is not
 * it. `assistant`: the run is the Assistant's.
 */
export type WriteWithheldReason = "label" | "assistant";

/** A connection as a run has it. */
export interface RunConnection {
  id: string;
  name: string;
  toolPrefix: string;
  partyId: string;
  partyName: string;
  stake: string | null;
  label: string;
  callsPerMinute: number | null;
  timeoutSeconds: number;
  target: ConnectionTarget;
  /** The tools the run is offered. Empty when the connection could not be read or every pick is withdrawn. */
  tools: OfferedTool[];
  /** Why the server could not be read when the run's toolset was put together; null when it answered. */
  unavailable: ConnectionFailure | null;
  /** Tools an administrator picked that the run is not offered, each with why. */
  withdrawn: Array<{ name: string; reason: WithdrawnReason }>;
  /** Tools granted to write that this run is not offered because of where or for whom it works, each with why. */
  writesWithheld: Array<{ name: string; reason: WriteWithheldReason }>;
}

/**
 * The connections a run working at `label` in `role` has, with the tools
 * it is offered from each: every connection that is on, whose label that
 * label reads, that an administrator offered to the role, and that has a
 * tool an administrator picked. Each server is asked
 * for its tools as they are now. A picked tool is offered only where the
 * server's definition still has the hash the pick was made on; one that
 * differs or is gone is withdrawn here, for this run and every later one,
 * until an administrator looks again.
 *
 * A connection with a withdrawn tool and none offered is still returned, so
 * the run can be told the reading it might have made is not available and
 * why.
 *
 * A tool granted to write is offered more narrowly than one that reads, and
 * a run that is not offered it for one of these reasons is told so:
 *
 *  - Only to a run that works at the connection's own label. A run adds
 *    rows only at its own label (db/clearance.ts), and a write through a
 *    connection is the same act somewhere else: its arguments are the
 *    content, and they land in a system whose readers are those of the
 *    connection's label. A run at a label that reads the connection's knows
 *    more than those readers may, so a write from it would be a write down.
 *    For a read the same run is told that its arguments leave
 *    (argumentsLeaveNote), because a query says little; a write is all
 *    arguments. The system's own work at that label can make the write.
 *  - Never to the Assistant. It works for whichever member is in the
 *    conversation, on text it reads while it works, and what stands between
 *    injected text and an act there is its person's press of a card. A
 *    write grant is an administrator's judgment about agents doing the
 *    deployment's own work, and a held call is an administrator's to
 *    release, not a member's. Giving the Assistant a way to write to an
 *    organization's system is its own decision, not made here.
 */
export async function connectionsOfferedAt(
  label: string,
  role: ConnectionRole,
  opts: {
    /**
     * Only connections at these labels, where the run's reading goes on to
     * a person: the Assistant's, held to the labels whose raw sources its
     * person may open (src/raw-sources.ts). Null or absent: no such limit.
     */
    onlyLabels?: readonly string[] | null;
  } = {}
): Promise<RunConnection[]> {
  const readable = await labelsReadableFrom([label]);
  const labels = opts.onlyLabels ? readable.filter((l) => opts.onlyLabels!.includes(l)) : readable;
  if (labels.length === 0) return [];
  const rows = await rawQuery<ConnectionRow>(
    `${CONNECTION_SELECT}
      WHERE c.enabled AND c.sensitivity_label = ANY($1::text[]) AND $2 = ANY(c.offered_to)
        AND EXISTS (SELECT 1 FROM connection_tools t
                     WHERE t.connection_id = c.id AND (t.offered OR t.withdrawn_at IS NOT NULL))
      ORDER BY lower(c.name)`,
    [labels, role]
  );
  return Promise.all(
    rows.map((c) =>
      runConnection(c, false, role === "assistant" ? "assistant" : c.sensitivity_label !== label ? "label" : null)
    )
  );
}

/**
 * One connection as a run has it. With `askAnyway`, the server is asked for
 * its tools even when none is offered, for a check that wants to know
 * whether it answers.
 */
async function runConnection(
  c: ConnectionRow,
  askAnyway = false,
  /** Why this run is not offered the connection's tools that write; null when it is. */
  writesWithheld: WriteWithheldReason | null = null
): Promise<RunConnection> {
  const target = targetOf(c);
  const picked = await rawQuery<{
    name: string;
    description: string;
    input_schema: unknown;
    definition_hash: string;
    offered: boolean;
    withdrawn_reason: string | null;
    writes: boolean;
    write_reason: string | null;
    write_held: boolean;
    call_price_micro_usd: number;
  }>(
    `SELECT name, description, input_schema, definition_hash, offered, withdrawn_reason,
            writes, write_reason, write_held, call_price_micro_usd
       FROM connection_tools
      WHERE connection_id = $1 AND (offered OR withdrawn_at IS NOT NULL)
      ORDER BY name`,
    [c.id]
  );
  const out: RunConnection = {
    id: c.id,
    name: c.name,
    toolPrefix: c.tool_prefix,
    partyId: c.party_id,
    partyName: c.party_name,
    stake: c.stake,
    label: c.sensitivity_label,
    callsPerMinute: c.calls_per_minute,
    timeoutSeconds: c.timeout_seconds,
    target,
    tools: [],
    unavailable: null,
    withdrawn: picked
      .filter((t) => !t.offered)
      .map((t) => ({ name: t.name, reason: (t.withdrawn_reason ?? "changed") as WithdrawnReason })),
    writesWithheld: [],
  };
  const offered = picked.filter((t) => t.offered);
  if (offered.length === 0 && !askAnyway) return out;

  const listed = await listServerTools({
    ...target,
    timeoutSeconds: Math.min(target.timeoutSeconds, RUN_START_LIST_TIMEOUT_SECONDS),
  });
  const at = { id: c.id, label: c.sensitivity_label };
  if (!listed.ok) {
    await noteConnectionFailed(at, listed.failure);
    out.unavailable = listed.failure;
    return out;
  }
  await noteConnectionAnswered(at);

  const liveHash = new Map<string, string>();
  for (const tool of listed.tools) {
    if (!liveHash.has(tool.name)) liveHash.set(tool.name, toolDefinitionHash(tool));
  }
  for (const tool of offered) {
    const now = liveHash.get(tool.name);
    if (now === tool.definition_hash) {
      if (tool.writes && writesWithheld !== null) {
        out.writesWithheld.push({ name: tool.name, reason: writesWithheld });
        continue;
      }
      out.tools.push({
        name: tool.name,
        offeredAs: offeredToolName(c.tool_prefix, tool.name),
        description: tool.description,
        inputSchema: tool.input_schema,
        definitionHash: tool.definition_hash,
        writes: tool.writes ? { reason: tool.write_reason ?? "", held: tool.write_held } : null,
        priceMicroUsd: tool.call_price_micro_usd,
      });
      continue;
    }
    const reason: WithdrawnReason = now === undefined ? "missing" : "changed";
    // No person made this change, so the log entry has no actor. It is a
    // fact about the system's tool, written at the connection's label.
    await atConnectionLabel(at, () => withTransaction((tx) => withdrawTool(tx, c.id, tool.name, reason, null)));
    out.withdrawn.push({ name: tool.name, reason });
  }
  out.withdrawn.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * A connection and one of its tools as they stand now, for a call that
 * waited for an administrator and is about to be sent: whether the
 * connection is on, where to send, and whether the tool is still what the
 * agent was offered. Read inside the transaction that takes the decision.
 */
export async function connectionForHeldCall(
  tx: TxQuery,
  connectionId: string,
  toolName: string
): Promise<{
  enabled: boolean;
  label: string;
  toolPrefix: string;
  target: ConnectionTarget;
  tool: { offered: boolean; writes: boolean; definitionHash: string } | null;
} | null> {
  const [c] = await tx.query<ConnectionRow>(`${CONNECTION_SELECT} WHERE c.id = $1`, [connectionId]);
  if (!c) return null;
  const [t] = await tx.query<{ offered: boolean; writes: boolean; definition_hash: string }>(
    `SELECT offered, writes, definition_hash FROM connection_tools WHERE connection_id = $1 AND name = $2`,
    [connectionId, toolName]
  );
  return {
    enabled: c.enabled,
    label: c.sensitivity_label,
    toolPrefix: c.tool_prefix,
    target: targetOf(c),
    tool: t ? { offered: t.offered, writes: t.writes, definitionHash: t.definition_hash } : null,
  };
}

// ---- the calls an administrator sees ---------------------------------------

export interface ConnectionCallView {
  /** The reading's id, as the agent that made the call was given it. */
  id: string;
  tool: string;
  called_at: string;
  duration_ms: number | null;
  /** in_flight | answered | tool_error | failed | held | declined | not_sent */
  outcome: string;
  /** Whether the call was to a tool granted to write when it was made. */
  writes: boolean;
  /** What the call was charged to its run's budget, in owls. */
  charged_owls: number;
  /** Why a failed call failed: the deployment's own account of it, never the system's words. */
  error: string | null;
  result_chars: number | null;
  result_sha256: string | null;
  run_id: string | null;
  agent: string | null;
  /** The node the calling run was working on, when it was working on one. */
  claim_id: string | null;
  /** The source kept from the call, when an agent's work rested on it. */
  source_id: string | null;
  kept_at: string | null;
  /** The call's arguments, as the agent wrote them. */
  arguments: unknown;
}

/**
 * A connection's calls, newest first, without their results. A call is a
 * row at the label of the run that made it, arguments and all, so the list
 * holds the calls the caller's clearance reads: administering a deployment
 * does not by that alone let a person read what its agents wrote, or learn
 * which node work at another label was on. `notShown` counts the rest. What
 * the system answered is never in this list. A kept reading is read as the
 * source it became.
 */
export async function listConnectionCalls(
  id: string,
  opts: { limit?: number; before?: string; keptOnly?: boolean }
): Promise<{ calls: ConnectionCallView[]; notShown: number } | null> {
  if (!UUID_RE.test(id)) return null;
  const [exists] = await rawQuery(`SELECT 1 FROM connections WHERE id = $1`, [id]);
  if (!exists) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 500);
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? opts.before : null;
  const rows = await rawQuery<{
    id: string;
    tool: string;
    called_at: Date;
    duration_ms: number | null;
    outcome: string | null;
    writes: boolean;
    charged_micro_usd: number;
    error: string | null;
    result_chars: number | null;
    result_hash: string | null;
    run_id: string | null;
    agent: string | null;
    claim_id: string | null;
    source_id: string | null;
    kept_at: Date | null;
    arguments: unknown;
    sensitivity_label: string;
  }>(
    `SELECT id, tool, called_at, duration_ms, outcome, writes, charged_micro_usd, error, result_chars, result_hash,
            run_id, agent, claim_id, source_id, kept_at, arguments, sensitivity_label
       FROM connection_calls
      WHERE connection_id = $1
        AND ($2::timestamptz IS NULL OR called_at < $2::timestamptz)
        AND (NOT $3::boolean OR source_id IS NOT NULL)
      ORDER BY called_at DESC, id DESC
      LIMIT $4`,
    [id, before, opts.keptOnly === true, limit]
  );
  const [visible] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM connection_calls WHERE connection_id = $1`,
    [id]
  );
  const all = await countAtEveryLabel(`SELECT count(*)::int AS n FROM connection_calls WHERE connection_id = $1`, [id]);
  const calls = rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    called_at: iso(r.called_at)!,
    duration_ms: r.duration_ms,
    outcome: r.outcome ?? "in_flight",
    writes: r.writes,
    charged_owls: microUsdToOwls(r.charged_micro_usd),
    error: r.outcome === "failed" || r.outcome === "not_sent" ? r.error : null,
    result_chars: r.result_chars,
    result_sha256: r.result_hash,
    run_id: r.run_id,
    agent: r.agent,
    claim_id: r.claim_id,
    source_id: r.source_id,
    kept_at: iso(r.kept_at),
    arguments: r.arguments,
  }));
  return { calls, notShown: Math.max(0, all - (visible?.n ?? 0)) };
}

// ---- the writes an administrator watches -----------------------------------

/** How much of what came back a list of writes shows for each call. The whole result is on the call's run log. */
export const WRITE_RESULT_SHOWN_CHARS = 4000;

export interface ConnectionWriteView {
  /** The call's id: the reading's id, as the agent that made the call was given it. */
  id: string;
  tool: string;
  called_at: string;
  /** held | in_flight | answered | tool_error | failed | declined | not_sent */
  outcome: string;
  /** Why a call failed or was not sent: the deployment's own account of it. */
  error: string | null;
  duration_ms: number | null;
  run_id: string | null;
  agent: string | null;
  claim_id: string | null;
  /** The label of the run that made the call, which is the connection's: a tool that writes is offered at no other. */
  label: string;
  /** What was sent, or for a held call what would be: the call's arguments, as the agent wrote them. */
  sent: unknown;
  /**
   * What came back: the first part of the stored result, with its size and
   * SHA-256. Null while nothing has (held, in flight, failed, declined). A
   * notice in place of the text for a reader who may not open raw sources
   * at the call's label (src/raw-sources.ts).
   */
  came_back:
    | { content: string; total_chars: number; truncated: boolean; sha256: string; system_error: boolean }
    | { withheld: WithheldSourceText; total_chars: number; sha256: string; system_error: boolean }
    | null;
  /** Set for a call that waited for an administrator: since when, and how it was decided once it was. */
  held: {
    at: string;
    decided: { at: string; by: { id: string; name: string } | null; decision: "approved" | "declined"; note: string | null } | null;
  } | null;
  charged_owls: number;
  /** What the call would be charged when it is sent, for one still held. */
  owls_per_call: number;
}

/**
 * The calls made through a connection to tools granted to write, newest
 * first, each with what was sent and what came back. This is what an
 * administrator watches a write grant by. Like the list of all calls it
 * holds the rows the caller's clearance reads, and `notShown` counts the
 * rest. Unlike it, it shows what the system answered: an administrator who
 * granted a tool to write has to be able to see what the write did. That is
 * a system's own text returned to a person, so it is shown to a reader who
 * may open raw sources at the call's label and marked as withheld to one
 * who may not, like the document of a kept reading.
 */
export async function listConnectionWrites(
  id: string,
  opts: { limit?: number; before?: string; heldOnly?: boolean; rawSourceLabels: readonly string[] | null }
): Promise<{ writes: ConnectionWriteView[]; waiting: number; notShown: number } | null> {
  if (!UUID_RE.test(id)) return null;
  const [exists] = await rawQuery(`SELECT 1 FROM connections WHERE id = $1`, [id]);
  if (!exists) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 500);
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? opts.before : null;
  const rows = await rawQuery<{
    id: string;
    tool: string;
    called_at: Date;
    outcome: string | null;
    error: string | null;
    duration_ms: number | null;
    run_id: string | null;
    agent: string | null;
    claim_id: string | null;
    sensitivity_label: string;
    arguments: unknown;
    shown: string | null;
    result_chars: number | null;
    result_hash: string | null;
    held_at: Date | null;
    decided_at: Date | null;
    decided_by: string | null;
    decided_by_name: string | null;
    decision_note: string | null;
    charged_micro_usd: number;
    price_micro_usd: number;
  }>(
    `SELECT k.id, k.tool, k.called_at, k.outcome, k.error, k.duration_ms, k.run_id, k.agent, k.claim_id,
            k.sensitivity_label, k.arguments, left(k.result, $5) AS shown, k.result_chars, k.result_hash,
            k.held_at, k.decided_at, k.decided_by, k.decision_note, k.charged_micro_usd, k.price_micro_usd,
            (SELECT g.display_name FROM contributors g WHERE g.id = k.decided_by) AS decided_by_name
       FROM connection_calls k
      WHERE k.connection_id = $1 AND k.writes
        AND ($2::timestamptz IS NULL OR k.called_at < $2::timestamptz)
        AND (NOT $3::boolean OR k.outcome = 'held')
      ORDER BY k.called_at DESC, k.id DESC
      LIMIT $4`,
    [id, before, opts.heldOnly === true, limit, WRITE_RESULT_SHOWN_CHARS]
  );
  const [visible] = await rawQuery<{ n: number; waiting: number }>(
    `SELECT count(*)::int AS n, (count(*) FILTER (WHERE outcome = 'held'))::int AS waiting
       FROM connection_calls WHERE connection_id = $1 AND writes`,
    [id]
  );
  const all = await countAtEveryLabel(
    `SELECT count(*)::int AS n FROM connection_calls WHERE connection_id = $1 AND writes`,
    [id]
  );
  const writes = rows.map((r): ConnectionWriteView => {
    const answered = r.shown !== null && r.result_hash !== null;
    const about = { total_chars: r.result_chars ?? 0, sha256: r.result_hash ?? "", system_error: r.outcome === "tool_error" };
    return {
      id: r.id,
      tool: r.tool,
      called_at: iso(r.called_at)!,
      outcome: r.outcome ?? "in_flight",
      error: r.outcome === "failed" || r.outcome === "not_sent" ? r.error : null,
      duration_ms: r.duration_ms,
      run_id: r.run_id,
      agent: r.agent,
      claim_id: r.claim_id,
      label: r.sensitivity_label,
      sent: r.arguments,
      came_back: !answered
        ? null
        : mayOpenRawSources(opts.rawSourceLabels, r.sensitivity_label)
          ? { content: r.shown!, truncated: (r.result_chars ?? 0) > r.shown!.length, ...about }
          : { withheld: withheldCallResult(r.sensitivity_label), ...about },
      held:
        r.held_at === null
          ? null
          : {
              at: iso(r.held_at)!,
              decided:
                r.decided_at === null
                  ? null
                  : {
                      at: iso(r.decided_at)!,
                      by: r.decided_by !== null ? { id: r.decided_by, name: r.decided_by_name ?? "" } : null,
                      decision: r.outcome === "declined" ? "declined" : "approved",
                      note: r.decision_note,
                    },
            },
      charged_owls: microUsdToOwls(r.charged_micro_usd),
      owls_per_call: microUsdToOwls(r.price_micro_usd),
    };
  });
  return { writes, waiting: visible?.waiting ?? 0, notShown: Math.max(0, all - (visible?.n ?? 0)) };
}

// ---- for the preflight ------------------------------------------------------

/** What the preflight needs to know of one connection (docs/connections.md, "What the preflight should check"). */
export interface ConnectionCheck {
  id: string;
  name: string;
  /**
   * Where its credential comes from, the variable when it is one, and
   * whether a call would carry it (the variable is set, or the key that
   * sealed the stored one is); source null when it needs none.
   */
  credential: { source: "stored" | "environment" | null; env: string | null; set: boolean };
  /** Whether its server answered a request for its tools just now, and why not when it did not. */
  answers: boolean;
  failure: ConnectionFailure | null;
  /** The tools offered to agents, after this check. */
  offered: string[];
  /** Tools offered as ones that read whose server does not mark them read-only: offered so on the administrator's judgment alone. */
  offered_without_read_only_marking: string[];
  /** Offered tools granted to write, each with whether its calls wait for an administrator. */
  granted_to_write: Array<{ name: string; held: boolean }>;
  /** Tools an administrator picked that are withdrawn, each with why. */
  withdrawn: Array<{ name: string; reason: WithdrawnReason }>;
}

/**
 * Check every connection that is on, as the start of a run would: ask each
 * server for its tools and hold every pick to the definition it was made
 * on. A tool found changed is withdrawn by this check, as it would be by
 * the next run. Not called by anything in this change: the preflight
 * (src/preflight.ts, a separate change) is meant to call it. It checks the
 * connections its caller reads, like every read here: a check of every
 * label's connections is a caller that reads every label, and what it then
 * reports names connections, so who is shown the report is for that caller
 * to settle.
 */
export async function checkConnections(): Promise<ConnectionCheck[]> {
  const rows = await rawQuery<ConnectionRow>(`${CONNECTION_SELECT} WHERE c.enabled ORDER BY lower(c.name)`);
  const checks: ConnectionCheck[] = [];
  for (const c of rows) {
    const run = await runConnection(c, true);
    const annotations = await rawQuery<{
      name: string;
      annotations: Record<string, unknown> | null;
      writes: boolean;
      write_held: boolean;
    }>(
      `SELECT name, annotations, writes, write_held FROM connection_tools WHERE connection_id = $1 AND offered ORDER BY name`,
      [c.id]
    );
    checks.push({
      id: c.id,
      name: c.name,
      credential: (({ source, env, set }) => ({ source, env, set }))(credentialView(c)),
      answers: run.unavailable === null,
      failure: run.unavailable,
      offered: annotations.map((t) => t.name),
      offered_without_read_only_marking: annotations
        .filter((t) => !t.writes && readOnlyHint(t.annotations) !== true)
        .map((t) => t.name),
      granted_to_write: annotations.filter((t) => t.writes).map((t) => ({ name: t.name, held: t.write_held })),
      withdrawn: run.withdrawn,
    });
  }
  return checks;
}

export type { ServerToolDefinition };
