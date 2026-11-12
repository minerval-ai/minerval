/**
 * A source's recorded interest (§9): a stake its author or publisher has in
 * what the source says. A developer describing its own system, a company
 * reporting on its own product, the funder of a study.
 *
 * The record is a fact about the source and nothing more. It moves no
 * status, discounts nothing, and is never a finding against the source: what
 * the source says stays evidence, and each claim's Steward weighs it knowing
 * the stake (§7, §9). It exists so that the stake is noticed once and shown,
 * instead of being noticed afresh, or not, on every pass.
 *
 * Scope. A record with no claim holds for whatever the source says about
 * the party's own affairs. A record with a claim holds for that claim alone.
 * A read for a claim takes the claim's own record where there is one and the
 * source-wide one otherwise.
 *
 * History. `source_interests` is append-only. The newest row for a source
 * and scope is the current one; the older rows are kept and never changed.
 *
 * The write validates its input and throws a SourceInterestError with a
 * message written for the agent; the tool executor turns that into a
 * structured refusal (§20).
 */
import { rawQuery } from "../db/client.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";

export class SourceInterestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceInterestError";
  }
}

/**
 * The record is shown beside the source wherever the source is cited, so it
 * is kept to a name and a sentence or two. The tool's description states
 * both lengths.
 */
export const INTEREST_PARTY_MAX_CHARS = 200;
export const INTEREST_STAKE_MAX_CHARS = 1000;

/** A current interest record, as every read serves it. */
export interface SourceInterestView {
  /** Who has the stake, as a name. */
  party: string;
  /** What they stand to gain or lose. */
  stake: string;
  /** The claim the record is scoped to; null when it holds for the source as a whole. */
  claim_id: string | null;
  recorded_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string, max: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new SourceInterestError(`${field} is required.`);
  if (v.length > max) {
    throw new SourceInterestError(`${field} is too long (${v.length} characters; at most ${max}).`);
  }
  return v;
}

export interface RecordSourceInterestInput {
  sourceId: string;
  /** The claim the interest is scoped to; null or absent for the source as a whole. */
  claimId?: string | null;
  party: string;
  stake: string;
  recordedBy: string;
}

/**
 * Record a source's interest. Always a new row: an earlier record for the
 * same source and scope stays in the table as history and stops being the
 * one readers are shown.
 */
export async function recordSourceInterest(input: RecordSourceInterestInput): Promise<{
  id: string;
  source_id: string;
  claim_id: string | null;
  party: string;
  stake: string;
  recorded_at: string;
  supersedes_earlier: boolean;
}> {
  const sourceId = typeof input.sourceId === "string" ? input.sourceId.trim() : "";
  if (!UUID_RE.test(sourceId)) {
    throw new SourceInterestError(`source_id must be a uuid (got "${sourceId}").`);
  }
  const claimId = input.claimId ? String(input.claimId).trim() : null;
  if (claimId !== null && !UUID_RE.test(claimId)) {
    throw new SourceInterestError(`claim_id must be a uuid (got "${claimId}").`);
  }
  const party = text(input.party, "party", INTEREST_PARTY_MAX_CHARS);
  const stake = text(input.stake, "stake", INTEREST_STAKE_MAX_CHARS);

  const [source] = await rawQuery<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [sourceId]);
  if (!source) {
    throw new SourceInterestError(
      `No source ${sourceId} exists. Take source ids from provenance_get_map or get_claim_instances.`
    );
  }
  if (claimId !== null) {
    const [claim] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1`, [claimId]);
    if (!claim) throw new SourceInterestError(`No claim ${claimId} exists.`);
  }

  const [earlier] = await rawQuery<{ id: string }>(
    `SELECT id FROM source_interests
      WHERE source_id = $1 AND claim_id IS NOT DISTINCT FROM $2::uuid
      LIMIT 1`,
    [sourceId, claimId]
  );
  const [row] = await rawQuery<{ id: string; created_at: Date }>(
    `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [sourceId, claimId, party, stake, input.recordedBy, getUsageContext().runId ?? null, currentLabel()]
  );
  return {
    id: row!.id,
    source_id: sourceId,
    claim_id: claimId,
    party,
    stake,
    recorded_at: new Date(row!.created_at).toISOString(),
    supersedes_earlier: !!earlier,
  };
}

interface InterestRow {
  source_id: string;
  claim_id: string | null;
  party: string;
  stake: string;
  created_at: Date;
}

function view(r: InterestRow): SourceInterestView {
  return {
    party: r.party,
    stake: r.stake,
    claim_id: r.claim_id,
    recorded_at: new Date(r.created_at).toISOString(),
  };
}

/**
 * The interests currently recorded for a source: the newest record for the
 * source as a whole, when there is one, then the newest for each claim it
 * has one on. Superseded records are left out.
 */
export async function listCurrentSourceInterests(sourceId: string): Promise<SourceInterestView[]> {
  const rows = await rawQuery<InterestRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (claim_id) source_id, claim_id, party, stake, created_at
         FROM source_interests
        WHERE source_id = $1
        ORDER BY claim_id, created_at DESC, id DESC
     ) current
     ORDER BY (claim_id IS NOT NULL), created_at`,
    [sourceId]
  );
  return rows.map(view);
}

/**
 * The interest that applies to each of `sourceIds` on one claim: the claim's
 * own record where there is one, else the source-wide one. A source with
 * neither is absent from the map.
 */
export async function interestsForClaim(
  claimId: string,
  sourceIds: readonly string[]
): Promise<Map<string, SourceInterestView>> {
  const out = new Map<string, SourceInterestView>();
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return out;
  const rows = await rawQuery<InterestRow>(
    `SELECT DISTINCT ON (source_id) source_id, claim_id, party, stake, created_at
       FROM source_interests
      WHERE source_id = ANY($2::uuid[]) AND (claim_id = $1 OR claim_id IS NULL)
      ORDER BY source_id, (claim_id IS NOT NULL) DESC, created_at DESC, id DESC`,
    [claimId, ids]
  );
  for (const r of rows) out.set(r.source_id, view(r));
  return out;
}
