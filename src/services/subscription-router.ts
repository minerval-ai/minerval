/**
 * The subscription router: reads the event log (event-service.ts) in order
 * from where it last stopped and delivers each event to every active
 * subscription whose filter it matches (subscription-service.ts); and, on
 * each tick, delivers the scheduled check-ins that are due and the money
 * thresholds that have been crossed. Plain code with no model in it.
 *
 * Delivery depends on the subscriber:
 *  - a session: the event is an answer in its transcript (deliverReply),
 *    shown in its next tool result if it is running; a `wake` delivery
 *    resumes it if it is paused, a `queue` one waits for its next turn;
 *  - a mandate's inbox: an item its program officers read.
 * Where a deployment holds material at more than one label, the router is
 * system work: it runs on the engine's tick, which sees every label
 * (src/workers/local-runner.ts), so it finds events and subscriptions at
 * all of them. What reaches a subscriber is held to what the subscriber's
 * own label reads, in three ways. An event recorded at a label the
 * subscriber's label does not read is not delivered and nothing is said of
 * it: that something happened on a node at another label is itself what
 * that label keeps. Whether an event matches a filter that asks about the
 * graph (under, over, tags) is asked at the subscriber's label, so an edge
 * or a tag the subscriber cannot read matches nothing. And each delivery is
 * written at the subscriber's label, from there (runAtLabel). The
 * subscriber's label is the subscription's: a subscription is made by the
 * run that wants it, at that run's label.
 */
import { rawQuery } from "../db/client.js";
import { runAtLabel } from "../llm/usage-context.js";
import { labelsReadableFrom } from "./permission-service.js";
import { EVENT_COLUMNS, type EventRow } from "./event-service.js";
import { matches, type SubscriptionRow } from "./subscription-service.js";
import { committedWithinMicroUsd } from "./pace-service.js";

const SUB_COLUMNS = `id, subscriber_kind, subscriber_ref, filter, condition, due_at::text AS due_at, delivery, once,
  reason, created_by, active, deliveries, created_at::text AS created_at, sensitivity_label`;

/** A subscription with the label it was made at, which is its subscriber's. */
type RoutedSubscription = SubscriptionRow & { sensitivity_label: string };

/** Run `fn` at the subscriber's label: what it reads and writes is held to that label. */
function atSubscriber<T>(s: RoutedSubscription, fn: () => Promise<T>): Promise<T> {
  return runAtLabel(s.sensitivity_label, `subscription ${s.id}`, fn);
}

let routing: Promise<number> | null = null;

/** Route what is new on the log; one router at a time in this process, and one across processes by lock. */
export async function routeEvents(): Promise<number> {
  if (routing) return routing;
  routing = (async () => {
    try {
      return await routeOnce();
    } finally {
      routing = null;
    }
  })();
  return routing;
}

async function routeOnce(): Promise<number> {
  let delivered = 0;
  await rawQuery(`INSERT INTO event_router_state (id, last_seq) VALUES (1, 0) ON CONFLICT DO NOTHING`);
  for (;;) {
    // Claim the next batch by moving the cursor past it in one statement, so
    // two routers (two processes) never deliver the same event: each reads
    // only the range it moved the cursor over.
    const [claim] = await rawQuery<{ from_seq: string; to_seq: string }>(
      `WITH cur AS (SELECT last_seq FROM event_router_state WHERE id = 1 FOR UPDATE),
            nxt AS (SELECT max(seq) AS m FROM (SELECT e.seq FROM events e, cur WHERE e.seq > cur.last_seq
                                                ORDER BY e.seq LIMIT 200) x)
       UPDATE event_router_state s SET last_seq = nxt.m, updated_at = now()
         FROM cur, nxt WHERE s.id = 1 AND nxt.m IS NOT NULL
       RETURNING cur.last_seq AS from_seq, nxt.m AS to_seq`
    );
    if (!claim) break;
    const batch = await rawQuery<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq`,
      [claim.from_seq, claim.to_seq]
    );
    const subs = await rawQuery<RoutedSubscription>(
      `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE active AND due_at IS NULL AND condition IS NULL`
    );
    // What each subscriber's label reads, asked once for the batch.
    const reads = new Map<string, Set<string>>();
    for (const label of new Set(subs.map((s) => s.sensitivity_label))) {
      reads.set(label, new Set(await labelsReadableFrom([label])));
    }
    for (const e of batch) {
      // The graph as each label reads it, cached for this event.
      const graphs = new Map<string, ReturnType<typeof graphFor>>();
      for (const s of subs) {
        if (!s.active) continue;
        if (!reads.get(s.sensitivity_label)?.has(e.sensitivity_label)) continue;
        const took = await atSubscriber(s, async () => {
          if (!graphs.has(s.sensitivity_label)) graphs.set(s.sensitivity_label, graphFor());
          if (!(await matches(e, s.filter ?? {}, graphs.get(s.sensitivity_label)!))) return false;
          return deliver(s, e);
        }).catch(() => false);
        if (took) delivered++;
      }
    }
  }
  delivered += await deliverDue();
  return delivered;
}

/** Scheduled check-ins that are due, and thresholds that have been crossed. */
async function deliverDue(): Promise<number> {
  let n = 0;
  const due = await rawQuery<RoutedSubscription>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE active AND due_at IS NOT NULL AND due_at <= now()`
  );
  for (const s of due) {
    if (!(await claimEnd(s.id))) continue; // another router took it
    const text = `The time you set has come (${s.due_at!.slice(0, 16).replace("T", " ")} UTC).`;
    if (await atSubscriber(s, () => deliver({ ...s, once: false }, null, text))) n++;
  }
  const conditions = await rawQuery<RoutedSubscription>(`SELECT ${SUB_COLUMNS} FROM subscriptions WHERE active AND condition IS NOT NULL`);
  for (const s of conditions) {
    const c = s.condition!;
    if (c.kind === "work_settled") {
      // Counted and delivered at the subscriber's label, as every delivery
      // is: the work counted is the work that label reads, and the note is
      // written there.
      const { mandateWorkInFlight } = await import("./action-service.js");
      if ((await atSubscriber(s, () => mandateWorkInFlight(c.grant_id))) > 0) continue;
      if (!(await claimEnd(s.id))) continue;
      const text = `All the work your mandate set going is settled: no pass, ingest or other run it commissioned is waiting to run or running, and no plan item is waiting for its ingests (set ${c.since.slice(0, 16).replace("T", " ")} UTC).`;
      if (await atSubscriber(s, () => deliver({ ...s, once: false }, null, text))) n++;
      continue;
    }
    if (c.kind !== "committed_owls") continue;
    const hours = Math.max(1, (Date.now() - new Date(c.since).getTime()) / 3_600_000);
    const committed = await committedWithinMicroUsd(c.grant_id, Math.ceil(hours));
    if (committed >= c.at_least_micro_usd) {
      if (!(await claimEnd(s.id))) continue;
      const text = `${committed / 1_000_000} owls have been committed since you set this (${c.since.slice(0, 16).replace("T", " ")} UTC), past the ${c.at_least_micro_usd / 1_000_000} you named.`;
      if (await atSubscriber(s, () => deliver({ ...s, once: false }, null, text))) n++;
    }
  }
  return n;
}

/** End a subscription only if still active; whether this call ended it. */
async function claimEnd(id: string): Promise<boolean> {
  const rows = await rawQuery(`UPDATE subscriptions SET active = false, ended_at = now() WHERE id = $1 AND active RETURNING id`, [id]);
  return rows.length > 0;
}

async function end(id: string): Promise<void> {
  await rawQuery(`UPDATE subscriptions SET active = false, ended_at = now() WHERE id = $1`, [id]);
}

/** The text a subscriber reads for one delivery. The event is one its label reads (routeOnce). */
function render(s: SubscriptionRow, e: EventRow | null, text: string | undefined): string {
  const head = `Your subscription ${s.id} (${s.reason})`;
  if (!e) return `${head}: ${text ?? "it has come due."}`;
  const body =
    `${e.kind} — ${e.summary}` +
    [e.action_id ? ` (run ${e.action_id})` : "", e.node_id ? ` (node ${e.node_id})` : ""].join("");
  return `${head}: ${body} [event ${e.seq}, ${e.at.slice(0, 16).replace("T", " ")} UTC]`;
}

/**
 * Deliver one event (or a due time or threshold) to one subscription;
 * whether it was taken. Called at the subscriber's label (atSubscriber),
 * with an event that label reads.
 */
async function deliver(s: SubscriptionRow, e: EventRow | null, text?: string): Promise<boolean> {
  let took = false;
  if (s.subscriber_kind === "session") {
    const [session] = await rawQuery<{ status: string }>(
      `SELECT status FROM agent_sessions WHERE id = $1`,
      [s.subscriber_ref]
    );
    if (!session || session.status === "closed" || session.status === "expired") {
      // The session is gone: so is its interest.
      await end(s.id);
      return false;
    }
    const { deliverReply } = await import("./session-service.js");
    const where = await deliverReply({
      sessionId: s.subscriber_ref,
      kind: "subscription",
      ref: e ? `${s.id}:${e.seq}` : `${s.id}:due`,
      text: render(s, e, text),
      fallback: null,
      wake: s.delivery === "wake",
    });
    took = where === "session";
  } else if (s.subscriber_kind === "mandate_inbox") {
    if (e && e.kind === "inbox_item" && e.grant_id === s.subscriber_ref) return false; // its own item
    const { raiseToMandate } = await import("./mandate-inbox-service.js");
    const raised = await raiseToMandate({
      grantId: s.subscriber_ref,
      kind: "subscription",
      targetNodeId: e?.node_id ?? null,
      targetRef: e?.action_id ?? null,
      source: "a subscription",
      summary: render(s, e, text),
      detail: { subscription_id: s.id, ...(e ? { event_seq: e.seq, event_kind: e.kind } : {}) },
    });
    took = Boolean(raised);
  } else {
    // node_inbox, lookout and correspondent deliveries are routed by their own services.
    const { deliverToAgentSink } = await import("./subscription-sinks.js");
    took = await deliverToAgentSink(s, e, render(s, e, text));
  }
  if (took) {
    await rawQuery(
      `UPDATE subscriptions SET deliveries = deliveries + 1, last_delivered_at = now(),
              active = CASE WHEN once THEN false ELSE active END,
              ended_at = CASE WHEN once THEN now() ELSE ended_at END
        WHERE id = $1`,
      [s.id]
    );
    if (s.once) s.active = false;
  }
  return took;
}

/** The graph questions a filter may ask, cached for one event. */
function graphFor() {
  const cache = new Map<string, Set<string>>();
  const walk = async (key: string, sql: string, nodeId: string) => {
    const k = `${key}:${nodeId}`;
    if (!cache.has(k)) {
      const rows = await rawQuery<{ id: string }>(sql, [nodeId]);
      cache.set(k, new Set(rows.map((r) => r.id)));
    }
    return cache.get(k)!;
  };
  return {
    ancestors: (nodeId: string) =>
      walk(
        "up",
        `WITH RECURSIVE up(id, depth) AS (
           SELECT parent_claim_id, 1 FROM claim_relationships WHERE child_claim_id = $1
           UNION SELECT cr.parent_claim_id, up.depth + 1 FROM claim_relationships cr JOIN up ON cr.child_claim_id = up.id
            WHERE up.depth < 50)
         SELECT DISTINCT id FROM up`,
        nodeId
      ),
    descendants: (nodeId: string) =>
      walk(
        "down",
        `WITH RECURSIVE down(id, depth) AS (
           SELECT child_claim_id, 1 FROM claim_relationships WHERE parent_claim_id = $1
           UNION SELECT cr.child_claim_id, down.depth + 1 FROM claim_relationships cr JOIN down ON cr.parent_claim_id = down.id
            WHERE down.depth < 50)
         SELECT DISTINCT id FROM down`,
        nodeId
      ),
    tags: (nodeId: string) =>
      walk(
        "tags",
        `SELECT t.slug AS id FROM taggings tg JOIN tags t ON t.id = tg.tag_id
          WHERE tg.subject_kind = 'claim' AND tg.subject_id = $1`,
        nodeId
      ),
  };
}
