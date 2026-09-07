/**
 * Tags (#272): the graph's open topical vocabulary, and the taggings that
 * attach it to subjects.
 *
 * This module owns everything mechanical about tags so the agents and the
 * routes stay thin: slugs, embeddings, semantic search over the vocabulary,
 * the near-duplicate guard, writing a subject's taggings by source, merging
 * two tags, and the claim-row queue state (`claims.tagged_at`) the tagging
 * drain reads. Judgment — WHICH tags a claim carries — belongs to the tagger
 * (src/llm/agents/tagger.ts) and, later, to any administrator that records
 * one; code applies it.
 *
 * Three rules keep the vocabulary usable as it grows:
 *
 *  1. Identity is the slug. Two proposals that slugify the same are the same
 *     tag, whatever their casing or spacing.
 *  2. Meaning is checked before minting. A proposed tag whose embedding sits
 *     within TAG_DEDUP_SIMILARITY of an active tag reuses that tag; the
 *     tagger is told to search first, and this is the backstop for when it
 *     does not.
 *  3. Merges keep history. A merged tag stays readable (its slug still
 *     resolves, via `merged_into`) and its taggings move to the survivor.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { claims, tags, taggings, TAG_SUBJECT_KINDS, type TagSubjectKind } from "../db/schema.js";
import { generateEmbedding } from "./embedding-service.js";

/**
 * Cosine similarity above which a proposed tag is the same topic as an
 * existing one. Tag texts are short, so their embeddings sit closer together
 * than claims' do: "Vaccine safety" vs "Safety of vaccines" scores ~0.95,
 * while "Vaccine safety" vs "Vaccine efficacy" scores ~0.85. The guard is
 * only for the near-identical case; the tagger's own search covers the rest.
 */
export const TAG_DEDUP_SIMILARITY = 0.92;

/** Tag search floor: retrieval for the tagger's judgment, so low. */
export const TAG_SEARCH_MIN_SIMILARITY = 0.3;

/** Bounds on a tag name; the tagger's prompt repeats them. */
export const TAG_NAME_MAX_CHARS = 60;
export const TAG_DESCRIPTION_MAX_CHARS = 400;

export interface TagRef {
  id: string;
  slug: string;
  name: string;
}

export interface TagRecord extends TagRef {
  description: string;
  status: string;
  merged_into: string | null;
  created_by: string;
  created_at: string;
}

export interface TagSearchHit extends TagRef {
  description: string;
  similarity: number;
  claim_count: number;
}

export interface SubjectTag extends TagRef {
  description: string;
  source: string;
  confidence: number | null;
  reasoning: string | null;
}

/** A tag to attach, by existing id or by a name to find-or-create. */
export interface TagAssignment {
  tagId?: string;
  name?: string;
  description?: string;
  confidence?: number | null;
  reasoning?: string | null;
}

export function isTagSubjectKind(kind: string): kind is TagSubjectKind {
  return (TAG_SUBJECT_KINDS as readonly string[]).includes(kind);
}

/**
 * The slug is the identity: lowercase ASCII letters and digits, hyphenated,
 * diacritics folded, at most 80 characters. Empty when nothing survives.
 */
export function slugifyTag(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/** Normalize a proposed name: collapse whitespace, trim, cap the length. */
export function normalizeTagName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, TAG_NAME_MAX_CHARS).trim();
}

export function normalizeTagDescription(description: string | undefined | null): string {
  return (description ?? "").replace(/\s+/g, " ").trim().slice(0, TAG_DESCRIPTION_MAX_CHARS);
}

/** What gets embedded for a tag: the name and its delimiting description. */
export function tagEmbeddingText(name: string, description: string): string {
  return description ? `${name}: ${description}` : name;
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function tagRecord(row: {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  merged_into?: string | null;
  mergedInto?: string | null;
  created_by?: string;
  createdBy?: string;
  created_at?: Date | string;
  createdAt?: Date | string;
}): TagRecord {
  const created = row.created_at ?? row.createdAt ?? new Date(0);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    merged_into: row.merged_into ?? row.mergedInto ?? null,
    created_by: row.created_by ?? row.createdBy ?? "system",
    created_at: created instanceof Date ? created.toISOString() : String(created),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTagById(id: string): Promise<TagRecord | null> {
  const db = getDb();
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  return row ? tagRecord(row) : null;
}

/**
 * Resolve a slug to its tag, following a merge to the survivor so an old
 * link or filter keeps working after the vocabulary is tidied.
 */
export async function resolveTagBySlug(slug: string): Promise<TagRecord | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(tags)
    .where(eq(tags.slug, slugifyTag(slug)))
    .limit(1);
  if (!row) return null;
  if (row.status === "merged" && row.mergedInto) {
    // One hop is enough: mergeTags rewrites chains so a survivor is never
    // itself merged.
    const [target] = await db.select().from(tags).where(eq(tags.id, row.mergedInto)).limit(1);
    if (target) return tagRecord(target);
  }
  return tagRecord(row);
}

/**
 * The vocabulary with usage: active tags and how many active claims carry
 * each, most-used first. `q` narrows by name or slug substring.
 */
export async function listTags(opts: {
  limit?: number;
  q?: string;
  includeUnused?: boolean;
} = {}): Promise<Array<TagRecord & { claim_count: number }>> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const params: unknown[] = [];
  let where = "t.status = 'active'";
  if (opts.q && opts.q.trim()) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    where += ` AND (lower(t.name) LIKE $${params.length} OR t.slug LIKE $${params.length})`;
  }
  params.push(limit);
  const rows = await rawQuery<{
    id: string;
    slug: string;
    name: string;
    description: string;
    status: string;
    merged_into: string | null;
    created_by: string;
    created_at: Date;
    claim_count: number;
  }>(
    `SELECT * FROM (
       SELECT t.id, t.slug, t.name, t.description, t.status, t.merged_into,
              t.created_by, t.created_at,
              (SELECT count(*)::int FROM taggings tg
                 JOIN claims c ON c.id = tg.subject_id
                WHERE tg.tag_id = t.id AND tg.subject_kind = 'claim'
                  AND c.state = 'active' AND c.merged_into IS NULL) AS claim_count
         FROM tags t
        WHERE ${where}
     ) counted
     ${opts.includeUnused ? "" : "WHERE claim_count > 0"}
     ORDER BY claim_count DESC, name ASC
     LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ ...tagRecord(r), claim_count: r.claim_count }));
}

/**
 * Semantic search over the active vocabulary: the tagger's `search_tags`
 * tool and the /tags?q= route both go through here. Retrieval, not a
 * decision: a low floor, ranked by similarity, each hit with its usage so
 * the caller can prefer an established tag over a stray one.
 */
export async function searchTags(
  query: string,
  opts: { limit?: number; minSimilarity?: number; embedding?: number[] } = {}
): Promise<TagSearchHit[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const minSimilarity = opts.minSimilarity ?? TAG_SEARCH_MIN_SIMILARITY;
  const embedding = opts.embedding ?? (await generateEmbedding(query));
  return searchTagsByEmbedding(embedding, { limit, minSimilarity, query });
}

async function searchTagsByEmbedding(
  embedding: number[],
  opts: { limit: number; minSimilarity: number; query?: string }
): Promise<TagSearchHit[]> {
  // The lexical branch keeps a tag whose name literally contains the query
  // in the results even when the embedding disagrees ("LHC" vs "Large
  // Hadron Collider" can embed apart).
  const params: unknown[] = [toVectorLiteral(embedding), opts.minSimilarity, opts.limit];
  let lexical = "";
  if (opts.query && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`);
    lexical = ` OR lower(t.name) LIKE $${params.length} OR t.slug LIKE $${params.length}`;
  }
  const rows = await rawQuery<{
    id: string;
    slug: string;
    name: string;
    description: string;
    similarity: number | null;
    claim_count: number;
  }>(
    `SELECT t.id, t.slug, t.name, t.description,
            1 - (t.embedding <=> $1::vector) AS similarity,
            (SELECT count(*)::int FROM taggings tg
               JOIN claims c ON c.id = tg.subject_id
              WHERE tg.tag_id = t.id AND tg.subject_kind = 'claim'
                AND c.state = 'active' AND c.merged_into IS NULL) AS claim_count
       FROM tags t
      WHERE t.status = 'active'
        AND ((t.embedding IS NOT NULL AND 1 - (t.embedding <=> $1::vector) > $2)${lexical})
      ORDER BY similarity DESC NULLS LAST, claim_count DESC
      LIMIT $3`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    similarity: r.similarity ?? 0,
    claim_count: r.claim_count,
  }));
}

/** The tags on one subject, with the provenance of each tagging. */
export async function getTagsForSubject(
  kind: TagSubjectKind,
  subjectId: string
): Promise<SubjectTag[]> {
  const map = await getTagsForSubjects(kind, [subjectId]);
  return map.get(subjectId) ?? [];
}

/**
 * The tags on many subjects in one query, for list surfaces. Merged tags
 * are read through to their survivor so a list never shows a retired name.
 */
export async function getTagsForSubjects(
  kind: TagSubjectKind,
  subjectIds: string[]
): Promise<Map<string, SubjectTag[]>> {
  const out = new Map<string, SubjectTag[]>();
  if (subjectIds.length === 0) return out;
  const rows = await rawQuery<{
    subject_id: string;
    id: string;
    slug: string;
    name: string;
    description: string;
    source: string;
    confidence: number | null;
    reasoning: string | null;
  }>(
    `SELECT tg.subject_id,
            COALESCE(m.id, t.id) AS id,
            COALESCE(m.slug, t.slug) AS slug,
            COALESCE(m.name, t.name) AS name,
            COALESCE(m.description, t.description) AS description,
            tg.source, tg.confidence, tg.reasoning
       FROM taggings tg
       JOIN tags t ON t.id = tg.tag_id
       LEFT JOIN tags m ON m.id = t.merged_into AND t.status = 'merged'
      WHERE tg.subject_kind = $1 AND tg.subject_id = ANY($2::uuid[])
      ORDER BY tg.confidence DESC NULLS LAST, tg.created_at ASC`,
    [kind, subjectIds]
  );
  for (const r of rows) {
    const list = out.get(r.subject_id) ?? [];
    // A merge can leave the same survivor twice on one subject; keep the
    // first (highest-confidence) occurrence.
    if (list.some((t) => t.id === r.id)) continue;
    list.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      source: r.source,
      confidence: r.confidence,
      reasoning: r.reasoning,
    });
    out.set(r.subject_id, list);
  }
  return out;
}

/**
 * Decorate a list of claim rows with their tags (slug + name only: what a
 * card or a search hit shows). One query for the whole page. Tags are
 * navigation on top of a result, never the result: a failure here logs and
 * yields empty tag lists rather than taking the search down.
 */
export async function attachClaimTags<T extends { id: string }>(
  rows: T[]
): Promise<Array<T & { tags: TagRef[] }>> {
  let byClaim = new Map<string, SubjectTag[]>();
  try {
    byClaim = await getTagsForSubjects(
      "claim",
      rows.map((r) => r.id)
    );
  } catch (err) {
    console.error(
      `[tags] decorating ${rows.length} claim(s) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return rows.map((r) => ({
    ...r,
    tags: (byClaim.get(r.id) ?? []).map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface FindOrCreateTagResult {
  tag: TagRecord;
  /** created | slug | semantic — how the proposal resolved. */
  resolution: "created" | "slug" | "semantic";
  /** For `semantic`: the similarity to the tag it resolved to. */
  similarity?: number;
}

/**
 * Resolve a proposed tag to a row: by slug first, then by meaning (the
 * dedup guard), and only then by minting. The description of an existing
 * tag is left alone — the first author's delimitation stands until an
 * operator or a merge rewrites it.
 */
export async function findOrCreateTag(input: {
  name: string;
  description?: string | null;
  createdBy: string;
  /** Skip the semantic guard (operators renaming deliberately). */
  skipSemanticDedup?: boolean;
}): Promise<FindOrCreateTagResult> {
  const name = normalizeTagName(input.name);
  const slug = slugifyTag(name);
  if (!slug) throw new Error(`Tag name "${input.name}" has no slug-able characters`);
  const description = normalizeTagDescription(input.description);
  const db = getDb();

  const [bySlug] = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1);
  if (bySlug) {
    const resolved = await resolveTagBySlug(slug);
    return { tag: resolved ?? tagRecord(bySlug), resolution: "slug" };
  }

  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(tagEmbeddingText(name, description));
  } catch (err) {
    // A tag without an embedding is still a tag; it just cannot be found by
    // meaning until re-embedded (scripts/tags.ts reembed).
    console.warn(
      `[tags] embedding failed for "${name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (embedding && !input.skipSemanticDedup) {
    const [nearest] = await searchTagsByEmbedding(embedding, {
      limit: 1,
      minSimilarity: TAG_DEDUP_SIMILARITY,
    });
    if (nearest) {
      const existing = await getTagById(nearest.id);
      if (existing) {
        return { tag: existing, resolution: "semantic", similarity: nearest.similarity };
      }
    }
  }

  // Race: two taggers minting the same slug at once. ON CONFLICT resolves
  // it to one row; the loser re-reads.
  const inserted = await db
    .insert(tags)
    .values({ slug, name, description, embedding, createdBy: input.createdBy })
    .onConflictDoNothing({ target: tags.slug })
    .returning();
  if (inserted.length > 0) {
    return { tag: tagRecord(inserted[0]!), resolution: "created" };
  }
  const [row] = await db.select().from(tags).where(eq(tags.slug, slug)).limit(1);
  if (!row) throw new Error(`tag "${slug}" vanished between insert and read`);
  return { tag: tagRecord(row), resolution: "slug" };
}

export interface SetSubjectTagsResult {
  attached: TagRef[];
  /** How each named proposal resolved, for the caller's log line. */
  resolutions: Array<{ name: string; slug: string; resolution: FindOrCreateTagResult["resolution"] }>;
  removed: number;
}

/**
 * Write a subject's taggings from one `source`, replacing that source's
 * previous rows and leaving every other source's rows alone. The tagger
 * re-running on a claim therefore refreshes its own view without erasing a
 * Steward's or an operator's, and a tag both attached is kept once (the
 * unique index), attributed to whichever wrote it first.
 */
export async function setSubjectTags(input: {
  kind: TagSubjectKind;
  subjectId: string;
  source: string;
  assignments: TagAssignment[];
  runId?: string | null;
}): Promise<SetSubjectTagsResult> {
  const db = getDb();
  const resolved: Array<{ tag: TagRecord; a: TagAssignment }> = [];
  const resolutions: SetSubjectTagsResult["resolutions"] = [];
  for (const a of input.assignments) {
    if (a.tagId) {
      const tag = await getTagById(a.tagId);
      if (!tag) continue;
      // A merged tag proposed by id resolves to its survivor.
      const live = tag.status === "merged" && tag.merged_into
        ? (await getTagById(tag.merged_into)) ?? tag
        : tag;
      resolved.push({ tag: live, a });
      continue;
    }
    if (a.name && normalizeTagName(a.name)) {
      const r = await findOrCreateTag({
        name: a.name,
        description: a.description,
        createdBy: input.source,
      });
      resolved.push({ tag: r.tag, a });
      resolutions.push({ name: a.name, slug: r.tag.slug, resolution: r.resolution });
    }
  }

  // Dedupe by tag id, keeping the highest confidence.
  const byId = new Map<string, { tag: TagRecord; a: TagAssignment }>();
  for (const r of resolved) {
    const prev = byId.get(r.tag.id);
    if (!prev || (r.a.confidence ?? 0) > (prev.a.confidence ?? 0)) byId.set(r.tag.id, r);
  }
  const keep = [...byId.values()];
  const keepIds = keep.map((k) => k.tag.id);

  const removed = await db
    .delete(taggings)
    .where(
      and(
        eq(taggings.subjectKind, input.kind),
        eq(taggings.subjectId, input.subjectId),
        eq(taggings.source, input.source),
        keepIds.length > 0 ? sql`${taggings.tagId} <> ALL(${keepIds}::uuid[])` : sql`true`
      )
    )
    .returning({ id: taggings.id });

  if (keep.length > 0) {
    await db
      .insert(taggings)
      .values(
        keep.map(({ tag, a }) => ({
          tagId: tag.id,
          subjectKind: input.kind,
          subjectId: input.subjectId,
          source: input.source,
          confidence: a.confidence ?? null,
          reasoning: a.reasoning ?? null,
          runId: input.runId ?? null,
        }))
      )
      .onConflictDoNothing();
  }

  return {
    attached: keep.map(({ tag }) => ({ id: tag.id, slug: tag.slug, name: tag.name })),
    resolutions,
    removed: removed.length,
  };
}

/** Remove one tag from one subject, whoever attached it. */
export async function removeSubjectTag(
  kind: TagSubjectKind,
  subjectId: string,
  tagId: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(taggings)
    .where(
      and(
        eq(taggings.subjectKind, kind),
        eq(taggings.subjectId, subjectId),
        eq(taggings.tagId, tagId)
      )
    )
    .returning({ id: taggings.id });
  return rows.length > 0;
}

/**
 * Merge `loserId` into `winnerId`: the loser's taggings move to the winner
 * (a subject carrying both keeps the winner's row), the loser is marked
 * merged and points at the winner, and anything previously merged into the
 * loser is re-pointed so chains stay one hop long.
 */
export async function mergeTags(input: {
  loserId: string;
  winnerId: string;
}): Promise<{ moved: number; dropped: number }> {
  if (input.loserId === input.winnerId) throw new Error("a tag cannot merge into itself");
  const db = getDb();
  const [winner] = await db.select().from(tags).where(eq(tags.id, input.winnerId)).limit(1);
  const [loser] = await db.select().from(tags).where(eq(tags.id, input.loserId)).limit(1);
  if (!winner) throw new Error(`winner tag ${input.winnerId} not found`);
  if (!loser) throw new Error(`loser tag ${input.loserId} not found`);
  if (winner.status === "merged") {
    throw new Error(`winner tag ${winner.slug} is itself merged; merge into its survivor`);
  }

  // Move what can move; drop what would collide with a row the winner
  // already has on that subject.
  const moved = await rawQuery<{ id: string }>(
    `UPDATE taggings tg
        SET tag_id = $2
      WHERE tg.tag_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM taggings w
           WHERE w.tag_id = $2
             AND w.subject_kind = tg.subject_kind
             AND w.subject_id = tg.subject_id)
      RETURNING tg.id`,
    [input.loserId, input.winnerId]
  );
  const dropped = await db
    .delete(taggings)
    .where(eq(taggings.tagId, input.loserId))
    .returning({ id: taggings.id });

  await db
    .update(tags)
    .set({ status: "merged", mergedInto: input.winnerId, updatedAt: new Date() })
    .where(eq(tags.id, input.loserId));
  await db
    .update(tags)
    .set({ mergedInto: input.winnerId, updatedAt: new Date() })
    .where(and(eq(tags.mergedInto, input.loserId), eq(tags.status, "merged")));

  return { moved: moved.length, dropped: dropped.length };
}

/** Rename or re-describe a tag and refresh its embedding. */
export async function updateTag(
  tagId: string,
  patch: { name?: string; description?: string }
): Promise<TagRecord | null> {
  const db = getDb();
  const existing = await getTagById(tagId);
  if (!existing) return null;
  const name = patch.name !== undefined ? normalizeTagName(patch.name) : existing.name;
  const description =
    patch.description !== undefined
      ? normalizeTagDescription(patch.description)
      : existing.description;
  const slug = patch.name !== undefined ? slugifyTag(name) : existing.slug;
  if (!slug) throw new Error(`Tag name "${patch.name}" has no slug-able characters`);
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(tagEmbeddingText(name, description));
  } catch {
    // keep the old vector
  }
  const [row] = await db
    .update(tags)
    .set({
      name,
      slug,
      description,
      ...(embedding ? { embedding } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tags.id, tagId))
    .returning();
  return row ? tagRecord(row) : null;
}

// ---------------------------------------------------------------------------
// The claim-row queue
// ---------------------------------------------------------------------------

/** Mark a claim as read by the tagger (or as deliberately left untagged). */
export async function markClaimTagged(claimId: string): Promise<void> {
  const db = getDb();
  await db
    .update(claims)
    .set({ taggedAt: new Date(), taggingLeasedAt: null, taggingAttempts: 0 })
    .where(eq(claims.id, claimId));
}

/**
 * Return claims to the tagging queue: after a canonical-form change (the
 * proposition may have moved), or on an operator's re-tag. Does not touch
 * existing taggings — the next tagger pass replaces its own.
 */
export async function resetClaimTagging(claimIds: string[]): Promise<number> {
  if (claimIds.length === 0) return 0;
  const db = getDb();
  const rows = await db
    .update(claims)
    .set({ taggedAt: null, taggingLeasedAt: null, taggingAttempts: 0 })
    .where(inArray(claims.id, claimIds))
    .returning({ id: claims.id });
  return rows.length;
}

/** Queue depth for /queue and the scheduler's log line. */
export async function taggingQueueHealth(): Promise<{
  pending: number;
  parked: number;
  tagged: number;
}> {
  const [row] = await rawQuery<{ pending: number; parked: number; tagged: number }>(
    `SELECT
       count(*) FILTER (WHERE tagged_at IS NULL AND tagging_attempts < $1)::int AS pending,
       count(*) FILTER (WHERE tagged_at IS NULL AND tagging_attempts >= $1)::int AS parked,
       count(*) FILTER (WHERE tagged_at IS NOT NULL)::int AS tagged
       FROM claims
      WHERE state = 'active' AND merged_into IS NULL AND embedding IS NOT NULL`,
    [MAX_TAGGING_ATTEMPTS]
  );
  return row ?? { pending: 0, parked: 0, tagged: 0 };
}

/** Genuine failures before a claim parks out of the tagging drain. */
export const MAX_TAGGING_ATTEMPTS = 3;
