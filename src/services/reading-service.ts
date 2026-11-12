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
 * another label that needs the same data makes its own reading.
 *
 * Whose material it is does not depend on who asked: the source belongs to
 * the connection's party, and that party's stake is recorded on it
 * (source_interests), as a fact about it and never a finding against it.
 *
 * The one limit on calls is a rate an administrator may set on a
 * connection. There is no count of calls per run: a run is bounded by its
 * budget, and a connection's calls cost the organization's system and no
 * owls, so the thing to protect is that system, across all runs at once.
 * The agent is told the rate in its brief, where it stands in every result,
 * and when the next call can go in a refusal (llm/tools/connection-tools.ts).
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { CONNECTION_RESULT_MAX_CHARS, readingAddress } from "../connections.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import { canonicalContent } from "./run-log.js";
import { callServerTool, type ConnectionFailure } from "./connection-client.js";
import {
  noteConnectionAnswered,
  noteConnectionFailed,
  type OfferedTool,
  type RunConnection,
} from "./connection-service.js";
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
    }
  | {
      made: false;
      /** `rate`: not sent, the connection is at its rate. `failed`: sent, and no usable answer came. */
      why: "rate";
      rate: RateState;
      /** When the oldest call of the last minute leaves it, so the next can go. */
      nextAt: string;
    }
  | { made: false; why: "failed"; id: string; failure: ConnectionFailure | { kind: "too_large"; message: string } };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * How many calls were made through a connection in the last minute, by
 * every run at every label, and when the oldest of them was made.
 *
 * This is the service counting, not a run reading: the rate protects the
 * organization's system from all runs together, so a call made at a label
 * the calling run cannot read counts as much as one it can. Nothing holds a
 * read to a clearance yet. When the database does (row-level security keyed
 * to the run's clearance), this one query must run with the system's
 * clearance, or a run would count only the calls it may read and the rate
 * would be per label. It returns a number and a time and no row's content.
 */
async function callsInLastMinute(tx: TxQuery, connectionId: string): Promise<{ n: number; oldest: Date | null }> {
  const [recent] = await tx.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(called_at) AS oldest
       FROM connection_calls
      WHERE connection_id = $1 AND called_at > now() - interval '60 seconds'`,
    [connectionId]
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
  tool: string,
  args: Record<string, unknown>
): Promise<
  | { ok: true; id: string; calledAt: Date; rate: RateState | null }
  | { ok: false; rate: RateState; nextAt: Date }
> {
  const context = getUsageContext();
  const insert = [
    connection.id,
    tool,
    JSON.stringify(args),
    context.runId ?? null,
    context.agent ?? null,
    context.claimId ?? null,
    connection.partyId,
    // The run's label, not the connection's: the arguments are the run's words.
    currentLabel(),
  ];
  const INSERT = `INSERT INTO connection_calls
       (connection_id, tool, arguments, run_id, agent, claim_id, party_id, sensitivity_label)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
     RETURNING id, called_at`;
  const perMinute = connection.callsPerMinute;
  if (perMinute === null) {
    const [row] = await rawQuery<{ id: string; called_at: Date }>(INSERT, insert);
    return { ok: true, id: row!.id, calledAt: row!.called_at, rate: null };
  }
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('minerval:connection:' || $1::text))`, [connection.id]);
    const recent = await callsInLastMinute(tx, connection.id);
    const n = recent.n;
    if (n >= perMinute) {
      const oldest = recent.oldest ? new Date(recent.oldest).getTime() : Date.now();
      return { ok: false as const, rate: { perMinute, inLastMinute: n }, nextAt: new Date(oldest + 60_000) };
    }
    const [row] = await tx.query<{ id: string; called_at: Date }>(INSERT, insert);
    return { ok: true as const, id: row!.id, calledAt: row!.called_at, rate: { perMinute, inLastMinute: n + 1 } };
  });
}

/**
 * Make one reading: send the call once, and store what came back whole.
 * Never throws for anything the server or the network did; that comes back
 * as a reading that was not made, with why.
 */
export async function makeReading(
  connection: RunConnection,
  tool: OfferedTool,
  args: Record<string, unknown>
): Promise<ReadingMade> {
  const begun = await beginCall(connection, tool.name, args);
  if (!begun.ok) return { made: false, why: "rate", rate: begun.rate, nextAt: begun.nextAt.toISOString() };

  const started = Date.now();
  const called = await callServerTool(connection.target, tool.name, args);
  const durationMs = Date.now() - started;

  const fail = async (failure: ConnectionFailure | { kind: "too_large"; message: string }): Promise<ReadingMade> => {
    await rawQuery(
      `UPDATE connection_calls SET outcome = 'failed', error = $2, duration_ms = $3 WHERE id = $1`,
      [begun.id, failure.message, durationMs]
    );
    return { made: false, why: "failed", id: begun.id, failure };
  };

  if (!called.ok) {
    await noteConnectionFailed(connection.id, called.failure);
    return fail(called.failure);
  }
  await noteConnectionAnswered(connection.id);
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
    [begun.id, called.isError ? "tool_error" : "answered", called.text, hash, called.text.length, durationMs]
  );
  return {
    made: true,
    id: begun.id,
    calledAt: new Date(begun.calledAt).toISOString(),
    systemError: called.isError,
    text: called.text,
    sha256: hash,
    rate: begun.rate,
  };
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
    sensitivity_label: string;
    connection_name: string;
  }>(
    `SELECT k.tool, k.called_at, k.outcome, k.error, k.result, k.result_hash, k.sensitivity_label,
            c.name AS connection_name
       FROM connection_calls k JOIN connections c ON c.id = k.connection_id
      WHERE k.id = $1`,
    [id]
  );
  if (!row || !(await readableLabels()).has(row.sensitivity_label)) throw noSuchReading(id);
  if (row.result === null || row.result_hash === null) {
    throw new ReadingError(
      row.outcome === "failed"
        ? `Reading ${id} was not made (${row.error ?? "the call failed"}), so there is no result to open.`
        : `Reading ${id} has no result yet: its call is still in flight.`
    );
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
}

/**
 * Keep a reading as a source: one row a judgment can cite, made from the
 * call as it was recorded. The same reading kept twice is one source. The
 * source carries the call's label, which is the label of the run that made
 * the call, and the party the connection had then, with that party's stake
 * recorded on it.
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
      sensitivity_label: string;
    }>(
      `SELECT connection_id, tool, arguments, called_at, outcome, error, result, result_hash, party_id,
              source_id, sensitivity_label
         FROM connection_calls WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!row || !readable.has(row.sensitivity_label)) throw noSuchReading(id);
    const [connection] = await tx.query<{ name: string; tool_prefix: string; stake: string }>(
      `SELECT name, tool_prefix, stake FROM connections WHERE id = $1`,
      [row.connection_id]
    );
    const address = readingAddress(connection!.tool_prefix, id);
    if (row.source_id) {
      const [source] = await tx.query<{ id: string; url: string; title: string; content_hash: string }>(
        `SELECT id, url, title, content_hash FROM sources WHERE id = $1`,
        [row.source_id]
      );
      return {
        reading: id,
        source_id: source!.id,
        address: source!.url,
        title: source!.title,
        content_sha256: source!.content_hash,
        already_kept: true,
      };
    }
    if (row.result === null || row.result_hash === null) {
      throw new ReadingError(
        row.outcome === "failed"
          ? `Reading ${id} was not made (${row.error ?? "the call failed"}), so there is nothing to keep. ` +
            `That the reading could not be made can be said in what you record.`
          : `Reading ${id} has no result yet: its call is still in flight.`
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
    if (party) {
      await tx.query(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id)
         VALUES ($1, NULL, $2, $3, $4, $5)`,
        [source!.id, party.name, connection!.stake, READING_INTEREST_RECORDED_BY, getUsageContext().runId ?? null]
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
    };
  });
  // The source's passages, so an instance recorded from it is anchored like
  // any other. Never fails the keep: the document is already stored.
  if (!kept.already_kept) await segmentSourceOnce(kept.source_id);
  return kept;
}
