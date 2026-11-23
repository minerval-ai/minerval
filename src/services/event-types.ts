/**
 * The events an outside client can follow, and reading them from a position
 * (docs/events.md).
 *
 * An event type is a name, the arguments that narrow it, and the payload
 * each occurrence carries. There are two, and both are windows on reads the
 * graph already serves: `graph.change` is the change stream
 * (graph-change-service.ts), entry for entry and cursor for cursor, and
 * `correspondent.update` is a Correspondent publishing
 * (correspondent-service.ts). Payloads are ids and summaries, never a whole
 * node or an update's body: the reader opens what matters with the reads it
 * already has.
 *
 * Defined once and served the same way to every door: REST
 * (routes/events.ts), the MCP tools generated from those routes, the MCP
 * Events extension's own methods (mcp/events.ts), and the webhook
 * deliveries (event-webhook-service.ts), which read through `pollEvents`
 * exactly as a poll does. A webhook therefore carries what a poll would.
 *
 * Reading is held to the caller's clearance by the database, as every read
 * is, so this file asks nothing about labels.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { getCorrespondent } from "./correspondent-service.js";
import {
  decodeChangeCursor,
  encodeChangeCursor,
  graphChangeDefinition,
  MAX_CHANGES_PAGE,
  runGraphChanges,
  toMicroIso,
} from "./graph-change-service.js";

export const EVENT_NAMES = ["graph.change", "correspondent.update"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type DeliveryMode = "poll" | "webhook";

export interface EventTypeDescriptor {
  name: EventName;
  description: string;
  delivery: DeliveryMode[];
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  payloadSchema: { type: "object"; properties: Record<string, unknown> };
}

/** One thing that happened, as every delivery mode carries it. */
export interface EventOccurrence {
  /** The row that made the event: the same id whichever way it is delivered, so a reader can drop a repeat. */
  eventId: string;
  name: EventName;
  timestamp: string;
  data: Record<string, unknown>;
  /** The position after this event. */
  cursor: string;
}

export interface EventPage {
  events: EventOccurrence[];
  /** The position to read on from; kept by the reader, also when nothing happened. */
  cursor: string;
  /** Reading started later than the cursor given: something may have been skipped. */
  truncated: boolean;
  hasMore: boolean;
}

export type EventError = { ok: false; code: "INVALID_PARAMS" | "NOT_FOUND"; message: string; kind?: "event" };

/** How often a poll with nothing waiting is worth repeating. The graph moves in minutes, not seconds. */
export const NEXT_POLL_MS = 60_000;
export const DEFAULT_EVENTS_PAGE = 50;
export const MAX_EVENTS_PAGE = MAX_CHANGES_PAGE;

const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The position "now": nothing before it is read. */
export function cursorNow(now: Date = new Date()): string {
  return encodeChangeCursor(toMicroIso(now.toISOString()), ZERO_ID);
}

function webBase(): string {
  return loadConfig().publicWebBaseUrl.replace(/\/$/, "");
}

/** The event types, with the delivery modes this deployment offers for them. */
export function eventTypes(modes: DeliveryMode[] = ["poll", "webhook"]): EventTypeDescriptor[] {
  const changes = graphChangeDefinition("caller").input_schema.properties;
  return [
    {
      name: "graph.change",
      description:
        "Something moved on the graph: by default a material change to a node's verdict (its first " +
        "assessment, its status moving on the ladder, its credence moving by at least min_credence_delta). " +
        "The same entries, filters and cursor as list_graph_changes, so a position moves freely between the " +
        "two. Each event is ids and a line of text; open the node with get_claim.",
      delivery: modes,
      inputSchema: {
        type: "object",
        properties: {
          under: changes.under,
          tags: changes.tags,
          kinds: changes.kinds,
          min_credence_delta: changes.min_credence_delta,
          material_only: changes.material_only,
        },
        additionalProperties: false,
      },
      payloadSchema: {
        type: "object",
        properties: {
          change_id: { type: "string" },
          claim_id: { type: "string" },
          claim_text: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          status: { type: ["string", "null"] },
          prev_status: { type: ["string", "null"] },
          confidence: { type: "number" },
          credence: { type: ["number", "null"] },
          prev_credence: { type: ["number", "null"] },
          credence_delta: { type: ["number", "null"] },
          status_steps: { type: ["integer", "null"] },
          trigger: { type: ["string", "null"] },
          page_url: { type: "string" },
        },
      },
    },
    {
      name: "correspondent.update",
      description:
        "A Correspondent published an update for its readers. Each event is the update's id, title and " +
        "addresses, not its body; read it with list_correspondent_updates.",
      delivery: modes,
      inputSchema: {
        type: "object",
        properties: {
          correspondent_id: { type: "string", format: "uuid", description: "The Correspondent to follow (list_correspondents)" },
        },
        required: ["correspondent_id"],
        additionalProperties: false,
      },
      payloadSchema: {
        type: "object",
        properties: {
          update_id: { type: "string" },
          correspondent_id: { type: "string" },
          mandate_id: { type: "string" },
          title: { type: "string" },
          items: { type: "integer", description: "How many nodes the update draws attention to" },
          page_url: { type: "string" },
          feed_url: { type: "string" },
        },
      },
    },
  ];
}

const GRAPH_ARGUMENTS = ["under", "tags", "kinds", "min_credence_delta", "material_only"] as const;

/**
 * A subscription's arguments checked against its event type, cleaned to
 * what the type takes, or what is wrong with them. Arguments the type does
 * not take are refused, not dropped: two subscriptions that differ only in
 * an argument that does nothing would otherwise look like two.
 */
export function validateArguments(
  name: unknown,
  raw: unknown
): { ok: true; name: EventName; arguments: Record<string, unknown> } | EventError {
  if (typeof name !== "string" || !(EVENT_NAMES as readonly string[]).includes(name)) {
    return { ok: false, code: "NOT_FOUND", kind: "event", message: `No event type "${String(name)}". The types are: ${EVENT_NAMES.join(", ")}.` };
  }
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, code: "INVALID_PARAMS", message: "arguments must be an object." };
  }
  const args = (raw ?? {}) as Record<string, unknown>;
  const bad = (message: string): EventError => ({ ok: false, code: "INVALID_PARAMS", message });
  const eventName = name as EventName;
  if (eventName === "correspondent.update") {
    const extra = Object.keys(args).find((k) => k !== "correspondent_id");
    if (extra) return bad(`correspondent.update takes correspondent_id only, not "${extra}".`);
    if (typeof args.correspondent_id !== "string" || !UUID_RE.test(args.correspondent_id)) {
      return bad("correspondent.update needs correspondent_id, a Correspondent's id.");
    }
    return { ok: true, name: eventName, arguments: { correspondent_id: args.correspondent_id.toLowerCase() } };
  }
  const extra = Object.keys(args).find((k) => !(GRAPH_ARGUMENTS as readonly string[]).includes(k));
  if (extra) return bad(`graph.change takes ${GRAPH_ARGUMENTS.join(", ")}, not "${extra}".`);
  const out: Record<string, unknown> = {};
  const def = graphChangeDefinition("caller").input_schema.properties as Record<string, { maxItems?: number; items?: { enum?: string[] } }>;
  for (const key of ["under", "tags", "kinds"] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return bad(`${key} must be a list of strings.`);
    const max = def[key]?.maxItems;
    if (max !== undefined && v.length > max) return bad(`${key} takes at most ${max}.`);
    if (key === "under" && v.some((id) => !UUID_RE.test(id))) return bad("under must be node ids.");
    const allowed = def[key]?.items?.enum;
    if (allowed && v.some((k) => !allowed.includes(k))) return bad(`kinds must be some of: ${allowed.join(", ")}.`);
    // Sorted, so the same set in another order is the same subscription.
    if (v.length > 0) out[key] = [...new Set(v.map((x) => (key === "under" ? x.toLowerCase() : x)))].sort();
  }
  if (args.min_credence_delta !== undefined) {
    const n = Number(args.min_credence_delta);
    if (typeof args.min_credence_delta !== "number" || Number.isNaN(n) || n < 0 || n > 1) {
      return bad("min_credence_delta must be a number from 0 to 1.");
    }
    out.min_credence_delta = n;
  }
  if (args.material_only !== undefined) {
    if (typeof args.material_only !== "boolean") return bad("material_only must be true or false.");
    // The default is left out, for the same reason the lists are sorted.
    if (args.material_only === false) out.material_only = false;
  }
  return { ok: true, name: eventName, arguments: out };
}

export interface PollInput {
  name: unknown;
  arguments?: unknown;
  /** A position from an earlier result. Null or absent: from now. */
  cursor?: string | null;
  /** Do not read back further than this, whatever the cursor says. */
  maxAgeMs?: number | null;
  maxEvents?: number | null;
}

/**
 * Events of one type after a position, oldest first. With no cursor the
 * answer is no events and the position "now": following starts when it is
 * asked for, and what happened before is read with the ordinary reads.
 */
export async function pollEvents(input: PollInput): Promise<{ ok: true; page: EventPage } | EventError> {
  const checked = validateArguments(input.name, input.arguments);
  if (!checked.ok) return checked;
  const bad = (message: string): EventError => ({ ok: false, code: "INVALID_PARAMS", message });
  if (input.cursor != null && (typeof input.cursor !== "string" || !decodeChangeCursor(input.cursor))) {
    return bad("cursor must be a cursor exactly as an earlier result gave it, or null to start from now.");
  }
  if (input.maxAgeMs != null && (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0)) {
    return bad("maxAgeMs must be a number of milliseconds, 0 or more.");
  }
  if (input.maxEvents != null && (!Number.isInteger(input.maxEvents) || input.maxEvents < 1)) {
    return bad("maxEvents must be a whole number, 1 or more.");
  }
  if (checked.name === "correspondent.update") {
    // Read at the caller's clearance: one it may not read does not exist for it.
    const c = await getCorrespondent(String(checked.arguments.correspondent_id));
    if (!c) return { ok: false, code: "INVALID_PARAMS", message: "correspondent_id names no Correspondent." };
  }
  if (input.cursor == null) {
    return { ok: true, page: { events: [], cursor: cursorNow(), truncated: false, hasMore: false } };
  }
  let cursor = input.cursor;
  let truncated = false;
  if (input.maxAgeMs != null) {
    const floor = toMicroIso(new Date(Date.now() - input.maxAgeMs).toISOString());
    if (decodeChangeCursor(cursor)!.at < floor) {
      cursor = encodeChangeCursor(floor, ZERO_ID);
      truncated = true;
    }
  }
  const limit = Math.min(MAX_EVENTS_PAGE, input.maxEvents ?? DEFAULT_EVENTS_PAGE);
  const page =
    checked.name === "graph.change"
      ? await graphChangePage(checked.arguments, cursor, limit)
      : await correspondentUpdatePage(String(checked.arguments.correspondent_id), cursor, limit);
  if (!page.ok) return page;
  return { ok: true, page: { ...page.page, truncated } };
}

type PageResult = { ok: true; page: Omit<EventPage, "truncated"> } | EventError;

async function graphChangePage(args: Record<string, unknown>, cursor: string, limit: number): Promise<PageResult> {
  const result = await runGraphChanges({ ...args, after: cursor, limit });
  if (!result.ok) return { ok: false, code: "INVALID_PARAMS", message: result.message };
  const { changes, next_cursor, has_more } = result.payload;
  return {
    ok: true,
    page: {
      events: changes.map((change) => {
        const { cursor: position, at, ...data } = change;
        return { eventId: change.change_id, name: "graph.change" as const, timestamp: at, data, cursor: position };
      }),
      cursor: next_cursor ?? cursor,
      hasMore: has_more,
    },
  };
}

async function correspondentUpdatePage(correspondentId: string, cursor: string, limit: number): Promise<PageResult> {
  const at = decodeChangeCursor(cursor)!;
  const rows = await rawQuery<{ id: string; grant_id: string; title: string; items: number; at: string }>(
    `SELECT id, grant_id, title, jsonb_array_length(COALESCE(items, '[]'::jsonb))::int AS items,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM correspondent_updates
      WHERE correspondent_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
      ORDER BY created_at, id LIMIT $4`,
    [correspondentId, at.at, at.id, limit + 1]
  );
  const page = rows.slice(0, limit);
  const base = webBase();
  const api = loadConfig().publicApiBaseUrl.replace(/\/$/, "");
  const events = page.map((u) => ({
    eventId: u.id,
    name: "correspondent.update" as const,
    timestamp: u.at,
    data: {
      update_id: u.id,
      correspondent_id: correspondentId,
      mandate_id: u.grant_id,
      title: u.title,
      items: Number(u.items),
      page_url: `${base}/correspondents/${correspondentId}`,
      feed_url: `${api}/correspondents/${correspondentId}/feed`,
    },
    cursor: encodeChangeCursor(u.at, u.id),
  }));
  return { ok: true, page: { events, cursor: events.at(-1)?.cursor ?? cursor, hasMore: rows.length > limit } };
}
