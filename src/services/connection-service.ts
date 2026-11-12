/**
 * Connections as an administrator keeps them, and as a run is offered them
 * (src/connections.ts; the tables are in db/schema.ts).
 *
 * The administrator's side: add a connection, change it, look at the tools
 * its server lists, and pick which of them agents are offered. Every change
 * to what agents may read writes a row to administrative_events in the same
 * transaction, as a label or a party does (permission-service.ts).
 *
 * The run's side: connectionsOfferedAt answers which connections a run at a
 * label has, with the tools it is offered from each. It asks each server
 * for its tools as they are now and offers a tool only where the server's
 * definition is still the one an administrator picked. A tool that differs
 * is withdrawn then and there, and stays withdrawn until an administrator
 * looks again: the pick was a person's judgment of one definition, and
 * nothing here may extend it to another.
 *
 * Nothing in this file reads a credential. It stores the name of the
 * environment variable that holds one and reports whether that variable is
 * set (connection-client.ts).
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import {
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
  CONNECTION_TRANSPORTS,
  type ServerToolDefinition,
} from "../connections.js";
import {
  credentialPresent,
  listServerTools,
  type ConnectionFailure,
  type ConnectionTarget,
} from "./connection-client.js";
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
  credential_header: string;
  party_id: string;
  party_name: string;
  party_is_own: boolean;
  stake: string;
  sensitivity_label: string;
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
  calls: number;
  readings_kept: number;
}

const CONNECTION_SELECT = `
  SELECT c.id, c.name, c.tool_prefix, c.transport, c.url, c.credential_env, c.credential_header,
         c.party_id, p.name AS party_name, p.is_own_organization AS party_is_own, c.stake,
         c.sensitivity_label, c.calls_per_minute, c.timeout_seconds, c.enabled,
         c.last_checked_at, c.last_answered_at, c.last_error, c.last_error_at, c.created_at, c.updated_at
    FROM connections c
    JOIN parties p ON p.id = c.party_id`;

const TOOL_SELECT = `
  SELECT t.connection_id, t.name, t.description, t.input_schema, t.annotations, t.definition_hash,
         t.listed, t.seen_at, t.offered, t.offered_at, t.withdrawn_at, t.withdrawn_reason,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name) AS calls,
         (SELECT count(*)::int FROM connection_calls k
           WHERE k.connection_id = t.connection_id AND k.tool = t.name AND k.source_id IS NOT NULL) AS readings_kept
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
  /** The server itself marks the tool as one that changes things, so it cannot be picked. */
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
  calls: number;
  readings_kept: number;
}

export interface ConnectionView {
  id: string;
  name: string;
  tool_prefix: string;
  transport: string;
  url: string;
  credential: {
    /** The name of the environment variable that holds the credential; null when the server asks for none. */
    env: string | null;
    header: string;
    /** Whether that variable is set where the deployment runs. Never its value. */
    set: boolean;
  };
  party: { id: string; name: string; is_own_organization: boolean };
  stake: string;
  label: string;
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
    calls: t.calls,
    readings_kept: t.readings_kept,
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
    credential: {
      env: c.credential_env,
      header: c.credential_header,
      set: credentialPresent(c.credential_env),
    },
    party: { id: c.party_id, name: c.party_name, is_own_organization: c.party_is_own },
    stake: c.stake,
    label: c.sensitivity_label,
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

/** Every connection with its tools, by name. */
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

function targetOf(c: Pick<ConnectionRow, "transport" | "url" | "credential_env" | "credential_header" | "timeout_seconds">): ConnectionTarget {
  return {
    transport: c.transport,
    url: c.url,
    credentialEnv: c.credential_env,
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
  | "INVALID_CREDENTIAL_HEADER"
  | "INVALID_STAKE"
  | "INVALID_RATE"
  | "INVALID_TIMEOUT"
  | "UNKNOWN_PARTY"
  | "UNKNOWN_LABEL"
  | "NAME_TAKEN"
  | "TOOL_PREFIX_TAKEN"
  | "NOT_FOUND"
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
      "A connection's address must not carry a user name or password. The credential stays in the " +
      "environment: name the variable that holds it in credential_env."
    );
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password|auth|credential/i.test(key)) {
      return (
        `A connection's address must not carry a credential, and its query has "${key}". The ` +
        `credential stays in the environment: name the variable that holds it in credential_env.`
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
  stake?: string;
  callsPerMinute?: number | null;
  timeoutSeconds?: number;
  enabled?: boolean;
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
    const stake = input.stake.trim();
    if (!stake || stake.length > CONNECTION_STAKE_MAX_CHARS) {
      return refuse(
        "INVALID_STAKE",
        `A connection needs the stake of the party whose system it is, in a sentence or two (at most ` +
          `${CONNECTION_STAKE_MAX_CHARS} characters): what that party stands to gain or lose from what the system ` +
          `shows. It is recorded on every reading kept from the connection, as a fact about the source.`
      );
    }
    out.stake = stake;
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
  input: ConnectionSettings & { name: string; url: string; partyId: string; label: string; stake: string },
  actorId: string
): Promise<{ ok: true; id: string } | Refusal> {
  const cleaned = cleanSettings(input);
  if (!cleaned.ok) return cleaned;
  const s = cleaned.value;
  s.toolPrefix ??= toolPrefixFromName(s.name!);
  if (!isToolPrefix(s.toolPrefix)) {
    return refuse("INVALID_TOOL_PREFIX", "No tool prefix could be made from the name; give one in tool_prefix.");
  }
  try {
    return await withTransaction(async (tx) => {
      const problem = await partyAndLabelProblem(tx, s);
      if (problem) return problem;
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO connections
           (name, tool_prefix, transport, url, credential_env, credential_header, party_id, stake,
            sensitivity_label, calls_per_minute, timeout_seconds, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          s.name,
          s.toolPrefix,
          s.transport ?? "streamable_http",
          s.url,
          s.credentialEnv ?? null,
          s.credentialHeader ?? "Authorization",
          s.partyId,
          s.stake,
          s.label,
          s.callsPerMinute ?? null,
          s.timeoutSeconds ?? CONNECTION_TIMEOUT_SECONDS.default,
          s.enabled ?? true,
          actorId,
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

/** The settings a change may touch, as the route names them, with the column each is. */
const SETTING_COLUMNS: Array<[keyof ConnectionSettings, string, string]> = [
  ["name", "name", "name"],
  ["toolPrefix", "tool_prefix", "tool_prefix"],
  ["transport", "transport", "transport"],
  ["url", "url", "url"],
  ["credentialEnv", "credential_env", "credential_env"],
  ["credentialHeader", "credential_header", "credential_header"],
  ["partyId", "party_id", "party_id"],
  ["label", "sensitivity_label", "label"],
  ["stake", "stake", "stake"],
  ["callsPerMinute", "calls_per_minute", "calls_per_minute"],
  ["timeoutSeconds", "timeout_seconds", "timeout_seconds"],
  ["enabled", "enabled", "enabled"],
];

/**
 * Change a connection's settings. The log entry names which settings
 * changed, and for the two that decide who reads and who holds the gate,
 * the label and the party, what they were before. A new address or
 * transport is a different server as far as anyone can tell, so every tool
 * that was offered is withdrawn until an administrator looks at what the
 * new address lists. Readings already kept are not touched: they carry the
 * label and party the connection had when they were read.
 */
export async function changeConnection(
  id: string,
  input: ConnectionSettings,
  actorId: string
): Promise<{ ok: true; id: string; withdrawn: string[] } | Refusal> {
  if (!UUID_RE.test(id)) return refuse("NOT_FOUND", "Connection not found");
  const cleaned = cleanSettings(input);
  if (!cleaned.ok) return cleaned;
  const s = cleaned.value;
  try {
    return await withTransaction(async (tx) => {
      const [before] = await tx.query<Record<string, unknown>>(`SELECT * FROM connections WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) return refuse("NOT_FOUND", "Connection not found");
      const problem = await partyAndLabelProblem(tx, s);
      if (problem) return problem;

      const sets: string[] = [];
      const params: unknown[] = [id];
      const changed: string[] = [];
      for (const [key, column, routeName] of SETTING_COLUMNS) {
        const value = s[key];
        if (value === undefined || value === before[column]) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
        changed.push(routeName);
      }
      if (changed.length === 0) return refuse("NOTHING_TO_CHANGE", "Nothing in the request differs from the connection as it is.");
      await tx.query(`UPDATE connections SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);

      const moved = changed.includes("url") || changed.includes("transport");
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
        ...(changed.includes("label")
          ? { label: s.label!, previous_label: before.sensitivity_label as string }
          : {}),
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
      return { ok: true as const, id, withdrawn };
    });
  } catch (err) {
    const taken = takenRefusal(err, s);
    if (taken) return taken;
    throw err;
  }
}

// ---- the connection's state -------------------------------------------------

/** Record that the connection's server answered just now. */
export async function noteConnectionAnswered(id: string): Promise<void> {
  await rawQuery(`UPDATE connections SET last_checked_at = now(), last_answered_at = now() WHERE id = $1`, [id]);
}

/** Record that the connection's server could not be read just now, and why. */
export async function noteConnectionFailed(id: string, failure: ConnectionFailure): Promise<void> {
  await rawQuery(
    `UPDATE connections SET last_checked_at = now(), last_error = $2, last_error_at = now() WHERE id = $1`,
    [id, failure.message]
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

  const listed = await listServerTools(targetOf(row));
  if (!listed.ok) {
    await noteConnectionFailed(id, listed.failure);
    return { ok: true, answered: false, failure: listed.failure };
  }
  await noteConnectionAnswered(id);

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
        `INSERT INTO connection_tools (connection_id, name, description, input_schema, annotations, definition_hash, listed, seen_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, true, now())
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
  | "NAME_NOT_OFFERABLE"
  | "SCHEMA_NOT_OFFERABLE";

/**
 * Set which of a connection's tools agents are offered: the whole set, each
 * tool named with the hash of the definition the administrator looked at.
 * A pick is refused when the tool stored is not that definition (it changed
 * between looking and picking), when the server no longer lists it, when
 * the server itself marks it as writing, or when its name or its schema
 * could not be given to a model. Either every pick in the request stands or
 * none does.
 */
export async function offerTools(
  id: string,
  picks: ReadonlyArray<{ name: string; definitionHash: string }>,
  actorId: string
): Promise<
  | { ok: true; offered: string[]; noLongerOffered: string[] }
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
    }>(
      `SELECT name, definition_hash, listed, offered, annotations, input_schema
         FROM connection_tools WHERE connection_id = $1 FOR UPDATE`,
      [id]
    );
    const byName = new Map(stored.map((t) => [t.name, t]));
    const wanted = new Map(picks.map((p) => [p.name, p.definitionHash]));
    for (const [name, hash] of wanted) {
      const tool = byName.get(name);
      if (!tool) {
        return no("UNKNOWN_TOOL", `The connection has no tool named "${name}" on record. Look at the connection again to see what its server lists.`);
      }
      if (!tool.listed) {
        return no("TOOL_NOT_LISTED", `The server no longer listed "${name}" when the connection was last looked at, so it cannot be offered.`);
      }
      if (tool.definition_hash !== hash) {
        return no(
          "TOOL_CHANGED",
          `"${name}" is not the definition this pick was made on: it has changed since. Read the connection again and pick the tool as it now is.`
        );
      }
      if (markedAsWriting(tool.annotations)) {
        return no(
          "MARKED_AS_WRITING",
          `The server itself marks "${name}" as a tool that changes things, so it is not offered to agents. A connection is for reading.`
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
    }

    const offered: string[] = [];
    const noLongerOffered: string[] = [];
    for (const tool of stored) {
      const pick = wanted.has(tool.name);
      if (pick && !tool.offered) offered.push(tool.name);
      if (!pick && tool.offered) noLongerOffered.push(tool.name);
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
    return { ok: true as const, offered: offered.sort(), noLongerOffered: noLongerOffered.sort() };
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
}

/** A connection as a run has it. */
export interface RunConnection {
  id: string;
  name: string;
  toolPrefix: string;
  partyId: string;
  partyName: string;
  stake: string;
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
}

/**
 * The connections a run working at `label` has, with the tools it is
 * offered from each: every connection that is on, whose label that label
 * reads, and that has a tool an administrator picked. Each server is asked
 * for its tools as they are now. A picked tool is offered only where the
 * server's definition still has the hash the pick was made on; one that
 * differs or is gone is withdrawn here, for this run and every later one,
 * until an administrator looks again.
 *
 * A connection with a withdrawn tool and none offered is still returned, so
 * the run can be told the reading it might have made is not available and
 * why.
 */
export async function connectionsOfferedAt(label: string): Promise<RunConnection[]> {
  const readable = await labelsReadableFrom([label]);
  const rows = await rawQuery<ConnectionRow>(
    `${CONNECTION_SELECT}
      WHERE c.enabled AND c.sensitivity_label = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM connection_tools t
                     WHERE t.connection_id = c.id AND (t.offered OR t.withdrawn_at IS NOT NULL))
      ORDER BY lower(c.name)`,
    [readable]
  );
  return Promise.all(rows.map((c) => runConnection(c)));
}

/**
 * One connection as a run has it. With `askAnyway`, the server is asked for
 * its tools even when none is offered, for a check that wants to know
 * whether it answers.
 */
async function runConnection(c: ConnectionRow, askAnyway = false): Promise<RunConnection> {
  const target = targetOf(c);
  const picked = await rawQuery<{
    name: string;
    description: string;
    input_schema: unknown;
    definition_hash: string;
    offered: boolean;
    withdrawn_reason: string | null;
  }>(
    `SELECT name, description, input_schema, definition_hash, offered, withdrawn_reason
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
  };
  const offered = picked.filter((t) => t.offered);
  if (offered.length === 0 && !askAnyway) return out;

  const listed = await listServerTools({
    ...target,
    timeoutSeconds: Math.min(target.timeoutSeconds, RUN_START_LIST_TIMEOUT_SECONDS),
  });
  if (!listed.ok) {
    await noteConnectionFailed(c.id, listed.failure);
    out.unavailable = listed.failure;
    return out;
  }
  await noteConnectionAnswered(c.id);

  const liveHash = new Map<string, string>();
  for (const tool of listed.tools) {
    if (!liveHash.has(tool.name)) liveHash.set(tool.name, toolDefinitionHash(tool));
  }
  for (const tool of offered) {
    const now = liveHash.get(tool.name);
    if (now === tool.definition_hash) {
      out.tools.push({
        name: tool.name,
        offeredAs: offeredToolName(c.tool_prefix, tool.name),
        description: tool.description,
        inputSchema: tool.input_schema,
      });
      continue;
    }
    const reason: WithdrawnReason = now === undefined ? "missing" : "changed";
    // No person made this change, so the log entry has no actor.
    await withTransaction((tx) => withdrawTool(tx, c.id, tool.name, reason, null));
    out.withdrawn.push({ name: tool.name, reason });
  }
  out.withdrawn.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---- the calls an administrator sees ---------------------------------------

export interface ConnectionCallView {
  /** The reading's id, as the agent that made the call was given it. */
  id: string;
  tool: string;
  called_at: string;
  duration_ms: number | null;
  /** in_flight | answered | tool_error | failed */
  outcome: string;
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
  /** The call's arguments, for a reader cleared for the call's label; absent otherwise. */
  arguments?: unknown;
  arguments_withheld?: true;
}

/**
 * A connection's calls, newest first, without their results. The arguments
 * are what an agent wrote at the call's label, so they are shown only to a
 * reader whose clearance covers that label: administering a deployment does
 * not by that alone let a person read what its agents wrote. What the
 * system answered is never in this list. A kept reading is read as the
 * source it became.
 */
export async function listConnectionCalls(
  id: string,
  opts: { limit?: number; before?: string; keptOnly?: boolean },
  clearance: readonly string[]
): Promise<ConnectionCallView[] | null> {
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
    `SELECT id, tool, called_at, duration_ms, outcome, error, result_chars, result_hash, run_id, agent,
            claim_id, source_id, kept_at, arguments, sensitivity_label
       FROM connection_calls
      WHERE connection_id = $1
        AND ($2::timestamptz IS NULL OR called_at < $2::timestamptz)
        AND (NOT $3::boolean OR source_id IS NOT NULL)
      ORDER BY called_at DESC, id DESC
      LIMIT $4`,
    [id, before, opts.keptOnly === true, limit]
  );
  const cleared = new Set(clearance);
  return rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    called_at: iso(r.called_at)!,
    duration_ms: r.duration_ms,
    outcome: r.outcome ?? "in_flight",
    error: r.outcome === "failed" ? r.error : null,
    result_chars: r.result_chars,
    result_sha256: r.result_hash,
    run_id: r.run_id,
    agent: r.agent,
    claim_id: r.claim_id,
    source_id: r.source_id,
    kept_at: iso(r.kept_at),
    ...(cleared.has(r.sensitivity_label) ? { arguments: r.arguments } : { arguments_withheld: true as const }),
  }));
}

// ---- for the preflight ------------------------------------------------------

/** What the preflight needs to know of one connection (docs/connections.md, "What the preflight should check"). */
export interface ConnectionCheck {
  id: string;
  name: string;
  /** The variable its credential is in, and whether it is set; env null when it needs none. */
  credential: { env: string | null; set: boolean };
  /** Whether its server answered a request for its tools just now, and why not when it did not. */
  answers: boolean;
  failure: ConnectionFailure | null;
  /** The tools offered to agents, after this check. */
  offered: string[];
  /** Offered tools whose server does not mark them read-only: offered on the administrator's judgment alone. */
  offered_without_read_only_marking: string[];
  /** Tools an administrator picked that are withdrawn, each with why. */
  withdrawn: Array<{ name: string; reason: WithdrawnReason }>;
}

/**
 * Check every connection that is on, as the start of a run would: ask each
 * server for its tools and hold every pick to the definition it was made
 * on. A tool found changed is withdrawn by this check, as it would be by
 * the next run. Not called by anything in this change: the preflight
 * (src/preflight.ts, a separate change) is meant to call it.
 */
export async function checkConnections(): Promise<ConnectionCheck[]> {
  const rows = await rawQuery<ConnectionRow>(`${CONNECTION_SELECT} WHERE c.enabled ORDER BY lower(c.name)`);
  const checks: ConnectionCheck[] = [];
  for (const c of rows) {
    const run = await runConnection(c, true);
    const annotations = await rawQuery<{ name: string; annotations: Record<string, unknown> | null }>(
      `SELECT name, annotations FROM connection_tools WHERE connection_id = $1 AND offered ORDER BY name`,
      [c.id]
    );
    checks.push({
      id: c.id,
      name: c.name,
      credential: { env: c.credential_env, set: credentialPresent(c.credential_env) },
      answers: run.unavailable === null,
      failure: run.unavailable,
      offered: annotations.map((t) => t.name),
      offered_without_read_only_marking: annotations
        .filter((t) => readOnlyHint(t.annotations) !== true)
        .map((t) => t.name),
      withdrawn: run.withdrawn,
    });
  }
  return checks;
}

export type { ServerToolDefinition };
