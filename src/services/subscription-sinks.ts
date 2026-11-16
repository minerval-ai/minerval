/**
 * Deliveries to the subscribers that are not sessions or mandate inboxes:
 * a node's inbox (read by its Steward's next pass, never waking one), a
 * lookout's queued inputs, a correspondent's next run. Each lands where the
 * agent already reads its inputs, so nothing new has to be learned to read
 * it, and none of them starts a run by itself: the agent's own triggers and
 * heartbeat decide when it next runs.
 */
import { rawQuery } from "../db/client.js";
import type { EventRow } from "./event-service.js";
import type { SubscriptionRow } from "./subscription-service.js";

export async function deliverToAgentSink(s: SubscriptionRow, e: EventRow | null, text: string): Promise<boolean> {
  // Inboxes and queued inputs are read at their own labels. The router
  // calls this at the subscriber's label, with an event that label reads
  // (subscription-router.ts), so the message and the queued input below are
  // written there.
  if (s.subscriber_kind === "node_inbox") {
    const { postMessage } = await import("./inbox-service.js");
    await postMessage({
      nodeId: s.subscriber_ref,
      trigger: "subscription",
      body: text,
      sender: { kind: "system" },
    });
    return true;
  }
  if (s.subscriber_kind === "lookout") {
    const rows = await rawQuery(
      `INSERT INTO lookout_events (lookout_id, kind, payload, sensitivity_label)
       SELECT l.id, 'subscription', $2::jsonb, l.sensitivity_label FROM lookouts l WHERE l.id::text = $1 AND l.status = 'active'
       RETURNING id`,
      [s.subscriber_ref, JSON.stringify({ subscription_id: s.id, event_seq: e?.seq ?? null, event_kind: e?.kind ?? null, node_id: e?.node_id ?? null, text })]
    );
    return rows.length > 0;
  }
  return false;
}
