/**
 * Readings: what an agent read through a connection, and the source one
 * becomes when work rests on it (src/connections.ts).
 *
 * A reading is one call to one of a connection's tools and what came back.
 * Every call is recorded here as it is made (connection_calls): the tool,
 * the arguments, the time, and the result stored whole with its SHA-256,
 * whatever window of it the agent was shown. So what was read does not move
 * when the data does, and a reading kept an hour later is the reading as it
 * was made.
 *
 * A call is not a source. Agents probe: they list tables, try a query,
 * narrow it. Sources are what assessments rest on, so the agent says which
 * readings those are: keepReading turns one call into a source row that a
 * judgment can cite like any other.
 *
 * A call, and the source kept from it, carry the label of the run that made
 * the call (currentLabel, the first stamping rule in src/labels.ts). What
 * came back is the connection's material, but the arguments are the run's
 * own words, and the two are stored together: a run at a label that reads
 * more than the connection's label would otherwise write what it composed
 * down to readers who were never cleared for what that run knows. The run's
 * label always reads the connection's, or the run would not have the tool,
 * so nothing of the connection's is put where it may not be read. A run at
 * another label that needs the same data makes its own reading, and a
 * reading is kept by work at the label it was made at: the source it becomes
 * is a row at that label, and a row is added and changed only by work at its
 * own label (db/clearance.ts).
 *
 * What a run learns about the connection itself while it reads (that the
 * server answered, that it could not be reached) is the same whoever asks,
 * so it is written on the connection's row at the connection's label
 * (noteConnectionAnswered and noteConnectionFailed in connection-service.ts,
 * the second stamping rule).
 *
 * Whose material it is does not depend on who asked: the source belongs to
 * the connection's party, and where the connection's administrator gave
 * that party's stake, it is recorded on it (source_interests), as a fact
 * about it and never a finding against it. Where none was given, none is
 * recorded: an interest that bears on one claim is the Steward's to record
 * for that claim (§9).
 *
 * The one limit on calls is a rate an administrator may set on a
 * connection. There is no count of calls per run: a run is bounded by its
 * budget, and a connection's calls cost the organization's system and no
 * owls, so the thing to protect is that system, across all runs at once.
 * The agent is told the rate in its brief, where it stands in every result,
 * and when the next call can go in a refusal (llm/tools/connection-tools.ts).
 *
 * A tool an administrator priced is the exception to "no owls": a call to
 * it that the system answers is charged to the run's budget at that price,
 * like any paid tool (usage-service.ts, meterExternalUsage), and the price
 * and the charge are kept on the call.
 *
 * A call to a tool granted to write is marked as one (`writes`), which is
 * what an administrator's list of writes reads. Where the grant says such
 * calls are held, the call is recorded and not sent: it waits for an
 * administrator, who approves it (it is then sent, once, by
 * decideHeldCall) or declines it. The agent is not kept waiting. It is
 * told the call is held and reads what became of it with open_reading.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { CONNECTION_RESULT_MAX_CHARS, readingAddress } from "../connections.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import { canonicalContent } from "./run-log.js";
import { callServerTool, type ConnectionFailure, type ConnectionTarget } from "./connection-client.js";
import {
  connectionForHeldCall,
  noteConnectionAnswered,
  noteConnectionFailed,
  type OfferedTool,
  type RunConnection,
} from "./connection-service.js";
import { meterExternalUsage, type UsageOnBehalfOf } from "./usage-service.js";
import { windowText, type TextWindow } from "./document-text.js";
import { labelsReadableFrom } from "./permission-service.js";
import { sourceContentHash } from "./source-content.js";
import { segmentSourceOnce } from "./source-segment-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who records the party's stake on a kept reading: the connection, mechanically, not an agent. */
export const READING_INTEREST_RECORDED_BY = "connection";

/** Where a connection stands against the rate its administrator set. */
export interface RateState {
  perMinute: number;
  /** Calls made through the connection in the last minute, by every run, this one included. */
  inLastMinute: number;
}

export type ReadingMade =
  | {
      made: true;
      id: string;
      calledAt: string;
      /** The system answered with an error of its own; `text` is what it said. */
      systemError: boolean;
      text: string;
      sha256: string;
      rate: RateState | null;
      /** What the call was charged to the run's budget; 0 for a tool with no price. */
      chargedMicroUsd: number;
    }
  | {
      made: false;
      /**
       * `rate`: not sent, the connection is at its rate. `held`: recorded
       * and not sent, waiting for an administrator. `failed`: sent, and no
       * usable answer came.
       */
      why: "rate";
      rate: RateState;
      /** When the oldest call of the last minute leaves it, so the next can go. */
      nextAt: string;
    }
  | { made: false; why: "held"; id: string; heldAt: string; rate: RateState | null }
  | { made: false; why: "failed"; id: string; failure: ConnectionFailure | { kind: "too_large"; message: string } };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * How many calls were made through a connection in the last minute, by
 * every run at every label, and when the oldest of them was made.
 *
 * This is the service counting, not a run reading: the rate protects the
 * organization's system from all runs together, so a call made at a label
 * the calling run cannot read counts as much as one it can. The database
 * holds a run's own queries to its clearance (db/clearance.ts), so this one
 * runs with the system's, on the owner's connection, or the run would count
 * only the calls it may read and the rate would be per label. It returns a
 * number and a time and no row's content. The run is told the number, as
 * "all runs together", which is what its brief said the rate counts.
 *
 * It is called while the caller's transaction holds the connection's lock,
 * and it reads on another connection: every earlier holder of the lock
 * committed its call before letting go, so the count is of all of them.
 */
const RATE_COUNT_REASON =
  "A connection's rate protects the organization's system from every run together, so the count of calls in the last minute is of calls at every label.";

async function callsInLastMinute(connectionId: string): Promise<{ n: number; oldest: Date | null }> {
  const [recent] = await withSystemClearance(RATE_COUNT_REASON, () =>
    rawQuery<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(called_at) AS oldest
         FROM connection_calls
        WHERE connection_id = $1 AND called_at > now() - interval '60 seconds'`,
      [connectionId]
    )
  );
  return { n: recent?.n ?? 0, oldest: recent?.oldest ?? null };
}

/**
 * Record a call that is about to be sent, or refuse it when the connection
 * is at its rate. Where a rate is set, the count and the insert happen
 * under one lock for the connection, so two runs calling at the same moment
 * cannot both take the last place.
 */
async function beginCall(
  connection: RunConnection,
  tool: OfferedTool,
  args: Record<string, unknown>
): Promise<
  | { ok: true; id: string; calledAt: Date; rate: RateState | null }
  | { ok: false; rate: RateState; nextAt: Date }
> {
  const context = getUsageContext();
  const held = tool.writes?.held === true;
  const insert = [
    connection.id,
    tool.name,
    JSON.stringify(args),
    context.runId ?? null,
    context.agent ?? null,
    context.claimId ?? null,
    connection.partyId,
    // The run's label, not the connection's: the arguments are the run's words.
    currentLabel(),
    tool.writes !== null,
    tool.priceMicroUsd,
    // A held call is not sent now. It keeps the definition its arguments
    // were written against, and who pays for it when it is sent.
    held,
    held ? tool.definitionHash : null,
    held && tool.priceMicroUsd > 0
      ? JSON.stringify({ userId: context.userId ?? null, apiKeyId: context.apiKeyId ?? null, jobId: context.jobId ?? null })
      : null,
  ];
  const INSERT = `INSERT INTO connection_calls
       (connection_id, tool, arguments, run_id, agent, claim_id, party_id, sensitivity_label,
        writes, price_micro_usd, outcome, held_at, tool_definition_hash, charge_to)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $11::boolean THEN 'held' END, CASE WHEN $11::boolean THEN now() END, $12, $13::jsonb)
     RETURNING id, called_at`;
  const perMinute = connection.callsPerMinute;
  if (perMinute === null) {
    const [row] = await rawQuery<{ id: string; called_at: Date }>(INSERT, insert);
    return { ok: true, id: row!.id, calledAt: row!.called_at, rate: null };
  }
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('minerval:connection:' || $1::text))`, [connection.id]);
    const recent = await callsInLastMinute(connection.id);
    const n = recent.n;
    if (n >= perMinute) {
      const oldest = recent.oldest ? new Date(recent.oldest).getTime() : Date.now();
      return { ok: false as const, rate: { perMinute, inLastMinute: n }, nextAt: new Date(oldest + 60_000) };
    }
    const [row] = await tx.query<{ id: string; called_at: Date }>(INSERT, insert);
    return { ok: true as const, id: row!.id, calledAt: row!.called_at, rate: { perMinute, inLastMinute: n + 1 } };
  });
}

type CallFailure = ConnectionFailure | { kind: "too_large"; message: string };

/**
 * Send a call that is already on record, once, and store what came back on
 * its row. A call the system answered, with a result or with an error of
 * its own, is charged at the price the call was recorded with: the system
 * did the work. One that could not be made is not, since nobody can say it
 * reached the system.
 */
async function sendRecordedCall(input: {
  callId: string;
  connection: { id: string; label: string; toolPrefix: string };
  target: ConnectionTarget;
  tool: string;
  args: Record<string, unknown>;
  priceMicroUsd: number;
  /** Who pays, for a call sent outside the run that made it. */
  onBehalfOf?: UsageOnBehalfOf;
}): Promise<
  | { sent: true; systemError: boolean; text: string; sha256: string; chargedMicroUsd: number }
  | { sent: false; failure: CallFailure }
> {
  const started = Date.now();
  const called = await callServerTool(input.target, input.tool, input.args);
  const durationMs = Date.now() - started;

  const fail = async (failure: CallFailure) => {
    await rawQuery(
      `UPDATE connection_calls SET outcome = 'failed', error = $2, duration_ms = $3 WHERE id = $1`,
      [input.callId, failure.message, durationMs]
    );
    return { sent: false as const, failure };
  };

  if (!called.ok) {
    await noteConnectionFailed(input.connection, called.failure, "call");
    return fail(called.failure);
  }
  await noteConnectionAnswered(input.connection);
  const charged = Math.max(0, input.priceMicroUsd);
  if (charged > 0) {
    await meterExternalUsage(
      {
        provider: "connection",
        model: `connection/${input.connection.toolPrefix}/${input.tool}`,
        units: 1,
        unitKind: "call",
        costMicroUsd: charged,
      },
      input.onBehalfOf
    );
    await rawQuery(`UPDATE connection_calls SET charged_micro_usd = $2 WHERE id = $1`, [input.callId, charged]);
  }
  if (called.text.length > CONNECTION_RESULT_MAX_CHARS) {
    return fail({
      kind: "too_large",
      message:
        `the result was ${called.text.length.toLocaleString("en-US")} characters, over the ` +
        `${CONNECTION_RESULT_MAX_CHARS.toLocaleString("en-US")} a result may be, so it was not stored or shown`,
    });
  }
  const hash = sha256(called.text);
  await rawQuery(
    `UPDATE connection_calls
        SET outcome = $2, result = $3, result_hash = $4, result_chars = $5, duration_ms = $6
      WHERE id = $1`,
    [input.callId, called.isError ? "tool_error" : "answered", called.text, hash, called.text.length, durationMs]
  );
  return { sent: true, systemError: called.isError, text: called.text, sha256: hash, chargedMicroUsd: charged };
}

/**
 * Make one reading: send the call once, and store what came back whole.
 * Never throws for anything the server or the network did; that comes back
 * as a reading that was not made, with why. A call to a tool whose calls
 * are held is recorded and not sent.
 */
export async function makeReading(
  connection: RunConnection,
  tool: OfferedTool,
  args: Record<string, unknown>
): Promise<ReadingMade> {
  const begun = await beginCall(connection, tool, args);
  if (!begun.ok) return { made: false, why: "rate", rate: begun.rate, nextAt: begun.nextAt.toISOString() };
  // A hold is not a limit on the run and bounds nothing: it puts a person's
  // attention before a write, which no budget prices. The agent was told of
  // it on the tool and in its brief before it called, and is not kept
  // waiting on it.
  if (tool.writes?.held) {
    return { made: false, why: "held", id: begun.id, heldAt: new Date(begun.calledAt).toISOString(), rate: begun.rate };
  }
  const sent = await sendRecordedCall({
    callId: begun.id,
    connection,
    target: connection.target,
    tool: tool.name,
    args,
    priceMicroUsd: tool.priceMicroUsd,
  });
  if (!sent.sent) return { made: false, why: "failed", id: begun.id, failure: sent.failure };
  return {
    made: true,
    id: begun.id,
    calledAt: new Date(begun.calledAt).toISOString(),
    systemError: sent.systemError,
    text: sent.text,
    sha256: sent.sha256,
    rate: begun.rate,
    chargedMicroUsd: sent.chargedMicroUsd,
  };
}

// ---- a held call, decided ----------------------------------------------------

export type HeldCallDecided =
  | {
      ok: true;
      id: string;
      /** declined | not_sent | answered | tool_error | failed */
      outcome: string;
      /** Why an approved call was not sent, or what failed when it was. */
      problem: string | null;
    }
  | { ok: false; code: "NOT_FOUND" | "NOT_HELD"; message: string };

/**
 * An administrator decides a call that waited for one. Declined, nothing is
 * sent and the call says so. Approved, the call is sent now, once, with the
 * arguments the agent wrote, and its row takes what came back, as any
 * call's does.
 *
 * Approval sends only what the agent was offered and the administrator can
 * still stand behind: the connection is on, and the tool is offered,
 * granted to write, and still the definition the arguments were written
 * against. Otherwise the call is marked not sent, with why: switching a
 * connection off, or revoking a grant, stops the calls that were waiting
 * as well as the ones not yet made.
 *
 * The decision is taken under a lock on the call's row and committed before
 * anything is sent, so two approvals cannot both send it.
 */
export async function decideHeldCall(
  connectionId: string,
  callId: string,
  decision: "approve" | "decline",
  note: string | null,
  actorId: string
): Promise<HeldCallDecided> {
  const notFound = { ok: false as const, code: "NOT_FOUND" as const, message: "No such call through this connection." };
  if (!UUID_RE.test(connectionId) || !UUID_RE.test(callId)) return notFound;
  const cleanNote = note?.trim() ? note.trim() : null;
  const taken = await withTransaction(async (tx) => {
    const [row] = await tx.query<{
      tool: string;
      arguments: Record<string, unknown>;
      outcome: string | null;
      held_at: Date | null;
      tool_definition_hash: string | null;
      price_micro_usd: number;
      charge_to: { userId?: string | null; apiKeyId?: string | null; jobId?: string | null } | null;
      run_id: string | null;
      agent: string | null;
      claim_id: string | null;
    }>(
      `SELECT tool, arguments, outcome, held_at, tool_definition_hash, price_micro_usd, charge_to, run_id, agent, claim_id
         FROM connection_calls WHERE id = $1 AND connection_id = $2 FOR UPDATE`,
      [callId, connectionId]
    );
    if (!row) return notFound;
    if (row.outcome !== "held") {
      return {
        ok: false as const,
        code: "NOT_HELD" as const,
        message:
          row.held_at === null
            ? "This call did not wait for an administrator: it was sent when the agent made it."
            : "This call has already been decided.",
      };
    }
    const settle = async (outcome: "declined" | "not_sent" | null, error: string | null) => {
      await tx.query(
        `UPDATE connection_calls
            SET outcome = $2, error = $3, decided_by = $4, decided_at = now(), decision_note = $5
          WHERE id = $1`,
        [callId, outcome, error, actorId, cleanNote]
      );
    };
    if (decision === "decline") {
      await settle("declined", null);
      return { ok: true as const, send: null, outcome: "declined", problem: null };
    }
    const now = await connectionForHeldCall(tx, connectionId, row.tool);
    const problem =
      now === null
        ? "the connection could not be read"
        : !now.enabled
          ? "the connection was switched off while the call waited"
          : !now.tool || !now.tool.offered || !now.tool.writes
            ? "the tool is no longer offered to agents under a write grant"
            : now.tool.definitionHash !== row.tool_definition_hash
              ? "the tool's definition changed after the agent wrote this call, so its arguments were written against another tool"
              : null;
    if (problem !== null || now === null) {
      await settle("not_sent", problem);
      return { ok: true as const, send: null, outcome: "not_sent", problem };
    }
    await settle(null, null);
    return {
      ok: true as const,
      send: {
        connection: { id: connectionId, label: now.label, toolPrefix: now.toolPrefix },
        target: now.target,
        tool: row.tool,
        args: row.arguments ?? {},
        priceMicroUsd: row.price_micro_usd,
        onBehalfOf: {
          userId: row.charge_to?.userId ?? null,
          apiKeyId: row.charge_to?.apiKeyId ?? null,
          jobId: row.charge_to?.jobId ?? null,
          claimId: row.claim_id,
          runId: row.run_id,
          agent: row.agent,
        },
      },
      outcome: "in_flight",
      problem: null,
    };
  });
  if (!taken.ok) return taken;
  if (taken.send === null) return { ok: true, id: callId, outcome: taken.outcome, problem: taken.problem };
  const sent = await sendRecordedCall({ callId, ...taken.send });
  return sent.sent
    ? { ok: true, id: callId, outcome: sent.systemError ? "tool_error" : "answered", problem: null }
    : { ok: true, id: callId, outcome: "failed", problem: sent.failure.message };
}

/** A reading no run at this label may be told of, and one that does not exist, read the same. */
export class ReadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadingError";
  }
}

const noSuchReading = (id: string) =>
  new ReadingError(
    `No reading ${id} is known to this run. A reading's id is the "reading" field of the call that made it.`
  );

/**
 * A reading the run may open and may not keep: it was made by work at
 * another label that this run's label reads. The source a kept reading
 * becomes is a row at the label the reading was made at, and this run adds
 * rows at its own.
 */
const madeByOtherWork = (id: string) =>
  new ReadingError(
    `Reading ${id} was made by other work, and a reading is kept by the work that made it. ` +
      `To rest a judgment on what it shows, make the call again in this run and keep that reading.`
  );

/** Why a call has no stored result, as the rest of a sentence about it. */
function noResultBecause(outcome: string | null, error: string | null, note: string | null): string {
  switch (outcome) {
    case "failed":
      return `was not made (${error ?? "the call failed"})`;
    case "held":
      return "is held for an administrator's approval and has not been sent yet";
    case "declined":
      return `was declined by an administrator${note ? `, who said: ${JSON.stringify(note)},` : ""} and was not sent`;
    case "not_sent":
      return `was approved and then not sent (${error ?? "it could no longer be sent"})`;
    default:
      return "has no result yet: its call is still in flight";
  }
}

/** The labels the enclosing run or request reads: its own, and those its own reads. */
async function readableLabels(): Promise<Set<string>> {
  return new Set(await labelsReadableFrom([currentLabel()]));
}

export interface OpenedReading extends TextWindow {
  reading: string;
  connection: string;
  tool: string;
  read_at: string;
  result_sha256: string;
  system_error: boolean;
}

/**
 * A window of a reading's stored result, with the paging the source reader
 * has (services/document-text.ts). It makes no call to the system: it reads
 * what was stored when the reading was made, so two windows are always of
 * the same result.
 */
export async function openReading(input: { readingId: string; offset?: number; maxChars?: number }): Promise<OpenedReading> {
  const id = input.readingId.trim();
  if (!UUID_RE.test(id)) throw noSuchReading(id);
  const [row] = await rawQuery<{
    tool: string;
    called_at: Date;
    outcome: string | null;
    error: string | null;
    result: string | null;
    result_hash: string | null;
    decision_note: string | null;
    sensitivity_label: string;
    connection_name: string;
  }>(
    `SELECT k.tool, k.called_at, k.outcome, k.error, k.result, k.result_hash, k.decision_note, k.sensitivity_label,
            c.name AS connection_name
       FROM connection_calls k JOIN connections c ON c.id = k.connection_id
      WHERE k.id = $1`,
    [id]
  );
  if (!row || !(await readableLabels()).has(row.sensitivity_label)) throw noSuchReading(id);
  if (row.result === null || row.result_hash === null) {
    throw new ReadingError(`Reading ${id} ${noResultBecause(row.outcome, row.error, row.decision_note)}, so there is no result to open.`);
  }
  return {
    reading: id,
    connection: row.connection_name,
    tool: row.tool,
    read_at: new Date(row.called_at).toISOString(),
    result_sha256: row.result_hash,
    system_error: row.outcome === "tool_error",
    ...windowText(row.result, input.offset, input.maxChars),
  };
}

/**
 * The text of the source a reading becomes: the call and its result
 * together, so that the source's hash fixes both what was asked and what
 * came back. Plain lines, then the result exactly as it was stored.
 */
export function readingDocument(input: {
  connectionName: string;
  partyName: string | null;
  tool: string;
  arguments: unknown;
  calledAt: Date;
  systemError: boolean;
  resultSha256: string;
  result: string;
}): string {
  const head = [
    `A reading through the connection "${input.connectionName}"` +
      (input.partyName ? `, a system of ${input.partyName}.` : "."),
    `Tool: ${input.tool}`,
    `Arguments: ${canonicalContent(input.arguments)}`,
    `Read: ${input.calledAt.toISOString()}`,
    ...(input.systemError ? ["The system answered with an error."] : []),
    `Result SHA-256: ${input.resultSha256}`,
  ];
  return `${head.join("\n")}\n\n${input.result}`;
}

export interface KeptReading {
  reading: string;
  source_id: string;
  /** What to cite the source by. */
  address: string;
  title: string;
  /** SHA-256 of the source's text: the call and its result together. */
  content_sha256: string;
  /** True when the reading had been kept before, and this is the source made then. */
  already_kept: boolean;
  /** Whether the connection's party's stake is recorded on the source: true where its administrator gave one. */
  stake_recorded: boolean;
}

/**
 * Keep a reading as a source: one row a judgment can cite, made from the
 * call as it was recorded. The same reading kept twice is one source. The
 * source carries the call's label, which is the label of the run that made
 * the call and of the run that keeps it, and the party the connection had
 * then, with the stake its administrator gave for that party, where one
 * was given, recorded on it at the same label.
 *
 * Its facts are marked as checked, so the worker that looks sources up at
 * Crossref and the Wayback Machine (workers/source-backfill.ts) leaves it
 * alone: a reading is not on the web, nothing outside knows anything about
 * it, and its address must not be sent out to ask.
 */
export async function keepReading(readingId: string): Promise<KeptReading> {
  const id = readingId.trim();
  if (!UUID_RE.test(id)) throw noSuchReading(id);
  const readable = await readableLabels();
  const kept = await withTransaction(async (tx) => {
    const [row] = await tx.query<{
      connection_id: string;
      tool: string;
      arguments: unknown;
      called_at: Date;
      outcome: string | null;
      error: string | null;
      result: string | null;
      result_hash: string | null;
      party_id: string | null;
      source_id: string | null;
      decision_note: string | null;
      sensitivity_label: string;
    }>(
      `SELECT connection_id, tool, arguments, called_at, outcome, error, result, result_hash, party_id,
              source_id, decision_note, sensitivity_label
         FROM connection_calls WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!row || !readable.has(row.sensitivity_label)) throw noSuchReading(id);
    if (!row.source_id && row.sensitivity_label !== currentLabel()) throw madeByOtherWork(id);
    const [connection] = await tx.query<{ name: string; tool_prefix: string; stake: string | null }>(
      `SELECT name, tool_prefix, stake FROM connections WHERE id = $1`,
      [row.connection_id]
    );
    const address = readingAddress(connection!.tool_prefix, id);
    if (row.source_id) {
      const [source] = await tx.query<{ id: string; url: string; title: string; content_hash: string; stake_recorded: boolean }>(
        `SELECT s.id, s.url, s.title, s.content_hash,
                EXISTS (SELECT 1 FROM source_interests i WHERE i.source_id = s.id AND i.recorded_by = $2) AS stake_recorded
           FROM sources s WHERE s.id = $1`,
        [row.source_id, READING_INTEREST_RECORDED_BY]
      );
      return {
        reading: id,
        source_id: source!.id,
        address: source!.url,
        title: source!.title,
        content_sha256: source!.content_hash,
        already_kept: true,
        stake_recorded: source!.stake_recorded,
      };
    }
    if (row.result === null || row.result_hash === null) {
      throw new ReadingError(
        `Reading ${id} ${noResultBecause(row.outcome, row.error, row.decision_note)}, so there is nothing to keep.` +
          (row.outcome === "failed" ? ` That the reading could not be made can be said in what you record.` : "")
      );
    }
    const [party] = row.party_id
      ? await tx.query<{ name: string }>(`SELECT name FROM parties WHERE id = $1`, [row.party_id])
      : [];
    const calledAt = new Date(row.called_at);
    const text = readingDocument({
      connectionName: connection!.name,
      partyName: party?.name ?? null,
      tool: row.tool,
      arguments: row.arguments,
      calledAt,
      systemError: row.outcome === "tool_error",
      resultSha256: row.result_hash,
      result: row.result,
    });
    const title = `${connection!.name}: ${row.tool}, read ${calledAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const contentHash = sourceContentHash(text)!;
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources
         (url, title, raw_content, content_hash, retrieved_at, page_url_hash, facts_checked_at,
          sensitivity_label, party_id)
       VALUES ($1, $2, $3, $4, $5, '', now(), $6, $7)
       RETURNING id`,
      [address, title, text, contentHash, calledAt, row.sensitivity_label, row.party_id]
    );
    // The stake, where the connection's administrator gave one. None given,
    // none is recorded: the source still belongs to the party, and its text
    // says whose system it was read from.
    const stakeRecorded = party !== undefined && connection!.stake !== null;
    if (stakeRecorded) {
      await tx.query(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id, sensitivity_label)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [
          source!.id,
          party!.name,
          connection!.stake,
          READING_INTEREST_RECORDED_BY,
          getUsageContext().runId ?? null,
          row.sensitivity_label,
        ]
      );
    }
    await tx.query(`UPDATE connection_calls SET source_id = $2, kept_at = now() WHERE id = $1`, [id, source!.id]);
    return {
      reading: id,
      source_id: source!.id,
      address,
      title,
      content_sha256: contentHash,
      already_kept: false,
      stake_recorded: stakeRecorded,
    };
  });
  // The source's passages, so an instance recorded from it is anchored like
  // any other. Never fails the keep: the document is already stored.
  if (!kept.already_kept) await segmentSourceOnce(kept.source_id);
  return kept;
}
