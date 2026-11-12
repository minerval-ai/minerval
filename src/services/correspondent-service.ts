/**
 * Correspondents (#563; docs/allocation.md, "Correspondents") — agents that
 * read the graph for an audience and send it updates about what deserves
 * its attention.
 *
 * A Graph Correspondent is a mandate's, like a lookout: its Grantmaker
 * writes its brief (what it covers, who reads it, what matters to them, how
 * to present it) and its triggers, and the ledger funds it one
 * `correspondent_run` at a time from the mandate's escrow, out of its day,
 * with no count of runs. It is woken the way a lookout is:
 *   - its heartbeat (a weekly digest is 168 hours);
 *   - a material change in its scope (`graph_change`): the trigger scan
 *     queues ONE wake while none waits, and the run reads the change
 *     stream from its own cursor, so a busy scope never becomes a burst of
 *     runs; min_wake_hours spaces such runs for the audience's attention;
 *   - a poke (`manual`) from its Grantmaker or the mandate's manager.
 *
 * This module is the mechanism around it: lifecycle with its bounds, the
 * trigger queue and the change scan, the run record, and the updates it
 * publishes, with the part of every update the agent does not write: the
 * changes in its window it did not mention. It has no read of its own.
 * Everything a Correspondent reads is the graph's public reads (the graph
 * reads and the change stream), so anyone can build one outside Minerval
 * from MCP alone; such a one is not registered here and needs nothing here.
 */
import { rawQuery } from "../db/client.js";
import { resolveProvider, unresolvableModelIdMessage } from "../llm/providers/routing.js";
import {
  decodeChangeCursor,
  encodeChangeCursor,
  listGraphChanges,
  toMicroIso,
  resolveTagSlugs,
  type GraphChange,
} from "./graph-change-service.js";

/** Inputs a correspondent can wake on, beyond its heartbeat. */
export const CORRESPONDENT_TRIGGER_KINDS = [
  // A material change in its scope (services/graph-change-service.ts).
  "graph_change",
  // Its Grantmaker or the mandate's manager poked it with a note.
  "manual",
] as const;
export type CorrespondentTriggerKind = (typeof CORRESPONDENT_TRIGGER_KINDS)[number];

export const CORRESPONDENT_STATUSES = ["active", "paused", "retired"] as const;
export type CorrespondentStatus = (typeof CORRESPONDENT_STATUSES)[number];

/** Bounds the brief cannot enforce; every write clamps to these. */
export const CORRESPONDENT_BOUNDS = {
  titleChars: { min: 3, max: 200 },
  briefChars: { min: 40, max: 20_000 },
  audienceChars: { min: 3, max: 1_000 },
  /** 0 = event-only; at most monthly. */
  heartbeatHours: { min: 0, max: 24 * 30 },
  minWakeHours: { min: 0, max: 24 * 30 },
  scopeClaims: 100,
  scopeTags: 20,
  workspaceChars: 50_000,
  noteChars: 2_000,
  updateTitleChars: 200,
  updateBodyChars: 30_000,
  updateItems: 100,
  itemReasonChars: 2_000,
  unexaminedChars: 4_000,
  /** Changes a run is briefed with; past this its window ends early and the rest wait. */
  windowChanges: 500,
  /** Unmentioned changes listed by id on an update; past this only the count. */
  notCoveredListed: 200,
  /** One plan item: a sentence or two, not a document. */
  planItemChars: 500,
} as const;

export interface CorrespondentRow {
  id: string;
  grant_id: string;
  title: string;
  brief: string;
  audience: string;
  scope_claim_ids: string[];
  scope_tag_ids: string[];
  status: CorrespondentStatus;
  heartbeat_hours: number;
  triggers: CorrespondentTriggerKind[];
  min_wake_hours: number;
  model: string | null;
  changes_cursor: string | null;
  workspace: string | null;
  last_note: string | null;
  last_run_at: Date | null;
  next_due_at: Date;
  runs: number;
  updates: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The columns a correspondent is read with, named, so that a column the
 * table gains (its label, src/labels.ts) does not ride along into a run's
 * brief or a route's reply. Every read of a whole correspondent uses these.
 */
export const CORRESPONDENT_COLUMNS = [
  "id", "grant_id", "title", "brief", "audience", "scope_claim_ids", "scope_tag_ids",
  "status", "heartbeat_hours", "triggers", "min_wake_hours", "model", "changes_cursor",
  "workspace", "last_note", "last_run_at", "next_due_at", "runs", "updates",
  "created_by", "created_at", "updated_at",
] as const;

const SELECT = `
  SELECT ${CORRESPONDENT_COLUMNS.join(", ")}
    FROM correspondents`;

export type CorrespondentWriteResult =
  | { ok: true; correspondentId: string; unknownTags?: string[] }
  | { ok: false; code: string; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeTriggers(raw: unknown): CorrespondentTriggerKind[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "triggers must be a list";
  const out: CorrespondentTriggerKind[] = [];
  for (const t of raw) {
    const s = String(t).trim() as CorrespondentTriggerKind;
    if (!CORRESPONDENT_TRIGGER_KINDS.includes(s)) {
      return `unknown trigger "${s}"; known: ${CORRESPONDENT_TRIGGER_KINDS.join(", ")}`;
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Scope claims must exist and be active; tags resolve by slug. */
async function resolveScope(
  claimIds: unknown,
  tagSlugs: unknown
): Promise<{ claimIds: string[]; tagIds: string[]; unknownTags: string[] } | { problem: string }> {
  const ids = Array.isArray(claimIds) ? [...new Set(claimIds.map(String))] : [];
  if (ids.length > CORRESPONDENT_BOUNDS.scopeClaims) {
    return { problem: `At most ${CORRESPONDENT_BOUNDS.scopeClaims} scope claims` };
  }
  const bad = ids.find((id) => !isUuid(id));
  if (bad) return { problem: `scope_claim_ids: "${bad}" is not a claim id` };
  if (ids.length > 0) {
    const found = await rawQuery<{ id: string }>(
      `SELECT id FROM claims WHERE id = ANY($1::uuid[]) AND state = 'active'`,
      [ids]
    );
    const have = new Set(found.map((r) => r.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length > 0) return { problem: `No active claim with id ${missing.join(", ")}` };
  }
  const slugs = Array.isArray(tagSlugs) ? tagSlugs.map(String).filter(Boolean) : [];
  if (slugs.length > CORRESPONDENT_BOUNDS.scopeTags) {
    return { problem: `At most ${CORRESPONDENT_BOUNDS.scopeTags} scope tags` };
  }
  const { ids: tagIds, unknown } = await resolveTagSlugs(slugs);
  return { claimIds: ids, tagIds, unknownTags: unknown };
}

/** The change cursor for "from now on". */
export function cursorAt(at: Date): string {
  return encodeChangeCursor(toMicroIso(at.toISOString()), "00000000-0000-0000-0000-000000000000");
}

/**
 * Stand up a correspondent on an active mandate. Its change cursor starts
 * now: what changed before it existed is history it can read with
 * list_graph_changes, not news. With a heartbeat it is due at once, so its
 * first update says where things stand.
 */
export async function createCorrespondent(input: {
  grantId: string;
  title: string;
  brief: string;
  audience: string;
  scopeClaimIds?: unknown;
  scopeTags?: unknown;
  heartbeatHours?: number;
  minWakeHours?: number;
  triggers?: unknown;
  model?: string | null;
  createdBy: string;
}): Promise<CorrespondentWriteResult> {
  const [grant] = await rawQuery<{ id: string }>(
    `SELECT id FROM grants WHERE id = $1 AND status = 'active'`,
    [input.grantId]
  );
  if (!grant) return { ok: false, code: "MANDATE_NOT_ACTIVE", message: "Mandate not found or not active" };
  const B = CORRESPONDENT_BOUNDS;
  const title = String(input.title ?? "").trim();
  if (title.length < B.titleChars.min) return { ok: false, code: "TITLE", message: "A title of a few words is required" };
  const brief = String(input.brief ?? "").trim();
  if (brief.length < B.briefChars.min) {
    return {
      ok: false,
      code: "BRIEF",
      message:
        `The brief is the correspondent's whole instruction set: what it covers, ` +
        `what matters to its readers, how to read the graph for them, what to ` +
        `leave alone, how to present it. Write at least ${B.briefChars.min} characters.`,
    };
  }
  const audience = String(input.audience ?? "").trim();
  if (audience.length < B.audienceChars.min) {
    return { ok: false, code: "AUDIENCE", message: "Say who the updates are for" };
  }
  const triggers = normalizeTriggers(input.triggers);
  if (typeof triggers === "string") return { ok: false, code: "TRIGGERS", message: triggers };
  const scope = await resolveScope(input.scopeClaimIds, input.scopeTags);
  if ("problem" in scope) return { ok: false, code: "SCOPE", message: scope.problem };
  if (triggers.includes("graph_change") && scope.claimIds.length === 0 && scope.tagIds.length === 0) {
    return {
      ok: false,
      code: "SCOPE",
      message:
        "graph_change wakes a correspondent on changes in its scope, so it needs " +
        "scope claims or tags to watch; give some, or rely on the heartbeat.",
    };
  }
  const model = input.model?.trim() || null;
  if (model && !resolveProvider(model)) return { ok: false, code: "MODEL", message: unresolvableModelIdMessage(model) };
  const heartbeat = clampInt(input.heartbeatHours, B.heartbeatHours.min, B.heartbeatHours.max, 168);
  if (heartbeat === 0 && triggers.length === 0) {
    return { ok: false, code: "NEVER_WAKES", message: "A correspondent with no heartbeat and no triggers would never run" };
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO correspondents
       (grant_id, title, brief, audience, scope_claim_ids, scope_tag_ids,
        heartbeat_hours, min_wake_hours, triggers, model, changes_cursor, created_by)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8, $9::jsonb, $10, $11, $12)
     RETURNING id`,
    [
      input.grantId,
      title.slice(0, B.titleChars.max),
      brief.slice(0, B.briefChars.max),
      audience.slice(0, B.audienceChars.max),
      scope.claimIds,
      scope.tagIds,
      heartbeat,
      clampInt(input.minWakeHours, B.minWakeHours.min, B.minWakeHours.max, 24),
      JSON.stringify(triggers),
      model,
      cursorAt(new Date()),
      input.createdBy,
    ]
  );
  return {
    ok: true,
    correspondentId: row!.id,
    ...(scope.unknownTags.length > 0 ? { unknownTags: scope.unknownTags } : {}),
  };
}

/** Amend a correspondent the mandate owns; only the fields given change. */
export async function updateCorrespondent(input: {
  grantId: string;
  correspondentId: string;
  title?: string;
  brief?: string;
  audience?: string;
  scopeClaimIds?: unknown;
  scopeTags?: unknown;
  status?: string;
  heartbeatHours?: number;
  minWakeHours?: number;
  triggers?: unknown;
  model?: string | null;
}): Promise<CorrespondentWriteResult> {
  const current = isUuid(input.correspondentId) ? await getCorrespondent(input.correspondentId) : null;
  if (!current || current.grant_id !== input.grantId) {
    return { ok: false, code: "NOT_FOUND", message: "No such correspondent on this mandate" };
  }
  if (current.status === "retired") return { ok: false, code: "RETIRED", message: "A retired correspondent cannot be changed" };
  const B = CORRESPONDENT_BOUNDS;
  const sets: string[] = [];
  const params: unknown[] = [input.correspondentId];
  const set = (col: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (t.length < B.titleChars.min) return { ok: false, code: "TITLE", message: "Title too short" };
    set("title", t.slice(0, B.titleChars.max));
  }
  if (input.brief !== undefined) {
    const b = String(input.brief).trim();
    if (b.length < B.briefChars.min) return { ok: false, code: "BRIEF", message: "Brief too short" };
    set("brief", b.slice(0, B.briefChars.max));
  }
  if (input.audience !== undefined) {
    const a = String(input.audience).trim();
    if (a.length < B.audienceChars.min) return { ok: false, code: "AUDIENCE", message: "Say who the updates are for" };
    set("audience", a.slice(0, B.audienceChars.max));
  }
  let unknownTags: string[] = [];
  let scopeClaims = current.scope_claim_ids ?? [];
  let scopeTags = current.scope_tag_ids ?? [];
  if (input.scopeClaimIds !== undefined || input.scopeTags !== undefined) {
    const scope = await resolveScope(
      input.scopeClaimIds !== undefined ? input.scopeClaimIds : current.scope_claim_ids,
      input.scopeTags
    );
    if ("problem" in scope) return { ok: false, code: "SCOPE", message: scope.problem };
    unknownTags = scope.unknownTags;
    scopeClaims = scope.claimIds;
    if (input.scopeClaimIds !== undefined) set("scope_claim_ids", scope.claimIds, "::uuid[]");
    if (input.scopeTags !== undefined) {
      scopeTags = scope.tagIds;
      set("scope_tag_ids", scope.tagIds, "::uuid[]");
    }
  }
  let triggers = current.triggers ?? [];
  if (input.triggers !== undefined) {
    const t = normalizeTriggers(input.triggers);
    if (typeof t === "string") return { ok: false, code: "TRIGGERS", message: t };
    triggers = t;
    set("triggers", JSON.stringify(t), "::jsonb");
  }
  if (triggers.includes("graph_change") && scopeClaims.length === 0 && scopeTags.length === 0) {
    return { ok: false, code: "SCOPE", message: "graph_change needs scope claims or tags to watch" };
  }
  let heartbeat = current.heartbeat_hours;
  if (input.heartbeatHours !== undefined) {
    heartbeat = clampInt(input.heartbeatHours, B.heartbeatHours.min, B.heartbeatHours.max, current.heartbeat_hours);
    set("heartbeat_hours", heartbeat);
  }
  if (heartbeat === 0 && triggers.length === 0) {
    return { ok: false, code: "NEVER_WAKES", message: "A correspondent with no heartbeat and no triggers would never run" };
  }
  if (input.minWakeHours !== undefined) {
    set("min_wake_hours", clampInt(input.minWakeHours, B.minWakeHours.min, B.minWakeHours.max, current.min_wake_hours));
  }
  if (input.model !== undefined) {
    const model = input.model?.trim() || null;
    if (model && !resolveProvider(model)) return { ok: false, code: "MODEL", message: unresolvableModelIdMessage(model) };
    set("model", model);
  }
  if (input.status !== undefined) {
    if (!CORRESPONDENT_STATUSES.includes(input.status as CorrespondentStatus)) {
      return { ok: false, code: "STATUS", message: `status must be one of ${CORRESPONDENT_STATUSES.join(", ")}` };
    }
    set("status", input.status);
  }
  if (sets.length === 0) return { ok: true, correspondentId: input.correspondentId };
  await rawQuery(`UPDATE correspondents SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  return { ok: true, correspondentId: input.correspondentId, ...(unknownTags.length ? { unknownTags } : {}) };
}

export async function getCorrespondent(id: string): Promise<CorrespondentRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await rawQuery<CorrespondentRow>(`${SELECT} WHERE id = $1`, [id]);
  return row ?? null;
}

export async function listCorrespondents(grantId: string): Promise<CorrespondentRow[]> {
  return rawQuery<CorrespondentRow>(`${SELECT} WHERE grant_id = $1 ORDER BY created_at ASC`, [grantId]);
}

/**
 * "Which correspondents cover this claim?" — those whose scope names the
 * claim or anything it lies beneath, or a tag it carries. Retired ones
 * are left out.
 */
export async function listCorrespondentsCovering(claimId: string): Promise<CorrespondentRow[]> {
  if (!isUuid(claimId)) return [];
  return rawQuery<CorrespondentRow>(
    `WITH RECURSIVE above AS (
       SELECT $1::uuid AS id
       UNION
       SELECT cr.parent_claim_id FROM claim_relationships cr JOIN above a ON cr.child_claim_id = a.id
     )
     ${SELECT}
      WHERE status <> 'retired'
        AND (scope_claim_ids && ARRAY(SELECT id FROM above)
             OR scope_tag_ids && ARRAY(SELECT tg.tag_id FROM taggings tg
                                        WHERE tg.subject_kind = 'claim' AND tg.subject_id = $1::uuid))
      ORDER BY created_at ASC
      LIMIT 100`,
    [claimId]
  );
}

/** Public correspondents, newest first, for discovery (`GET /correspondents`). */
export async function listAllCorrespondents(opts: { limit?: number; offset?: number } = {}): Promise<CorrespondentRow[]> {
  return rawQuery<CorrespondentRow>(
    `${SELECT} WHERE status <> 'retired' ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [Math.min(200, Math.max(1, opts.limit ?? 50)), Math.max(0, opts.offset ?? 0)]
  );
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export async function queueCorrespondentEvent(input: {
  correspondentId: string;
  kind: CorrespondentTriggerKind;
  payload?: Record<string, unknown>;
}): Promise<{ queued: boolean }> {
  const rows = await rawQuery<{ id: string }>(
    // A change wake is queued once while one waits (the run reads the whole
    // stream from its cursor, so a second would add nothing); every task may
    // run the scan, and this keeps two of them from doubling a wake.
    `INSERT INTO correspondent_events (correspondent_id, kind, payload)
     SELECT $1, $2, $3::jsonb FROM correspondents
      WHERE id = $1 AND status = 'active'
        AND ($2 <> 'graph_change' OR NOT EXISTS (
              SELECT 1 FROM correspondent_events e
               WHERE e.correspondent_id = $1 AND e.kind = 'graph_change' AND e.consumed_at IS NULL))
     RETURNING id`,
    [input.correspondentId, input.kind, JSON.stringify(input.payload ?? {})]
  );
  return { queued: rows.length > 0 };
}

export interface CorrespondentEventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function pendingCorrespondentEvents(id: string, limit = 50): Promise<CorrespondentEventRow[]> {
  return rawQuery<CorrespondentEventRow>(
    `SELECT id, kind, payload, created_at FROM correspondent_events
      WHERE correspondent_id = $1 AND consumed_at IS NULL
      ORDER BY created_at ASC LIMIT $2`,
    [id, limit]
  );
}

export async function consumeCorrespondentEvents(id: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await rawQuery(
    `UPDATE correspondent_events SET consumed_at = now()
      WHERE correspondent_id = $1 AND id = ANY($2::uuid[]) AND consumed_at IS NULL`,
    [id, ids]
  );
}

/**
 * The graph_change scan: for every active correspondent on an active
 * mandate that wakes on graph changes and has no such wake waiting, queue
 * one if anything material changed in its scope after its cursor. It
 * judges nothing and spends nothing: whether a change deserves the
 * audience's attention is the run's call, and whether the run happens is
 * the mandate's money.
 */
export async function graphChangeScanTick(opts: { max?: number } = {}): Promise<{ checked: number; queued: number }> {
  const rows = await rawQuery<{
    id: string;
    scope_claim_ids: string[];
    scope_tag_ids: string[];
    changes_cursor: string | null;
    created_at: Date;
  }>(
    `SELECT c.id, c.scope_claim_ids, c.scope_tag_ids, c.changes_cursor, c.created_at
       FROM correspondents c JOIN grants g ON g.id = c.grant_id
      WHERE c.status = 'active' AND g.status = 'active'
        AND c.triggers ? 'graph_change'
        AND NOT EXISTS (SELECT 1 FROM correspondent_events e
                         WHERE e.correspondent_id = c.id AND e.kind = 'graph_change'
                           AND e.consumed_at IS NULL)
      ORDER BY c.last_run_at ASC NULLS FIRST
      LIMIT $1`,
    [opts.max ?? 200]
  );
  let queued = 0;
  for (const c of rows) {
    const page = await listGraphChanges({
      after: c.changes_cursor && decodeChangeCursor(c.changes_cursor) ? c.changes_cursor : cursorAt(new Date(c.created_at)),
      scope: { under: c.scope_claim_ids ?? [], tagIds: c.scope_tag_ids ?? [] },
      limit: 1,
    });
    const first = page.changes[0];
    if (!first) continue;
    const res = await queueCorrespondentEvent({
      correspondentId: c.id,
      kind: "graph_change",
      payload: { first_change_id: first.change_id, first_change_at: first.at, claim_id: first.claim_id },
    });
    if (res.queued) queued++;
  }
  return { checked: rows.length, queued };
}

// ---------------------------------------------------------------------------
// A run's window, its record, its update
// ---------------------------------------------------------------------------

/** Changes in scope from one cursor, until `until` (exclusive of nothing past it) or the cap. */
async function readChanges(
  c: Pick<CorrespondentRow, "scope_claim_ids" | "scope_tag_ids">,
  from: string,
  cap: number,
  until?: string
): Promise<{ changes: GraphChange[]; to: string; more: boolean }> {
  const scoped = (c.scope_claim_ids?.length ?? 0) + (c.scope_tag_ids?.length ?? 0) > 0;
  const stop = until ? decodeChangeCursor(until) : null;
  const changes: GraphChange[] = [];
  let cursor = from;
  let more = false;
  while (changes.length < cap) {
    const page = await listGraphChanges({
      after: cursor,
      // An unscoped correspondent (a brief in words, on a heartbeat) reads
      // the whole graph's stream; its brief says what in it matters.
      scope: scoped ? { under: c.scope_claim_ids ?? [], tagIds: c.scope_tag_ids ?? [] } : undefined,
      limit: Math.min(200, cap - changes.length),
    });
    let crossed = false;
    for (const ch of page.changes) {
      if (stop && (ch.at > stop.at || (ch.at === stop.at && ch.change_id > stop.id))) {
        crossed = true;
        break;
      }
      changes.push(ch);
      cursor = ch.cursor;
    }
    if (crossed) return { changes, to: until!, more: false };
    if (!page.has_more) {
      // Read to the end of the stream: resume after everything scanned,
      // but never past `until`.
      return { changes, to: until ?? page.next_cursor ?? cursor, more: false };
    }
    cursor = page.changes.length > 0 ? cursor : page.next_cursor ?? cursor;
    more = true;
  }
  return { changes, to: cursor, more };
}

/**
 * The window a run is briefed with and an update accounts for: every
 * material change in scope since the last PUBLISHED update (or since the
 * correspondent was posted), up to windowChanges.
 *
 *   - `seen`: changes an earlier run read without publishing (between the
 *     last update and the read cursor). A quiet run moves the read cursor
 *     so the scan does not wake it again for the same changes, but those
 *     changes still belong to the next update's account: mentioned there,
 *     or listed as not covered.
 *   - `fresh`: changes after the read cursor, new to this run.
 *   - `to`: where the read cursor moves when the run ends. When the window
 *     was cut short at the cap, the rest wait for the next run.
 */
export async function correspondentWindow(
  c: Pick<CorrespondentRow, "id" | "changes_cursor" | "scope_claim_ids" | "scope_tag_ids" | "created_at">
): Promise<{ from: string; to: string; seen: GraphChange[]; fresh: GraphChange[]; changes: GraphChange[]; more: boolean }> {
  const posted = cursorAt(new Date(c.created_at));
  const readCursor = c.changes_cursor && decodeChangeCursor(c.changes_cursor) ? c.changes_cursor : posted;
  const [last] = await rawQuery<{ changes_to: string | null }>(
    `SELECT changes_to FROM correspondent_updates WHERE correspondent_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [c.id]
  );
  const from = last?.changes_to && decodeChangeCursor(last.changes_to) ? last.changes_to : posted;
  const cap = CORRESPONDENT_BOUNDS.windowChanges;
  const seen =
    from === readCursor ? { changes: [], to: readCursor, more: false } : await readChanges(c, from, cap, readCursor);
  if (seen.more) {
    return { from, to: seen.to, seen: seen.changes, fresh: [], changes: seen.changes, more: true };
  }
  const fresh = await readChanges(c, readCursor, cap - seen.changes.length);
  return {
    from,
    to: fresh.to,
    seen: seen.changes,
    fresh: fresh.changes,
    changes: [...seen.changes, ...fresh.changes],
    more: fresh.more,
  };
}

export async function recordCorrespondentRun(input: {
  correspondentId: string;
  note: string | null;
  /** Where the change cursor moves; null leaves it (a failed run). */
  cursorTo: string | null;
  failed?: boolean;
}): Promise<void> {
  await rawQuery(
    `UPDATE correspondents
        SET last_run_at = now(),
            next_due_at = CASE
              WHEN $4::boolean THEN now() + GREATEST(make_interval(hours => heartbeat_hours), interval '6 hours')
              WHEN heartbeat_hours > 0 THEN now() + make_interval(hours => heartbeat_hours)
              ELSE 'infinity'::timestamptz END,
            changes_cursor = COALESCE($3, changes_cursor),
            runs = runs + 1,
            last_note = COALESCE($2, last_note),
            updated_at = now()
      WHERE id = $1`,
    [
      input.correspondentId,
      input.note ? input.note.slice(0, CORRESPONDENT_BOUNDS.noteChars) : null,
      input.cursorTo,
      input.failed === true,
    ]
  );
}

export const PLAN_STATUSES = ["open", "done", "dropped"] as const;

export interface PlanItemRow {
  id: string;
  text: string;
  status: (typeof PLAN_STATUSES)[number];
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listPlanItems(
  correspondentId: string,
  opts: { status?: "open" | "closed" | "all"; limit?: number } = {}
): Promise<PlanItemRow[]> {
  const status = opts.status ?? "all";
  return rawQuery<PlanItemRow>(
    `SELECT id, text, status, note, created_at, updated_at FROM correspondent_plan_items
      WHERE correspondent_id = $1
        AND ($2 = 'all' OR ($2 = 'open' AND status = 'open') OR ($2 = 'closed' AND status <> 'open'))
      ORDER BY (status = 'open') DESC, updated_at DESC
      LIMIT $3`,
    [correspondentId, status, Math.min(200, Math.max(1, opts.limit ?? 50))]
  );
}

/**
 * Add plan items and close or amend existing ones, in one call. Items
 * belong to this correspondent only; a closed item stays on the record.
 */
export async function updateCorrespondentPlan(input: {
  correspondentId: string;
  add?: unknown;
  update?: unknown;
}): Promise<{ ok: true; added: string[]; updated: string[] } | { ok: false; problem: string }> {
  const B = CORRESPONDENT_BOUNDS;
  const adds = Array.isArray(input.add) ? input.add.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
  const updates = Array.isArray(input.update) ? (input.update as Array<Record<string, unknown>>) : [];
  const long = adds.find((t) => t.length > B.planItemChars);
  if (long) return { ok: false, problem: `A plan item is a sentence or two (at most ${B.planItemChars} characters); put detail in your workspace.` };
  for (const [i, u] of updates.entries()) {
    if (!isUuid(u?.id)) return { ok: false, problem: `update[${i}].id must be a plan item id exactly as your briefing gave it` };
    if (u.status !== undefined && !PLAN_STATUSES.includes(u.status as PlanItemRow["status"])) {
      return { ok: false, problem: `update[${i}].status must be one of ${PLAN_STATUSES.join(", ")}` };
    }
  }
  const ids = updates.map((u) => String(u.id));
  if (ids.length > 0) {
    const mine = await rawQuery<{ id: string }>(
      `SELECT id FROM correspondent_plan_items WHERE correspondent_id = $1 AND id = ANY($2::uuid[])`,
      [input.correspondentId, ids]
    );
    const have = new Set(mine.map((r) => r.id));
    const missing = ids.find((id) => !have.has(id));
    if (missing) return { ok: false, problem: `No plan item ${missing} on your plan` };
  }
  const updated: string[] = [];
  for (const u of updates) {
    await rawQuery(
      `UPDATE correspondent_plan_items
          SET status = COALESCE($3, status),
              note = COALESCE($4, note),
              text = COALESCE($5, text),
              updated_at = now()
        WHERE id = $2 AND correspondent_id = $1`,
      [
        input.correspondentId,
        String(u.id),
        u.status === undefined ? null : String(u.status),
        u.note === undefined ? null : String(u.note).slice(0, B.planItemChars),
        u.text === undefined ? null : String(u.text).trim().slice(0, B.planItemChars) || null,
      ]
    );
    updated.push(String(u.id));
  }
  const added: string[] = [];
  for (const text of adds) {
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO correspondent_plan_items (correspondent_id, text) VALUES ($1, $2) RETURNING id`,
      [input.correspondentId, text]
    );
    added.push(row!.id);
  }
  return { ok: true, added, updated };
}

export async function updateCorrespondentWorkspace(id: string, content: string): Promise<number> {
  const text = content.slice(0, CORRESPONDENT_BOUNDS.workspaceChars);
  await rawQuery(`UPDATE correspondents SET workspace = $2, updated_at = now() WHERE id = $1`, [id, text]);
  return text.length;
}

export interface UpdateItem {
  claim_id: string;
  reason: string;
  change_ids: string[];
}

export interface NotCovered {
  /** Changes in the window the update did not mention, listed up to notCoveredListed. */
  changes: Array<{ change_id: string; claim_id: string; kind: string }>;
  changes_total: number;
  /** Changes past the window, left for the next update. */
  more_after_window: boolean;
  /** The correspondent's own account of what in scope it has not looked at. */
  unexamined: string;
}

/**
 * Validate an update's items against the run's window (pure): every claim id
 * must be a real one the caller checked, every change id one in the window.
 * Returns the cleaned items or the first problem.
 */
export function validateUpdateItems(
  raw: unknown,
  windowChangeIds: Set<string>,
  knownClaimIds: Set<string>
): { items: UpdateItem[] } | { problem: string } {
  if (!Array.isArray(raw)) return { problem: "items must be a list" };
  if (raw.length > CORRESPONDENT_BOUNDS.updateItems) {
    return { problem: `At most ${CORRESPONDENT_BOUNDS.updateItems} items; an update that long is not a selection` };
  }
  const items: UpdateItem[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const claimId = String(o.claim_id ?? "");
    if (!knownClaimIds.has(claimId)) return { problem: `items[${i}].claim_id "${claimId}" is not an active claim` };
    const reason = String(o.reason ?? "").trim();
    if (reason.length < 10) return { problem: `items[${i}].reason: say why this node is in the output` };
    const changeIds = Array.isArray(o.change_ids) ? [...new Set(o.change_ids.map(String))] : [];
    const notInWindow = changeIds.find((id) => !windowChangeIds.has(id));
    if (notInWindow) return { problem: `items[${i}].change_ids: "${notInWindow}" is not a change in this run's window` };
    items.push({ claim_id: claimId, reason: reason.slice(0, CORRESPONDENT_BOUNDS.itemReasonChars), change_ids: changeIds });
  }
  return { items };
}

/**
 * The part of "not covered" the mechanism computes (pure): every change in
 * the window that no item cites, by change id or by its claim.
 */
export function computeNotCovered(
  window: GraphChange[],
  items: UpdateItem[],
  moreAfterWindow: boolean,
  unexamined: string
): NotCovered {
  const cited = new Set(items.flatMap((i) => i.change_ids));
  const claims = new Set(items.map((i) => i.claim_id));
  const missed = window.filter((c) => !cited.has(c.change_id) && !claims.has(c.claim_id));
  return {
    changes: missed.slice(0, CORRESPONDENT_BOUNDS.notCoveredListed).map((c) => ({
      change_id: c.change_id,
      claim_id: c.claim_id,
      kind: c.kind,
    })),
    changes_total: missed.length,
    more_after_window: moreAfterWindow,
    unexamined: unexamined.trim().slice(0, CORRESPONDENT_BOUNDS.unexaminedChars),
  };
}

export async function publishCorrespondentUpdate(input: {
  correspondentId: string;
  grantId: string;
  title: string;
  body: string;
  items: UpdateItem[];
  notCovered: NotCovered;
  changesFrom: string;
  changesTo: string;
}): Promise<{ updateId: string }> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO correspondent_updates
       (correspondent_id, grant_id, title, body, items, not_covered, changes_from, changes_to)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      input.correspondentId,
      input.grantId,
      input.title.slice(0, CORRESPONDENT_BOUNDS.updateTitleChars),
      input.body.slice(0, CORRESPONDENT_BOUNDS.updateBodyChars),
      JSON.stringify(input.items),
      JSON.stringify(input.notCovered),
      input.changesFrom,
      input.changesTo,
    ]
  );
  await rawQuery(`UPDATE correspondents SET updates = updates + 1, updated_at = now() WHERE id = $1`, [
    input.correspondentId,
  ]);
  return { updateId: row!.id };
}

export interface CorrespondentUpdateRow {
  id: string;
  correspondent_id: string;
  grant_id: string;
  title: string;
  body: string;
  items: UpdateItem[];
  not_covered: NotCovered;
  changes_from: string | null;
  changes_to: string | null;
  created_at: Date;
}

export async function listCorrespondentUpdates(
  correspondentId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ updates: CorrespondentUpdateRow[]; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const [updates, [count]] = await Promise.all([
    rawQuery<CorrespondentUpdateRow>(
      `SELECT id, correspondent_id, grant_id, title, body, items, not_covered,
              changes_from, changes_to, created_at
         FROM correspondent_updates WHERE correspondent_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [correspondentId, limit, offset]
    ),
    rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM correspondent_updates WHERE correspondent_id = $1`, [
      correspondentId,
    ]),
  ]);
  return { updates, total: Number(count?.n ?? 0) };
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ch === "'" ? "&apos;" : "&quot;"
  );
}

/** The prose of one update as a reader sees it: the body, then what it left out, then who paid. */
export function renderUpdateText(
  u: Pick<CorrespondentUpdateRow, "body" | "not_covered">,
  mandate: { title: string; url: string }
): string {
  const nc = u.not_covered ?? ({} as Partial<NotCovered>);
  const missed = Number(nc.changes_total ?? 0);
  const lines = [u.body.trim(), "", "Not covered:"];
  lines.push(
    missed === 0
      ? "- Every material change in scope since the last update is mentioned above."
      : `- ${missed} material change${missed === 1 ? "" : "s"} in scope since the last update ${missed === 1 ? "is" : "are"} not mentioned above.`
  );
  if (nc.more_after_window) lines.push("- More changes followed than one update reads; the next update starts there.");
  if (nc.unexamined) lines.push(`- ${nc.unexamined}`);
  lines.push(
    "",
    `Funded by the mandate "${mandate.title}" (${mandate.url}). Funding buys coverage, not what an update says.`
  );
  return lines.join("\n");
}

/** GET /correspondents/:id/feed — the updates as an Atom feed, newest first. */
export function correspondentAtom(
  c: Pick<CorrespondentRow, "id" | "title" | "audience" | "updated_at">,
  updates: CorrespondentUpdateRow[],
  opts: { apiBase: string; mandate: { title: string; url: string } }
): string {
  const updated = updates[0] ? new Date(updates[0].created_at).toISOString() : new Date(c.updated_at).toISOString();
  const entries = updates
    .map((u) => {
      const at = new Date(u.created_at).toISOString();
      return (
        `  <entry>\n` +
        `    <id>urn:minerval:correspondent-update:${u.id}</id>\n` +
        `    <title>${xmlEscape(u.title)}</title>\n` +
        `    <link href="${xmlEscape(`${opts.apiBase}/correspondents/${c.id}/updates/${u.id}`)}"/>\n` +
        `    <updated>${at}</updated>\n` +
        `    <content type="text">${xmlEscape(renderUpdateText(u, opts.mandate))}</content>\n` +
        `  </entry>`
      );
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `  <title>${xmlEscape(c.title)}</title>\n` +
    `  <subtitle>${xmlEscape(`A Minerval Correspondent for ${c.audience}`)}</subtitle>\n` +
    `  <id>urn:minerval:correspondent:${c.id}</id>\n` +
    `  <link rel="self" href="${xmlEscape(`${opts.apiBase}/correspondents/${c.id}/feed`)}"/>\n` +
    `  <link href="${xmlEscape(opts.mandate.url)}"/>\n` +
    `  <updated>${updated}</updated>\n` +
    (entries ? `${entries}\n` : "") +
    `</feed>\n`
  );
}

/**
 * Where the mandate's money stands, as a run is shown it (pace-service.ts):
 * its pace, what is uncommitted, and the Grantmaker's reserve, which a
 * Correspondent's runs cannot draw on. A correspondent sees this so it
 * knows why a run may come late, not to spend against it: its own run's
 * budget is its ceiling.
 */
export async function mandateRoom(grantId: string): Promise<{ sentence: string } | null> {
  const { paceRoom } = await import("./pace-service.js");
  const room = await paceRoom(grantId, "delegated");
  return room ? { sentence: room.sentence } : null;
}

/** A correspondent as the public reads it: everything but its private-to-run fields. */
export interface CorrespondentPublic {
  id: string;
  mandate_id: string;
  title: string;
  brief: string;
  audience: string;
  scope_claim_ids: string[];
  scope_tag_ids: string[];
  status: CorrespondentStatus;
  heartbeat_hours: number;
  triggers: CorrespondentTriggerKind[];
  min_wake_hours: number;
  model: string | null;
  runs: number;
  updates: number;
  last_run_at: string | null;
  last_note: string | null;
  feed_path: string;
  updates_path: string;
  created_by: string | null;
  created_at: string;
}

export function correspondentPublic(c: CorrespondentRow): CorrespondentPublic {
  return {
    id: c.id,
    mandate_id: c.grant_id,
    title: c.title,
    brief: c.brief,
    audience: c.audience,
    scope_claim_ids: c.scope_claim_ids ?? [],
    scope_tag_ids: c.scope_tag_ids ?? [],
    status: c.status,
    heartbeat_hours: c.heartbeat_hours,
    triggers: c.triggers ?? [],
    min_wake_hours: c.min_wake_hours,
    model: c.model,
    runs: c.runs,
    updates: c.updates,
    last_run_at: c.last_run_at ? new Date(c.last_run_at).toISOString() : null,
    last_note: c.last_note,
    feed_path: `/correspondents/${c.id}/feed`,
    updates_path: `/correspondents/${c.id}/updates`,
    created_by: c.created_by,
    created_at: new Date(c.created_at).toISOString(),
  };
}
