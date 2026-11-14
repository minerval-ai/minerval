/**
 * The change stream: what moved in the graph, in the order it moved
 * (#562, first slice; built for Correspondents, #563).
 *
 * No one can re-read a large graph to find out what changed. This read
 * answers "what changed, since where I last looked, in the part of the graph
 * I follow?" with one entry per material change, each with its size, and a
 * cursor to resume from. It returns ids and short summaries, not whole
 * claims; the reader expands what it needs with get_claim.
 *
 * This first slice reads verdicts: a node's first assessment, its status
 * moving on the ladder, its credence moving by at least a threshold (the
 * monitors' material credence delta by default, docs/monitors.md). The other
 * change kinds #562 names (defeaters, argument evaluations, holds, requests,
 * findings) join the same stream as they are built.
 *
 * Defined once and served to everyone the same way: outside callers over MCP
 * (`list_graph_changes`, src/mcp/server.ts) and REST (`GET /changes`), and
 * the graph's own Correspondents (llm/agents/correspondent.ts). A
 * Correspondent of ours has no read here that an outside one lacks, which is
 * what makes building one elsewhere easy.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { resolveTagBySlug } from "./tag-service.js";

/** Who is reading; only the description's last sentence differs. */
export type GraphChangeAudience = "caller" | "agent";

export const VERDICT_CHANGE_KINDS = ["first_assessment", "status_moved", "credence_moved", "reassessed"] as const;
/**
 * The rest of what moves on the graph and its ledger. Read only when a
 * caller asks for them with `kinds`, so a reader of verdicts (a digest, a
 * Correspondent) sees exactly what it always did.
 */
export const EVENT_CHANGE_KINDS = [
  "work_commissioned",
  "run_finished",
  "message_arrived",
  "message_answered",
  "contribution_accepted",
  "ruling",
  "petition_decided",
  "request_filed",
  // A node archived, restored, merged or deprecated, with who and why (#962).
  "state_changed",
] as const;
export const GRAPH_CHANGE_KINDS = [...VERDICT_CHANGE_KINDS, ...EVENT_CHANGE_KINDS] as const;
export type GraphChangeKind = (typeof GRAPH_CHANGE_KINDS)[number];
type EventKind = (typeof EVENT_CHANGE_KINDS)[number];

/** The ladder a status moves along; `unknown` sits off it. */
const STATUS_LADDER = ["verified", "supported", "inconclusive", "doubtful", "contradicted"];

export const DEFAULT_CHANGES_PAGE = 50;
export const MAX_CHANGES_PAGE = 200;
/** Scope ids and tags a call may name. */
const MAX_SCOPE_IDS = 100;
const MAX_SCOPE_TAGS = 20;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export interface GraphChange {
  /** The row that made the change: an assessment, a message, a commission… */
  change_id: string;
  at: string;
  claim_id: string;
  claim_text: string;
  kind: GraphChangeKind;
  /** For the kinds beyond verdicts: what happened, in a line (a trigger, an outcome, a budget). */
  summary?: string;
  status: string | null;
  prev_status: string | null;
  confidence: number;
  credence: number | null;
  prev_credence: number | null;
  /** Signed; null when either side states no credence. */
  credence_delta: number | null;
  /** Rungs moved on the ladder (positive = toward contradicted); null off the ladder. */
  status_steps: number | null;
  trigger: string | null;
  page_url: string;
  /** Resume after this change. */
  cursor: string;
}

export interface GraphChangeScope {
  /** Claims, with everything beneath them. */
  under?: string[];
  /** Tag ids (already resolved). */
  tagIds?: string[];
}

export interface GraphChangePage {
  changes: GraphChange[];
  /** Pass as `after` for the next page; the input cursor when nothing is new. */
  next_cursor: string | null;
  has_more: boolean;
}

// ---- cursors -----------------------------------------------------------------

/** Opaque to callers: the (assessed_at, id) position, microsecond-exact. */
export function encodeChangeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

/**
 * An ISO time in the stream's own form, microseconds and "Z", so positions
 * compare as strings ("…00.123Z" would sort after "…00.123456Z").
 */
export function toMicroIso(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\d*Z$/.exec(iso);
  if (!m) return iso;
  return `${m[1]}.${(m[2] ?? "").padEnd(6, "0")}Z`;
}

export function decodeChangeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || !ID_RE.test(id) || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

// ---- classification (pure) ------------------------------------------------------

export function statusSteps(prev: string | null, next: string): number | null {
  if (!prev) return null;
  const a = STATUS_LADDER.indexOf(prev);
  const b = STATUS_LADDER.indexOf(next);
  return a < 0 || b < 0 ? null : b - a;
}

/**
 * What kind of change one assessment made against the one before it, or
 * null when it is below the threshold and only material changes are wanted.
 */
export function classifyChange(
  row: { status: string; prev_status: string | null; credence: number | null; prev_credence: number | null; has_prev: boolean },
  minCredenceDelta: number,
  materialOnly: boolean
): GraphChangeKind | null {
  if (!row.has_prev) return "first_assessment";
  if (row.status !== row.prev_status) return "status_moved";
  const stated = row.credence !== null;
  const wasStated = row.prev_credence !== null;
  if (stated !== wasStated) return "credence_moved";
  if (stated && wasStated) {
    const delta = Math.abs(row.credence! - row.prev_credence!);
    // A threshold of 0 means any move; otherwise a move at the threshold
    // counts (with float slack, so 0.3 → 0.2 is a 0.1 move).
    if (minCredenceDelta === 0 ? delta > 0 : delta >= minCredenceDelta - 1e-9) return "credence_moved";
  }
  return materialOnly ? null : "reassessed";
}

// ---- definition ---------------------------------------------------------------

export interface GraphChangeDefinition {
  name: "list_graph_changes";
  title: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export function graphChangeDefinition(audience: GraphChangeAudience): GraphChangeDefinition {
  const delta = loadConfig().monitorMaterialCredenceDelta;
  return {
    name: "list_graph_changes",
    title: "List graph changes",
    description:
      "What changed in the graph, oldest first, from where you last looked: one " +
      "entry per material change to a node's verdict (its first assessment, its " +
      "status moving on the ladder, or its credence moving by at least " +
      `min_credence_delta, ${delta} by default), each with its size ` +
      "(status_steps, credence_delta), what triggered the pass, the node's id, " +
      "text and page_url, and a cursor. Pass next_cursor back as `after` to read " +
      "on; keep it to resume later, which is how a digest or a feed knows what is " +
      "new since its last edition. Narrow it to part of the graph with `under` " +
      "(claims and everything beneath them) and/or `tags` (either matches). " +
      "Returns ids and summaries, not whole nodes: open what matters with get_claim. " +
      "Ask for more than verdicts with `kinds`: work_commissioned and run_finished " +
      "(the ledger), message_arrived and message_answered (nodes' inboxes), " +
      "contribution_accepted, ruling, petition_decided and request_filed, and " +
      "state_changed (a node archived, restored, merged or deprecated: its " +
      "summary says from and to, by whom, why, and the successors that carry " +
      "on what it stated, if any)." +
      (audience === "caller" ? " Free." : ""),
    input_schema: {
      type: "object",
      properties: {
        after: { type: "string", maxLength: 300, description: "A cursor from a previous result: changes after it" },
        since: {
          type: "string",
          format: "date-time",
          description: "Without a cursor: changes after this time. Neither: the most recent changes' start, 30 days back",
        },
        under: {
          type: "array",
          items: { type: "string", pattern: ID_PATTERN },
          maxItems: MAX_SCOPE_IDS,
          description: "Only changes to these nodes or anything beneath them",
        },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: MAX_SCOPE_TAGS,
          description: "Only changes to nodes carrying one of these tag slugs. An unknown tag matches nothing",
        },
        min_credence_delta: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: `The least credence move that counts, ${delta} by default`,
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...GRAPH_CHANGE_KINDS] },
          description:
            "Only these kinds of change. Leave it out for verdicts only (first_assessment, status_moved, credence_moved, and reassessed when material_only is false)",
        },
        material_only: {
          type: "boolean",
          default: true,
          description: "false also returns reassessments that moved nothing (kind `reassessed`)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CHANGES_PAGE,
          default: DEFAULT_CHANGES_PAGE,
          description: `Most changes to return, ${DEFAULT_CHANGES_PAGE} by default`,
        },
      },
      required: [],
    },
  };
}

// ---- the read -------------------------------------------------------------------

function pageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

interface ChangeRow {
  id: string;
  at: string;
  claim_id: string;
  claim_text: string;
  status: string;
  confidence: number;
  credence: number | null;
  trigger: string | null;
  has_prev: boolean;
  prev_status: string | null;
  prev_credence: number | null;
}

/**
 * One page of changes in scope after a position. Rows below the threshold are
 * skipped, and the scan goes on past them (up to a bounded number of rows), so
 * a quiet page does not end early because the graph was busy with minor
 * passes; next_cursor always advances past what was scanned.
 */
export async function listGraphChanges(input: {
  after?: string | null;
  since?: string | Date | null;
  scope?: GraphChangeScope;
  minCredenceDelta?: number;
  materialOnly?: boolean;
  /** Which kinds to return; verdicts only when absent. */
  kinds?: GraphChangeKind[];
  limit?: number;
}): Promise<GraphChangePage> {
  const wanted = new Set<GraphChangeKind>(input.kinds && input.kinds.length > 0 ? input.kinds : VERDICT_CHANGE_KINDS);
  const events = EVENT_CHANGE_KINDS.filter((k) => wanted.has(k));
  const verdicts = VERDICT_CHANGE_KINDS.some((k) => wanted.has(k));
  if (events.length === 0) return listVerdictChanges(input, wanted);
  const limit = Math.min(MAX_CHANGES_PAGE, Math.max(1, Math.round(Number(input.limit ?? DEFAULT_CHANGES_PAGE)) || DEFAULT_CHANGES_PAGE));
  const [v, e] = await Promise.all([
    verdicts ? listVerdictChanges({ ...input, limit }, wanted) : Promise.resolve(null),
    listEventChanges({ ...input, limit }, events),
  ]);
  // Merge the two scans in stream order and take a page; resume after the
  // last change returned, or, on a short page, after both scans' positions.
  const merged = [...(v?.changes ?? []), ...e.changes].sort((a, b) =>
    a.at === b.at ? (a.change_id < b.change_id ? -1 : 1) : a.at < b.at ? -1 : 1
  );
  const page = merged.slice(0, limit);
  const full = page.length === limit && (merged.length > limit || Boolean(v?.has_more) || e.has_more);
  let next: string | null;
  if (full) {
    next = page.at(-1)!.cursor;
  } else {
    const positions = [v?.next_cursor, e.next_cursor].map((c) => (c ? decodeChangeCursor(c) : null)).filter(Boolean) as Array<{ at: string; id: string }>;
    const last = positions.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1)).at(-1);
    next = last ? encodeChangeCursor(last.at, last.id) : (input.after ?? null);
  }
  return { changes: page, next_cursor: next, has_more: full };
}

interface EventRow {
  id: string;
  at: string;
  kind: EventKind;
  claim_id: string;
  claim_text: string;
  summary: string | null;
}

/** The kinds beyond verdicts, from the ledger, inboxes, reviews and requests, in stream order. */
async function listEventChanges(
  input: { after?: string | null; since?: string | Date | null; scope?: GraphChangeScope; limit?: number },
  kinds: readonly EventKind[]
): Promise<GraphChangePage> {
  const limit = Math.min(MAX_CHANGES_PAGE, Math.max(1, Number(input.limit ?? DEFAULT_CHANGES_PAGE)));
  const cur = input.after ? decodeChangeCursor(input.after) : null;
  const sinceAt = cur
    ? cur.at
    : toMicroIso(input.since ? new Date(input.since).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString());
  const sinceId = cur ? cur.id : "00000000-0000-0000-0000-000000000000";
  const under = (input.scope?.under ?? []).filter((id) => ID_RE.test(id)).slice(0, MAX_SCOPE_IDS);
  const tagIds = (input.scope?.tagIds ?? []).filter((id) => ID_RE.test(id)).slice(0, MAX_SCOPE_TAGS);
  const scoped = under.length > 0 || tagIds.length > 0;
  const rows = await rawQuery<EventRow>(
    `WITH RECURSIVE beneath AS (
       SELECT unnest($3::uuid[]) AS id
       UNION
       SELECT cr.child_claim_id FROM claim_relationships cr JOIN beneath b ON cr.parent_claim_id = b.id
     ),
     ev AS (
       SELECT al.id, al.created_at AS at, 'work_commissioned'::text AS kind, al.claim_id,
              concat((al.amount_micro_usd / 1e6)::float8, ' owls, by ', al.commissioned_by) AS summary
         -- From the table, under the label policies: a commission is an
         -- event for the readers of the label it was placed at. The money
         -- views show every label's, and are for sums, not for a feed.
         FROM action_allocations al
        WHERE al.commissioned_by IS NOT NULL AND al.claim_id IS NOT NULL AND 'work_commissioned' = ANY($6)
       UNION ALL
       SELECT a.id, a.updated_at, 'run_finished', a.claim_id,
              concat(a.kind, ', spent ', round((COALESCE(a.metered_cost_micro_usd, 0) / 1e6)::numeric, 3)::float8, ' owls')
         FROM actions a
        WHERE a.status = 'done' AND a.claim_id IS NOT NULL AND 'run_finished' = ANY($6)
       UNION ALL
       SELECT m.id, m.created_at, 'message_arrived', m.node_id, concat(m.trigger, ' from ', m.sender_kind, CASE WHEN m.paid THEN ', paid' ELSE '' END)
         FROM node_messages m
        WHERE m.trigger <> 'message_reply' AND 'message_arrived' = ANY($6)
       UNION ALL
       SELECT m.id, m.answered_at, 'message_answered', m.node_id, concat(m.trigger, ': ', m.outcome)
         FROM node_messages m
        WHERE m.answered_at IS NOT NULL AND 'message_answered' = ANY($6)
       UNION ALL
       SELECT r.id, r.reviewed_at, 'contribution_accepted', c.claim_id, c.contribution_type
         FROM contribution_reviews r JOIN contributions c ON c.id = r.contribution_id
        WHERE r.decision = 'accept' AND NOT r.superseded AND c.claim_id IS NOT NULL AND 'contribution_accepted' = ANY($6)
       UNION ALL
       SELECT x.id, x.arbitrated_at, 'ruling', c.claim_id, concat(x.outcome, ': ', x.decision)
         FROM arbitration_results x JOIN contributions c ON c.id = x.contribution_id
        WHERE c.claim_id IS NOT NULL AND 'ruling' = ANY($6)
       UNION ALL
       SELECT p.id, p.decided_at, 'petition_decided', p.requester_node_id,
              concat(p.kind, ' ', p.status, CASE WHEN p.granted_micro_usd IS NOT NULL THEN concat(', ', (p.granted_micro_usd / 1e6)::float8, ' owls') ELSE '' END)
         FROM petitions p
        WHERE p.decided_at IS NOT NULL AND p.requester_node_id IS NOT NULL AND 'petition_decided' = ANY($6)
       UNION ALL
       SELECT q.id, q.created_at, 'request_filed', q.keeper_claim_id, left(q.ask, 200)
         FROM requests q
        WHERE q.keeper_claim_id IS NOT NULL AND 'request_filed' = ANY($6)
       UNION ALL
       SELECT s.id, s.created_at, 'state_changed', s.claim_id,
              left(concat(s.from_state, ' -> ', s.to_state, ' by ', s.actor, ': ', s.reason,
                          CASE WHEN cardinality(s.successor_ids) > 0
                               THEN concat(' (successors: ', array_to_string(s.successor_ids, ', '), ')') ELSE '' END), 500)
         FROM claim_state_changes s
        WHERE 'state_changed' = ANY($6)
     )
     SELECT ev.id, to_char(ev.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, ev.kind,
            ev.claim_id, left(c.text, 240) AS claim_text, ev.summary
       FROM ev JOIN claims c ON c.id = ev.claim_id
      WHERE (ev.at, ev.id) > ($1::timestamptz, $2::uuid)
        AND (NOT $5::boolean
             OR ev.claim_id IN (SELECT id FROM beneath)
             OR EXISTS (SELECT 1 FROM taggings tg
                         WHERE tg.subject_kind = 'claim' AND tg.subject_id = ev.claim_id
                           AND tg.tag_id = ANY($4::uuid[])))
      ORDER BY ev.at ASC, ev.id ASC
      LIMIT $7`,
    [sinceAt, sinceId, under, tagIds, scoped, [...kinds], limit + 1]
  );
  const page = rows.slice(0, limit);
  const changes: GraphChange[] = page.map((r) => ({
    change_id: r.id,
    at: r.at,
    claim_id: r.claim_id,
    claim_text: r.claim_text,
    kind: r.kind,
    summary: r.summary ?? undefined,
    status: null,
    prev_status: null,
    confidence: 0,
    credence: null,
    prev_credence: null,
    credence_delta: null,
    status_steps: null,
    trigger: null,
    page_url: pageUrl(r.claim_id),
    cursor: encodeChangeCursor(r.at, r.id),
  }));
  const last = page.at(-1);
  return {
    changes,
    next_cursor: last ? encodeChangeCursor(last.at, last.id) : input.after ?? encodeChangeCursor(sinceAt, sinceId),
    has_more: rows.length > limit,
  };
}

/** Verdict changes: an assessment against the one before it. */
async function listVerdictChanges(
  input: {
    after?: string | null;
    since?: string | Date | null;
    scope?: GraphChangeScope;
    minCredenceDelta?: number;
    materialOnly?: boolean;
    limit?: number;
  },
  wanted: Set<GraphChangeKind>
): Promise<GraphChangePage> {
  const limit = Math.min(MAX_CHANGES_PAGE, Math.max(1, Math.round(Number(input.limit ?? DEFAULT_CHANGES_PAGE)) || DEFAULT_CHANGES_PAGE));
  const minDelta = Math.min(
    1,
    Math.max(0, Number.isFinite(Number(input.minCredenceDelta)) && input.minCredenceDelta !== undefined
      ? Number(input.minCredenceDelta)
      : loadConfig().monitorMaterialCredenceDelta)
  );
  const materialOnly = input.materialOnly !== false;
  const cur = input.after ? decodeChangeCursor(input.after) : null;
  const sinceAt = cur
    ? cur.at
    : toMicroIso(
        input.since ? new Date(input.since).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString()
      );
  const sinceId = cur ? cur.id : "00000000-0000-0000-0000-000000000000";
  const under = (input.scope?.under ?? []).filter((id) => ID_RE.test(id)).slice(0, MAX_SCOPE_IDS);
  const tagIds = (input.scope?.tagIds ?? []).filter((id) => ID_RE.test(id)).slice(0, MAX_SCOPE_TAGS);
  const scoped = under.length > 0 || tagIds.length > 0;

  // Scan in batches so a run of minor reassessments does not starve the page.
  const batch = Math.max(limit * 2, 100);
  const maxScanned = batch * 10;
  const out: GraphChange[] = [];
  let posAt = sinceAt;
  let posId = sinceId;
  let scanned = 0;
  let exhausted = false;
  while (out.length < limit && scanned < maxScanned) {
    const rows = await rawQuery<ChangeRow>(
      `WITH RECURSIVE beneath AS (
         SELECT unnest($3::uuid[]) AS id
         UNION
         SELECT cr.child_claim_id FROM claim_relationships cr JOIN beneath b ON cr.parent_claim_id = b.id
       )
       SELECT a.id,
              to_char(a.assessed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
              a.claim_id, left(c.text, 240) AS claim_text, a.status, a.confidence,
              a.claim_credence AS credence, a.trigger,
              (p.id IS NOT NULL) AS has_prev, p.status AS prev_status, p.claim_credence AS prev_credence
         FROM assessments a
         JOIN claims c ON c.id = a.claim_id
         LEFT JOIN LATERAL (
           SELECT p.id, p.status, p.claim_credence FROM assessments p
            WHERE p.claim_id = a.claim_id AND (p.assessed_at, p.id) < (a.assessed_at, a.id)
            ORDER BY p.assessed_at DESC, p.id DESC LIMIT 1
         ) p ON true
        WHERE (a.assessed_at, a.id) > ($1::timestamptz, $2::uuid)
          AND c.state = 'active'
          AND (NOT $5::boolean
               OR a.claim_id IN (SELECT id FROM beneath)
               OR EXISTS (SELECT 1 FROM taggings tg
                           WHERE tg.subject_kind = 'claim' AND tg.subject_id = a.claim_id
                             AND tg.tag_id = ANY($4::uuid[])))
        ORDER BY a.assessed_at ASC, a.id ASC
        LIMIT $6`,
      [posAt, posId, under, tagIds, scoped, batch]
    );
    let consumed = 0;
    for (const r of rows) {
      scanned++;
      consumed++;
      posAt = r.at;
      posId = r.id;
      const credence = r.credence === null ? null : Number(r.credence);
      const prevCredence = r.prev_credence === null ? null : Number(r.prev_credence);
      const kind = classifyChange(
        { status: r.status, prev_status: r.prev_status, credence, prev_credence: prevCredence, has_prev: r.has_prev },
        minDelta,
        materialOnly
      );
      if (!kind || !wanted.has(kind)) continue;
      out.push({
        change_id: r.id,
        at: r.at,
        claim_id: r.claim_id,
        claim_text: r.claim_text,
        kind,
        status: r.status,
        prev_status: r.prev_status,
        confidence: Number(r.confidence),
        credence,
        prev_credence: prevCredence,
        credence_delta:
          credence !== null && prevCredence !== null ? Math.round((credence - prevCredence) * 1000) / 1000 : null,
        status_steps: statusSteps(r.prev_status, r.status),
        trigger: r.trigger,
        page_url: pageUrl(r.claim_id),
        cursor: encodeChangeCursor(r.at, r.id),
      });
      if (out.length >= limit) break;
    }
    // The stream ran out: this batch was short and every row in it was read.
    if (rows.length < batch && consumed === rows.length) {
      exhausted = true;
      break;
    }
  }
  return {
    changes: out,
    // Always resumable: the position after the last row scanned, which is the
    // last change returned when the page filled.
    next_cursor: encodeChangeCursor(posAt, posId),
    has_more: !exhausted,
  };
}

/** Resolve tag slugs to ids; an unknown slug resolves to nothing. */
export async function resolveTagSlugs(slugs: string[]): Promise<{ ids: string[]; unknown: string[] }> {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const slug of slugs.slice(0, MAX_SCOPE_TAGS)) {
    const tag = await resolveTagBySlug(String(slug));
    if (tag) ids.push(tag.id);
    else unknown.push(String(slug));
  }
  return { ids, unknown };
}

/**
 * Run the read from a tool's or a route's input. An unknown tag matches
 * nothing, as search_claims's does: a call naming only unknown tags returns
 * no changes rather than the whole graph's.
 */
export async function runGraphChanges(input: Record<string, unknown>): Promise<
  | { ok: true; payload: GraphChangePage & { unknown_tags?: string[] } }
  | { ok: false; code: string; message: string }
> {
  const after = typeof input.after === "string" && input.after ? input.after : null;
  if (after && !decodeChangeCursor(after)) {
    return { ok: false, code: "BAD_CURSOR", message: "after must be a cursor exactly as a previous result gave it" };
  }
  const since = typeof input.since === "string" && input.since ? input.since : null;
  if (since && Number.isNaN(Date.parse(since))) {
    return { ok: false, code: "BAD_SINCE", message: "since must be an ISO date-time" };
  }
  const under = Array.isArray(input.under) ? input.under.map(String) : [];
  const badId = under.find((id) => !ID_RE.test(id));
  if (badId) return { ok: false, code: "BAD_ID", message: `under: "${badId}" is not a node id` };
  const slugs = Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean) : [];
  const { ids: tagIds, unknown } = await resolveTagSlugs(slugs);
  if (slugs.length > 0 && tagIds.length === 0 && under.length === 0) {
    return { ok: true, payload: { changes: [], next_cursor: after, has_more: false, unknown_tags: unknown } };
  }
  const page = await listGraphChanges({
    after,
    since,
    scope: { under, tagIds },
    minCredenceDelta: input.min_credence_delta === undefined ? undefined : Number(input.min_credence_delta),
    materialOnly: input.material_only !== false,
    kinds: Array.isArray(input.kinds)
      ? (input.kinds.map(String).filter((k) => (GRAPH_CHANGE_KINDS as readonly string[]).includes(k)) as GraphChangeKind[])
      : undefined,
    limit: input.limit === undefined ? undefined : Number(input.limit),
  });
  return { ok: true, payload: unknown.length > 0 ? { ...page, unknown_tags: unknown } : page };
}
