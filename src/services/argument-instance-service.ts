/**
 * Argument instances (#541): where a source makes, attacks or mentions an
 * argument, the argument layer's counterpart of claim_instances (§4, §7).
 *
 * An instance is provenance. It records one passage's use of the argument
 * and how well that passage states it; it never changes the argument's
 * written form or rating, and how many instances an argument has bears only
 * weakly on whether it belongs on its claim (§7). Retired arguments take
 * instances too: retiring preserves an argument's record, and a passage that
 * makes a retired argument belongs on it rather than on a duplicate.
 */
import { rawQuery } from "../db/client.js";
import type { ArgumentInstanceStance, ArgumentReading } from "../schemas/common.js";
import type { ValueShown } from "../schemas/kinds.js";

export interface ArgumentInstanceInput {
  argumentId: string;
  sourceId: string;
  verbatimText: string;
  stance: ArgumentInstanceStance;
  reading: ArgumentReading | null;
  statedShows: ValueShown | null;
  context?: string | null;
  speaker?: string | null;
  publication?: string | null;
  sourceDate?: string | null;
  link?: string | null;
  createdBy: string;
}

export interface ArgumentInstanceRow {
  id: string;
  argument_id: string;
  source_id: string;
  source_url: string | null;
  source_title: string | null;
  verbatim_text: string;
  context: string | null;
  stance: string;
  reading: string | null;
  stated_shows: ValueShown | null;
  speaker: string | null;
  publication: string | null;
  source_date: string | null;
  link: string | null;
  created_by: string;
  created_at: Date;
}

/**
 * The instance already recorded for this (argument, source, speaker), if
 * any. Speakers compare case-insensitively, and an unattributed row on
 * either side matches any voice, as for claim instances (#278, #481).
 */
export async function findArgumentInstance(input: {
  argumentId: string;
  sourceId: string;
  speaker: string | null;
}): Promise<{ id: string; stance: string; reading: string | null; speaker: string | null } | null> {
  const [row] = await rawQuery<{ id: string; stance: string; reading: string | null; speaker: string | null }>(
    `SELECT id, stance, reading, speaker
       FROM argument_instances
      WHERE argument_id = $1 AND source_id = $2
        AND ($3::text IS NULL OR speaker IS NULL OR lower(speaker) = lower($3::text))
      ORDER BY COALESCE(lower(speaker) = lower($3::text), false) DESC, created_at
      LIMIT 1`,
    [input.argumentId, input.sourceId, input.speaker]
  );
  return row ?? null;
}

export async function insertArgumentInstance(input: ArgumentInstanceInput): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO argument_instances
       (argument_id, source_id, verbatim_text, context, stance, reading, stated_shows,
        speaker, publication, source_date, link, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.argumentId,
      input.sourceId,
      input.verbatimText,
      input.context ?? null,
      input.stance,
      input.reading,
      input.statedShows === null ? null : JSON.stringify(input.statedShows),
      input.speaker ?? null,
      input.publication ?? null,
      input.sourceDate ?? null,
      input.link ?? null,
      input.createdBy,
    ]
  );
  return row!.id;
}

/** Correct an instance's stance, reading, or stated value. Returns false when no such instance is on the argument. */
export async function updateArgumentInstance(input: {
  instanceId: string;
  argumentId: string;
  stance?: ArgumentInstanceStance;
  reading?: ArgumentReading | null;
  statedShows?: ValueShown | null;
}): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE argument_instances
        SET stance = COALESCE($3, stance),
            reading = CASE WHEN $4::boolean THEN $5 ELSE reading END,
            stated_shows = CASE WHEN $6::boolean THEN $7::jsonb ELSE stated_shows END
      WHERE id = $1 AND argument_id = $2
      RETURNING id`,
    [
      input.instanceId,
      input.argumentId,
      input.stance ?? null,
      input.reading !== undefined,
      input.reading ?? null,
      input.statedShows !== undefined,
      input.statedShows == null ? null : JSON.stringify(input.statedShows),
    ]
  );
  return rows.length > 0;
}

/**
 * An argument's instances, ordered by the date the source made the
 * statement where one is known, then by when it was recorded. No order says
 * one instance has precedence over another (§4): the first source to make
 * an argument is one voice among the rest.
 */
export async function listArgumentInstances(
  argumentId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ total: number; items: ArgumentInstanceRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const [count] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM argument_instances WHERE argument_id = $1`,
    [argumentId]
  );
  const items = await rawQuery<ArgumentInstanceRow>(
    `SELECT ai.id, ai.argument_id, ai.source_id, s.url AS source_url, s.title AS source_title,
            ai.verbatim_text, ai.context, ai.stance, ai.reading, ai.stated_shows,
            ai.speaker, ai.publication, ai.source_date, ai.link, ai.created_by, ai.created_at
       FROM argument_instances ai
       JOIN sources s ON s.id = ai.source_id
      WHERE ai.argument_id = $1
      ORDER BY ai.source_date NULLS LAST, ai.created_at, ai.id
      LIMIT $2 OFFSET $3`,
    [argumentId, limit, offset]
  );
  return { total: count?.n ?? 0, items };
}

// ---------------------------------------------------------------------------
// Unplaced passages (#541): reasoning about a claim that matched none of its
// arguments at ingestion, kept on the claim (claim_id set, argument_id null)
// until its Steward places or dismisses it.
// ---------------------------------------------------------------------------

/** Who records an argument passage at ingestion. */
export const INGEST_RECORDER = "matcher";

export async function insertUnplacedPassage(input: {
  claimId: string;
  sourceId: string;
  verbatimText: string;
  context: string | null;
  stance: ArgumentInstanceStance;
  direction: "for" | "against" | null;
}): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO argument_instances
       (claim_id, source_id, verbatim_text, context, stance, direction, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [input.claimId, input.sourceId, input.verbatimText, input.context, input.stance, input.direction, INGEST_RECORDER]
  );
  return row!.id;
}

export interface UnplacedPassage {
  id: string;
  source_id: string;
  source_url: string | null;
  source_title: string | null;
  verbatim_text: string;
  context: string | null;
  stance: string;
  direction: string | null;
  recorded_at: Date;
}

/** A claim's passages waiting for its Steward: unplaced and not dismissed, oldest first. */
export async function listUnplacedPassages(claimId: string, limit = 20): Promise<{ total: number; items: UnplacedPassage[] }> {
  const [count] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM argument_instances WHERE claim_id = $1 AND dismissed_at IS NULL`,
    [claimId]
  );
  const items = await rawQuery<UnplacedPassage>(
    `SELECT ai.id, ai.source_id, s.url AS source_url, s.title AS source_title,
            ai.verbatim_text, ai.context, ai.stance, ai.direction, ai.created_at AS recorded_at
       FROM argument_instances ai
       JOIN sources s ON s.id = ai.source_id
      WHERE ai.claim_id = $1 AND ai.dismissed_at IS NULL
      ORDER BY ai.created_at, ai.id
      LIMIT $2`,
    [claimId, limit]
  );
  return { total: count?.n ?? 0, items };
}

/** The unplaced passage with this id, with the claim it waits on, or null. */
export async function getUnplacedPassage(
  instanceId: string
): Promise<{ id: string; claim_id: string; source_id: string; dismissed_at: Date | null } | null> {
  const [row] = await rawQuery<{ id: string; claim_id: string; source_id: string; dismissed_at: Date | null }>(
    `SELECT id, claim_id, source_id, dismissed_at FROM argument_instances WHERE id = $1 AND claim_id IS NOT NULL`,
    [instanceId]
  );
  return row ?? null;
}

/** Place an unplaced passage on an argument of its claim. */
export async function placePassage(input: {
  instanceId: string;
  argumentId: string;
  stance: ArgumentInstanceStance;
  reading: ArgumentReading | null;
}): Promise<void> {
  await rawQuery(
    `UPDATE argument_instances
        SET argument_id = $2, claim_id = NULL, direction = NULL, stance = $3, reading = $4,
            dismissed_at = NULL, dismissed_reason = NULL
      WHERE id = $1`,
    [input.instanceId, input.argumentId, input.stance, input.reading]
  );
}

/** Dismiss an unplaced passage with the reason; the row stays as provenance. */
export async function dismissPassage(instanceId: string, reason: string): Promise<void> {
  await rawQuery(
    `UPDATE argument_instances SET dismissed_at = now(), dismissed_reason = $2 WHERE id = $1`,
    [instanceId, reason]
  );
}
