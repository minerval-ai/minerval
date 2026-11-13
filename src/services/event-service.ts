/**
 * The event log: one append-only row per thing that happened which someone
 * may want to be told of (schema.ts, `events`). Code that makes a change
 * records it here, with the refs it touches, and the subscription router
 * (subscription-router.ts) reads the log in order, on the engine executor's
 * tick, and delivers each event to the subscriptions that match it. Recording never fails the change it
 * describes: a write that cannot be logged is reported and the change
 * stands.
 */
import { rawQuery, type TxQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";

/** What can happen. Each kind names the refs it carries. */
export const EVENT_KINDS = [
  /** A ledger run settled (done): action, node, the mandates that paid. */
  "run_settled",
  /** A ledger row closed without running (cancelled or superseded). */
  "run_closed",
  /** A petition was decided: grant (mandate), petition, action, node. */
  "petition_decided",
  /** An officer sent a petition or an item to the Grantmaker. */
  "escalated",
  /** Something was raised to a mandate's inbox: grant, node, item. */
  "inbox_item",
  /** A node's assessment was written: node, status before and after. */
  "assessed",
  /** A source was retracted, corrected or superseded: source. */
  "source_event",
  /** A Steward answered a message: node, message, the sender's node. */
  "message_answered",
  /** A mandate's operating policy, pace, reserve or terms changed: grant. */
  "mandate_changed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventInput {
  kind: EventKind;
  nodeId?: string | null;
  actionId?: string | null;
  grantId?: string | null;
  sourceId?: string | null;
  /** Any other refs: petition, research_run, request, lookout, correspondent, session, item. */
  refs?: Record<string, string | string[] | null | undefined>;
  /** One line a subscriber reads: what happened, where. */
  summary: string;
  payload?: Record<string, unknown>;
}

export interface EventRow {
  seq: number;
  at: string;
  kind: EventKind;
  node_id: string | null;
  action_id: string | null;
  grant_id: string | null;
  source_id: string | null;
  refs: Record<string, unknown>;
  summary: string;
  payload: Record<string, unknown>;
  sensitivity_label: string;
}

export const EVENT_COLUMNS = `seq::bigint AS seq, at::text AS at, kind, node_id, action_id, grant_id, source_id,
  refs, summary, payload, sensitivity_label`;

/** Record an event; returns its sequence number, or null when it could not be logged. */
export async function recordEvent(input: EventInput, tx?: TxQuery): Promise<number | null> {
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const refs = Object.fromEntries(Object.entries(input.refs ?? {}).filter(([, v]) => v != null));
  try {
    const [row] = await q<{ seq: string }>(
      `INSERT INTO events (kind, node_id, action_id, grant_id, source_id, refs, summary, payload, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
       RETURNING seq`,
      [
        input.kind,
        input.nodeId ?? null,
        input.actionId ?? null,
        input.grantId ?? null,
        input.sourceId ?? null,
        JSON.stringify(refs),
        input.summary.slice(0, 2000),
        JSON.stringify(input.payload ?? {}),
        currentLabel(),
      ]
    );
    return row ? Number(row.seq) : null;
  } catch (err) {
    console.warn(`[events] could not record ${input.kind}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Events after a cursor, oldest first. */
export async function eventsAfter(seq: number, limit = 200): Promise<EventRow[]> {
  return rawQuery<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`,
    [seq, limit]
  );
}
