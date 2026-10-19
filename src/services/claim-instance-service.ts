/**
 * The instances a claim carries, and the Steward's control over them.
 *
 * A claim is a canonical proposition with no home source: every instance is
 * one source's voice on it, and none has precedence for having been recorded
 * first. This module is the one place that decides which instances belong
 * to a claim for display and judgment, and in what order they are read.
 *
 * Membership. An instance whose `detached_at` is set no longer belongs to
 * the claim: its Steward judged that the source does not assert, deny or
 * pose the proposition. The row is kept, because provenance edges, readings
 * and the reading log reference it, but every read that shows or weighs a
 * claim's instances filters it out (ACTIVE_INSTANCE_SQL).
 *
 * Order. The Steward's explicit order first (`display_rank`, 1 upward), then
 * the provenance story's order (origins first, by depth, then divergence,
 * then how many sources rest on the source), then the date of the statement.
 * Insertion order never decides anything a reader sees: it would put
 * whichever source happened to be ingested first at the top.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import {
  getProvenanceStory,
  type ProvenanceStory,
  type StoryNode,
  type StoryStanding,
} from "./provenance-story-service.js";
import type { InstanceReadingView, QuoteCheckResult } from "./source-map-service.js";

/** The SQL predicate for an instance that belongs to its claim, for a given table alias. */
export function activeInstanceSql(alias = "ci"): string {
  return `${alias}.detached_at IS NULL`;
}

export class ClaimInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimInstanceError";
  }
}

/** Default and ceiling for one page of get_claim_instances. */
export const DEFAULT_INSTANCE_PAGE = 20;
export const MAX_INSTANCE_PAGE = 100;

/** The fields ordering reads; every row the module orders carries them. */
export interface OrderableInstance {
  id: string;
  source_id: string;
  display_rank: number | null;
  /** When the source made the statement, as the instance records it (partial ISO-8601). */
  source_date: string | null;
  /** The document's publication date, the fallback when the instance has no date. */
  source_published_date?: string | null;
  detached_at?: string | Date | null;
}

const STANDING_RANK: Record<StoryStanding, number> = { origin: 0, untraced: 1, derived: 2 };

/**
 * Order instances: the Steward's ranks first (ascending), then the story's
 * structure for the instance's source, then the statement's date (earliest
 * first, undated last), then id for a stable result. Detached instances, when
 * a caller includes them, come after every instance that belongs. Pure, so
 * the rule is testable without a database.
 */
export function orderClaimInstances<T extends OrderableInstance>(
  rows: readonly T[],
  story: Pick<ProvenanceStory, "nodes"> | null
): T[] {
  const nodeBySource = new Map<string, StoryNode>();
  for (const n of story?.nodes ?? []) nodeBySource.set(n.source.id, n);
  const dateOf = (r: T): string | null => r.source_date?.trim() || r.source_published_date?.trim() || null;
  const detached = (r: T): number => (r.detached_at ? 1 : 0);
  const rank = (r: T): number => (r.display_rank == null ? Infinity : r.display_rank);
  const depth = (n: StoryNode | undefined): number => (n ? (n.depth ?? Infinity) : Infinity);
  const standing = (n: StoryNode | undefined): number => (n ? STANDING_RANK[n.standing] : 3);

  return [...rows].sort((a, b) => {
    const na = nodeBySource.get(a.source_id);
    const nb = nodeBySource.get(b.source_id);
    const da = dateOf(a);
    const db = dateOf(b);
    return (
      detached(a) - detached(b) ||
      rank(a) - rank(b) ||
      depth(na) - depth(nb) ||
      standing(na) - standing(nb) ||
      Number(nb?.diverges ?? false) - Number(na?.diverges ?? false) ||
      (nb?.downstream_total ?? 0) - (na?.downstream_total ?? 0) ||
      (da === db ? 0 : da === null ? 1 : db === null ? -1 : da < db ? -1 : 1) ||
      a.id.localeCompare(b.id)
    );
  });
}

interface InstanceRow extends OrderableInstance {
  verbatim_text: string;
  context: string | null;
  stance: string;
  confidence: number;
  speaker: string | null;
  publication: string | null;
  link: string | null;
  created_by: string;
  created_at: Date;
  detached_at: Date | null;
  detached_reason: string | null;
  detached_by: string | null;
  source_title: string;
  source_url: string | null;
  source_type: string;
  source_published_date: string | null;
}

async function loadInstanceRows(claimId: string, includeDetached: boolean): Promise<InstanceRow[]> {
  return rawQuery<InstanceRow>(
    `SELECT ci.id, ci.source_id, ci.verbatim_text, ci.context, ci.stance, ci.confidence,
            ci.speaker, ci.publication, ci.source_date, ci.link, ci.created_by, ci.created_at,
            ci.display_rank, ci.detached_at, ci.detached_reason, ci.detached_by,
            s.title AS source_title, s.url AS source_url, s.source_type,
            s.published_date AS source_published_date
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE ci.claim_id = $1${includeDetached ? "" : ` AND ${activeInstanceSql()}`}`,
    [claimId]
  );
}

/** How many instances the claim carries: detached ones never count. */
export async function countClaimInstances(claimId: string): Promise<number> {
  const [row] = await rawQuery<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM claim_instances ci WHERE ci.claim_id = $1 AND ${activeInstanceSql()}`,
    [claimId]
  );
  return Number(row?.n ?? 0);
}

/**
 * The claim's instances in reading order, for the claim page, the public
 * API and the MCP read: the rows that belong, no paging, no readings. The
 * shape matches what those surfaces have always served, plus the rank.
 */
export async function listOrderedClaimInstances(claimId: string): Promise<
  Array<{
    id: string;
    source_id: string;
    verbatim_text: string;
    context: string | null;
    stance: string;
    confidence: number;
    speaker: string | null;
    publication: string | null;
    source_date: string | null;
    link: string | null;
    source_title: string;
    source_url: string | null;
    source_type: string;
    display_rank: number | null;
  }>
> {
  const [rows, story] = await Promise.all([
    loadInstanceRows(claimId, false),
    getProvenanceStory(claimId).catch(() => null),
  ]);
  return orderClaimInstances(rows, story).map((r) => ({
    id: r.id,
    source_id: r.source_id,
    verbatim_text: r.verbatim_text,
    context: r.context,
    stance: r.stance,
    confidence: r.confidence,
    speaker: r.speaker,
    publication: r.publication,
    source_date: r.source_date,
    link: r.link,
    source_title: r.source_title,
    source_url: r.source_url,
    source_type: r.source_type,
    display_rank: r.display_rank,
  }));
}

export interface ClaimInstancePage {
  claim_id: string;
  /** Instances matching the request (detached ones only when asked for). */
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  instances: Array<Record<string, unknown>>;
}

/**
 * One page of a claim's instances for the governance roles: each with its
 * attribution, the reading recorded from opening its source, what it was
 * recorded as drawing on, and where its source sits in the provenance story.
 */
export async function getClaimInstancePage(
  claimId: string,
  opts: { limit?: number; offset?: number; includeDetached?: boolean } = {}
): Promise<ClaimInstancePage | { error: string }> {
  const [claim] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1`, [claimId]);
  if (!claim) return { error: `Claim not found: ${claimId}` };
  const limitRaw = Number(opts.limit);
  const offsetRaw = Number(opts.offset);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_INSTANCE_PAGE) : DEFAULT_INSTANCE_PAGE;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const [rows, story] = await Promise.all([
    loadInstanceRows(claimId, opts.includeDetached === true),
    getProvenanceStory(claimId).catch(() => null),
  ]);
  const ordered = orderClaimInstances(rows, story);
  const page = ordered.slice(offset, offset + limit);
  const ids = page.map((r) => r.id);
  const nodeBySource = new Map((story?.nodes ?? []).map((n) => [n.source.id, n] as const));

  const [readingRows, edgeRows] = ids.length
    ? await Promise.all([
        rawQuery<{
          instance_id: string;
          support: string;
          deployment: string | null;
          note: string | null;
          quote_check: QuoteCheckResult;
          worth_reading: boolean;
          worth_reading_reason: string | null;
          source_read: boolean;
          updated_at: Date;
        }>(
          `SELECT instance_id, support, deployment, note, quote_check, worth_reading,
                  worth_reading_reason, source_read, updated_at
             FROM claim_instance_readings WHERE instance_id = ANY($1::uuid[])`,
          [ids]
        ),
        rawQuery<{
          from_instance_id: string;
          to_source_id: string;
          title: string;
          url: string | null;
          relation_type: string;
          fidelity: string;
        }>(
          `SELECT e.from_instance_id, e.to_source_id, s.title, s.url, e.relation_type, e.fidelity
             FROM claim_provenance_edges e JOIN sources s ON s.id = e.to_source_id
            WHERE e.from_instance_id = ANY($1::uuid[])
            ORDER BY e.created_at`,
          [ids]
        ),
      ])
    : [[], []];
  const readings = new Map<string, InstanceReadingView>();
  for (const r of readingRows) {
    readings.set(r.instance_id, {
      support: r.support,
      deployment: r.deployment,
      note: r.note,
      quote_check: r.quote_check,
      worth_reading: r.worth_reading,
      worth_reading_reason: r.worth_reading_reason,
      source_read: r.source_read,
      read_at: new Date(r.updated_at).toISOString(),
    });
  }

  return {
    claim_id: claimId,
    total: ordered.length,
    limit,
    offset,
    has_more: offset + page.length < ordered.length,
    instances: page.map((r) => {
      const node = nodeBySource.get(r.source_id);
      return {
        id: r.id,
        source_id: r.source_id,
        verbatim_text: r.verbatim_text,
        context: r.context,
        stance: r.stance,
        confidence: r.confidence,
        // Attribution (#278/#281), null where unrecorded.
        speaker: r.speaker,
        publication: r.publication,
        source_date: r.source_date,
        link: r.link,
        source_title: r.source_title,
        source_type: r.source_type,
        source_url: r.source_url,
        source_published_date: r.source_published_date,
        recorded_by: r.created_by,
        display_rank: r.display_rank,
        reading: readings.get(r.id) ?? null,
        draws_on: edgeRows
          .filter((e) => e.from_instance_id === r.id)
          .map((e) => ({
            source_id: e.to_source_id,
            source_title: e.title,
            source_url: e.url,
            relation_type: e.relation_type,
            fidelity: e.fidelity,
          })),
        // Where this instance's source sits in the claim's provenance story
        // (#507): structure, never weight. Null for a detached instance,
        // whose source the story no longer holds through it.
        story: node
          ? {
              standing: node.standing,
              basis: node.basis,
              depth: node.depth,
              diverges: node.diverges,
              downstream_total: node.downstream_total,
            }
          : null,
        ...(r.detached_at
          ? {
              detached: {
                at: new Date(r.detached_at).toISOString(),
                reason: r.detached_reason,
                by: r.detached_by,
              },
            }
          : {}),
      };
    }),
  };
}

interface InstanceOfClaim {
  id: string;
  detached_at: Date | null;
  display_rank: number | null;
  stance: string;
  source_url: string | null;
  source_title: string;
}

async function instanceOf(claimId: string, instanceId: string): Promise<InstanceOfClaim> {
  const [row] = await rawQuery<InstanceOfClaim>(
    `SELECT ci.id, ci.detached_at, ci.display_rank, ci.stance, s.url AS source_url, s.title AS source_title
       FROM claim_instances ci JOIN sources s ON s.id = ci.source_id
      WHERE ci.id = $1 AND ci.claim_id = $2`,
    [instanceId, claimId]
  );
  if (!row) {
    throw new ClaimInstanceError(
      `Instance not found: ${instanceId} is not a recorded instance of claim ${claimId}.`
    );
  }
  return row;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Detach an instance from its claim: the source does not assert, deny or pose
 * the proposition. The row stays for the provenance record; its rank is
 * cleared, and the reason goes to the claim's audit trail.
 */
export async function detachClaimInstance(input: {
  claimId: string;
  instanceId: string;
  reason: string;
  detachedBy: string;
}): Promise<{ instance_id: string; already_detached: boolean; remaining: number }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ClaimInstanceError(
      "reason is required: say what you read that shows the source does not assert, deny or pose the claim."
    );
  }
  if (!UUID_RE.test(input.instanceId)) {
    throw new ClaimInstanceError(`instance_id must be a UUID; got "${input.instanceId}".`);
  }
  const existing = await instanceOf(input.claimId, input.instanceId);
  if (existing.detached_at) {
    return { instance_id: existing.id, already_detached: true, remaining: await countClaimInstances(input.claimId) };
  }
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE claim_instances
          SET detached_at = now(), detached_reason = $2, detached_by = $3, display_rank = NULL
        WHERE id = $1`,
      [existing.id, reason, input.detachedBy]
    );
    await tx.query(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, $2, $3, $4)`,
      [
        input.claimId,
        "detached_claim_instance",
        `Instance ${existing.id} (${existing.source_url ?? existing.source_title}, stance=${existing.stance}) ` +
          `detached from the claim. ${reason}`,
        input.detachedBy,
      ]
    );
  });
  return { instance_id: existing.id, already_detached: false, remaining: await countClaimInstances(input.claimId) };
}

/** Reattach a detached instance: it belongs to the claim again, at the default position. */
export async function reattachClaimInstance(input: {
  claimId: string;
  instanceId: string;
  reason: string;
  reattachedBy: string;
}): Promise<{ instance_id: string; was_detached: boolean; total: number }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ClaimInstanceError("reason is required: say why the instance belongs to the claim after all.");
  }
  if (!UUID_RE.test(input.instanceId)) {
    throw new ClaimInstanceError(`instance_id must be a UUID; got "${input.instanceId}".`);
  }
  const existing = await instanceOf(input.claimId, input.instanceId);
  if (!existing.detached_at) {
    return { instance_id: existing.id, was_detached: false, total: await countClaimInstances(input.claimId) };
  }
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE claim_instances
          SET detached_at = NULL, detached_reason = NULL, detached_by = NULL
        WHERE id = $1`,
      [existing.id]
    );
    await tx.query(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, $2, $3, $4)`,
      [
        input.claimId,
        "reattached_claim_instance",
        `Instance ${existing.id} (${existing.source_url ?? existing.source_title}) reattached to the claim. ${reason}`,
        input.reattachedBy,
      ]
    );
  });
  return { instance_id: existing.id, was_detached: true, total: await countClaimInstances(input.claimId) };
}

/**
 * Set the order a reader sees the claim's instances in: the listed ids get
 * ranks 1..n in the order given, and every other instance of the claim has
 * its rank cleared, so it follows in the default order. An empty list
 * clears every rank. Only instances that belong to the claim can be ranked.
 */
export async function setInstanceOrder(input: {
  claimId: string;
  instanceIds: unknown;
  setBy: string;
  reasoning?: string | null;
}): Promise<{ ranked: string[]; cleared: number }> {
  if (!Array.isArray(input.instanceIds)) {
    throw new ClaimInstanceError("instance_ids must be an array of instance ids, first to be shown first.");
  }
  const ids = input.instanceIds.map((v) => String(v).trim());
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) throw new ClaimInstanceError(`Not instance ids: ${bad.join(", ")}.`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new ClaimInstanceError(`Each instance may appear once; repeated: ${[...new Set(dupes)].join(", ")}.`);
  }
  const owned = await rawQuery<{ id: string; detached_at: Date | null }>(
    `SELECT id, detached_at FROM claim_instances WHERE claim_id = $1 AND id = ANY($2::uuid[])`,
    [input.claimId, ids]
  );
  const ownedById = new Map(owned.map((r) => [r.id, r] as const));
  const foreign = ids.filter((id) => !ownedById.has(id));
  if (foreign.length > 0) {
    throw new ClaimInstanceError(
      `Not recorded instances of claim ${input.claimId}: ${foreign.join(", ")}. Take ids from get_claim_instances.`
    );
  }
  const detached = ids.filter((id) => ownedById.get(id)!.detached_at);
  if (detached.length > 0) {
    throw new ClaimInstanceError(
      `Detached instances cannot be ordered: ${detached.join(", ")}. Reattach one first if it belongs to the claim.`
    );
  }

  const cleared = await withTransaction(async (tx) => {
    const clearedRows = await tx.query<{ id: string }>(
      `UPDATE claim_instances SET display_rank = NULL
        WHERE claim_id = $1 AND display_rank IS NOT NULL AND NOT (id = ANY($2::uuid[]))
        RETURNING id`,
      [input.claimId, ids]
    );
    for (let i = 0; i < ids.length; i++) {
      await tx.query(`UPDATE claim_instances SET display_rank = $2 WHERE id = $1`, [ids[i], i + 1]);
    }
    await tx.query(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, $2, $3, $4)`,
      [
        input.claimId,
        "set_instance_order",
        (ids.length > 0 ? `Instances ranked first, in order: ${ids.join(", ")}.` : "Instance ranks cleared.") +
          (input.reasoning?.trim() ? ` ${input.reasoning.trim()}` : ""),
        input.setBy,
      ]
    );
    return clearedRows.length;
  });
  return { ranked: ids, cleared };
}
