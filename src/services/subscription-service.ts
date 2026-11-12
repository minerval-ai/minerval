/**
 * Subscriptions: a standing interest, held by a session, a mandate's inbox,
 * a node's inbox, a lookout or a correspondent, in events on the log
 * (event-service.ts), in a time (a scheduled check-in), or in a money
 * threshold. The subscription router (subscription-router.ts) delivers what
 * matches. Holding one costs nothing; a delivery that wakes a paused session
 * costs that session's resumption, paid like any other.
 *
 * A filter matches an event when every part it names matches (kinds, and at
 * least one of the refs it names): the event's run, its node, a node it sits
 * under, a node resting on it, its node's tags, its source, its mandate, or
 * another ref it carries (a petition, a research run, a request).
 */
import { rawQuery } from "../db/client.js";
import { EVENT_KINDS, type EventKind, type EventRow } from "./event-service.js";

export type SubscriberKind = "session" | "mandate_inbox" | "node_inbox" | "lookout" | "correspondent";

export interface SubscriptionFilter {
  kinds?: EventKind[];
  action_ids?: string[];
  node_ids?: string[];
  /** Events on these nodes or anything beneath them (their premises, subquestions…). */
  under?: string[];
  /** Events on the nodes resting on these: anything above them in the graph. */
  over?: string[];
  tags?: string[];
  source_ids?: string[];
  grant_ids?: string[];
  /** Other refs an event carries, by name: petition, research_run, request, item… */
  refs?: Record<string, string[]>;
}

/** A threshold the router evaluates on its tick. */
export type SubscriptionCondition = {
  kind: "committed_owls";
  grant_id: string;
  /** Wake once this much has been committed since `since`. */
  at_least_micro_usd: number;
  since: string;
};

export interface SubscriptionRow {
  id: string;
  subscriber_kind: SubscriberKind;
  subscriber_ref: string;
  filter: SubscriptionFilter;
  condition: SubscriptionCondition | null;
  due_at: string | null;
  delivery: "wake" | "queue";
  once: boolean;
  reason: string;
  created_by: string;
  active: boolean;
  deliveries: number;
  created_at: string;
}

const COLUMNS = `id, subscriber_kind, subscriber_ref, filter, condition, due_at::text AS due_at, delivery, once,
  reason, created_by, active, deliveries, created_at::text AS created_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEYS = ["action_ids", "node_ids", "under", "over", "source_ids", "grant_ids"] as const;
/** Ids a filter may name in one key: a subscription is about something, not everything. */
const MAX_IDS = 200;

/** A filter checked and cleaned, or what is wrong with it in words. */
export function validateFilter(raw: unknown): { ok: true; filter: SubscriptionFilter } | { ok: false; problem: string } {
  const f = (raw ?? {}) as Record<string, unknown>;
  const out: SubscriptionFilter = {};
  if (f.kinds !== undefined) {
    if (!Array.isArray(f.kinds) || f.kinds.some((k) => !(EVENT_KINDS as readonly string[]).includes(String(k)))) {
      return { ok: false, problem: `kinds must be some of: ${EVENT_KINDS.join(", ")}.` };
    }
    out.kinds = f.kinds.map(String) as EventKind[];
  }
  for (const key of ID_KEYS) {
    const v = f[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_IDS || v.some((x) => !UUID_RE.test(String(x)))) {
      return { ok: false, problem: `${key} must be a list of at most ${MAX_IDS} ids.` };
    }
    if (v.length) out[key] = v.map(String);
  }
  if (f.tags !== undefined) {
    if (!Array.isArray(f.tags) || f.tags.length > 20) return { ok: false, problem: "tags must be a list of at most 20 tag slugs." };
    if (f.tags.length) out.tags = f.tags.map(String);
  }
  if (f.refs !== undefined) {
    if (typeof f.refs !== "object" || f.refs === null) return { ok: false, problem: "refs is an object of ref name to ids." };
    const refs: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(f.refs as Record<string, unknown>)) {
      if (!Array.isArray(v) || v.length > MAX_IDS) return { ok: false, problem: `refs.${k} must be a list of ids.` };
      refs[k] = v.map(String);
    }
    if (Object.keys(refs).length) out.refs = refs;
  }
  return { ok: true, filter: out };
}

/** Whether a filter names any refs at all (one naming only kinds matches every event of those kinds). */
export function hasRefs(f: SubscriptionFilter): boolean {
  return ID_KEYS.some((k) => (f[k]?.length ?? 0) > 0) || (f.tags?.length ?? 0) > 0 || Object.keys(f.refs ?? {}).length > 0;
}

export async function createSubscription(input: {
  subscriberKind: SubscriberKind;
  subscriberRef: string;
  filter?: SubscriptionFilter;
  condition?: SubscriptionCondition | null;
  dueAt?: Date | string | null;
  delivery?: "wake" | "queue";
  once?: boolean;
  reason: string;
  createdBy: string;
}): Promise<SubscriptionRow> {
  const [row] = await rawQuery<SubscriptionRow>(
    `INSERT INTO subscriptions (subscriber_kind, subscriber_ref, filter, condition, due_at, delivery, once, reason, created_by)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.subscriberKind,
      input.subscriberRef,
      JSON.stringify(input.filter ?? {}),
      input.condition ? JSON.stringify(input.condition) : null,
      input.dueAt ? new Date(input.dueAt).toISOString() : null,
      input.delivery ?? "wake",
      input.once ?? false,
      input.reason.trim().slice(0, 500),
      input.createdBy,
    ]
  );
  return row!;
}

/** End a subscription; only its subscriber may. Returns whether one was ended. */
export async function endSubscription(id: string, subscriber: { kind: SubscriberKind; ref: string }): Promise<boolean> {
  const rows = await rawQuery(
    `UPDATE subscriptions SET active = false, ended_at = now()
      WHERE id = $1 AND subscriber_kind = $2 AND subscriber_ref = $3 AND active RETURNING id`,
    [id, subscriber.kind, subscriber.ref]
  );
  return rows.length > 0;
}

export async function listSubscriptions(subscriber: { kind: SubscriberKind; ref: string }): Promise<SubscriptionRow[]> {
  return rawQuery<SubscriptionRow>(
    `SELECT ${COLUMNS} FROM subscriptions
      WHERE subscriber_kind = $1 AND subscriber_ref = $2 AND active ORDER BY created_at`,
    [subscriber.kind, subscriber.ref]
  );
}

/** Whether a subscriber holds any subscription that would wake it (an event, a time, a threshold). */
export async function holdsWakingSubscription(subscriber: { kind: SubscriberKind; ref: string }): Promise<boolean> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM subscriptions
      WHERE subscriber_kind = $1 AND subscriber_ref = $2 AND active AND delivery = 'wake'`,
    [subscriber.kind, subscriber.ref]
  );
  return Number(row?.n ?? 0) > 0;
}

/** The earliest scheduled check-in a subscriber holds, if any. */
export async function nextDueAt(subscriber: { kind: SubscriberKind; ref: string }): Promise<Date | null> {
  const [row] = await rawQuery<{ due: string | null }>(
    `SELECT min(due_at)::text AS due FROM subscriptions
      WHERE subscriber_kind = $1 AND subscriber_ref = $2 AND active AND due_at IS NOT NULL`,
    [subscriber.kind, subscriber.ref]
  );
  return row?.due ? new Date(row.due) : null;
}

/** A subscription in a line, for an agent's briefing. */
export function describeSubscription(s: Pick<SubscriptionRow, "id" | "filter" | "condition" | "due_at" | "delivery" | "once" | "reason">): string {
  const parts: string[] = [];
  if (s.due_at) parts.push(`at ${s.due_at.slice(0, 16).replace("T", " ")} UTC`);
  if (s.condition?.kind === "committed_owls") {
    parts.push(`when ${s.condition.at_least_micro_usd / 1_000_000} owls more are committed`);
  }
  const f = s.filter ?? {};
  if (f.kinds?.length) parts.push(`events ${f.kinds.join(", ")}`);
  const refs: string[] = [];
  if (f.action_ids?.length) refs.push(`${f.action_ids.length} run(s)`);
  if (f.node_ids?.length) refs.push(`${f.node_ids.length} node(s)`);
  if (f.under?.length) refs.push(`beneath ${f.under.length} node(s)`);
  if (f.over?.length) refs.push(`resting on ${f.over.length} node(s)`);
  if (f.tags?.length) refs.push(`tags ${f.tags.join(", ")}`);
  if (f.source_ids?.length) refs.push(`${f.source_ids.length} source(s)`);
  if (f.grant_ids?.length) refs.push(`${f.grant_ids.length} mandate(s)`);
  for (const [k, v] of Object.entries(f.refs ?? {})) refs.push(`${v.length} ${k}(s)`);
  if (refs.length) parts.push(`on ${refs.join(", ")}`);
  return (
    `[${s.id}] ${parts.join("; ") || "everything"} — ${s.delivery === "wake" ? "wakes you" : "waits for your next turn"}` +
    `${s.once ? ", once" : ""}: ${s.reason}`
  );
}

/**
 * Whether an event matches a filter. `graph` answers the questions that need
 * the graph (a node's ancestors and descendants, its tags), asked only when
 * the filter names under, over or tags.
 */
export async function matches(
  e: EventRow,
  f: SubscriptionFilter,
  graph: { ancestors(nodeId: string): Promise<Set<string>>; descendants(nodeId: string): Promise<Set<string>>; tags(nodeId: string): Promise<Set<string>> }
): Promise<boolean> {
  if (f.kinds?.length && !f.kinds.includes(e.kind)) return false;
  if (!hasRefs(f)) return true;
  if (e.action_id && f.action_ids?.includes(e.action_id)) return true;
  if (e.node_id && f.node_ids?.includes(e.node_id)) return true;
  if (e.source_id && f.source_ids?.includes(e.source_id)) return true;
  if (e.grant_id && f.grant_ids?.includes(e.grant_id)) return true;
  for (const [k, ids] of Object.entries(f.refs ?? {})) {
    const v = e.refs?.[k];
    const vals = Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : [];
    if (vals.some((x) => ids.includes(x))) return true;
  }
  if (e.node_id && f.under?.length) {
    // Beneath a root: the root is the node itself or one of its ancestors.
    if (f.under.includes(e.node_id)) return true;
    const up = await graph.ancestors(e.node_id);
    if (f.under.some((r) => up.has(r))) return true;
  }
  if (e.node_id && f.over?.length) {
    // Resting on a node: that node sits beneath the event's node.
    const down = await graph.descendants(e.node_id);
    if (f.over.some((r) => down.has(r))) return true;
  }
  if (e.node_id && f.tags?.length) {
    const t = await graph.tags(e.node_id);
    if (f.tags.some((x) => t.has(x))) return true;
  }
  return false;
}
