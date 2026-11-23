/**
 * Webhook subscriptions: an account asks for an event type to be POSTed to
 * an address of its own, and this delivers it (docs/events.md, "Webhook").
 *
 * A subscription is who asked, where it delivers, the event type and its
 * arguments. Asking again with the same four refreshes it. It always
 * expires unless refreshed, so one that is abandoned collects itself.
 *
 * How an event reaches the address:
 *
 *  - Something marks the subscription as having news. For changes to the
 *    graph that is the subscription router (subscription-router.ts): each
 *    subscription holds a row in `subscriptions` of kind `webhook`, and an
 *    event on the log that matches it sets `wake_at`. A Correspondent
 *    publishing marks its followers directly. A sweep every quarter hour
 *    marks nothing and reads anyway, for the kinds of change the log does
 *    not record.
 *  - `deliveryTick`, on the engine's tick, reads the event type from the
 *    subscription's cursor (event-types.ts, the read a poll makes) and POSTs
 *    what it finds, one event at a time and in order, moving the cursor past
 *    each one the address accepts. So the log is only the signal: what is
 *    sent is what a poll from the same position would return.
 *
 * What is read for a delivery is read at the label `public`, whatever the
 * account may read, and the account's standing is checked each time. A
 * callback address is outside the deployment, and what leaves a label for
 * outside goes through its gate (docs/the-gate.md), not through here. A
 * subscriber at a private label polls, which is a read at its own
 * clearance.
 *
 * A delivery that fails is tried again, five times over about a quarter
 * hour, and then given up: the cursor moves on and the stream continues. An
 * address that has failed for an hour is suspended until its owner
 * refreshes the subscription, which is also how they learn of it
 * (`deliveryStatus`).
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { PUBLIC_LABEL } from "../labels.js";
import { runAtLabel } from "../llm/usage-context.js";
import { membersOnly } from "../permissions.js";
import { credentialKeys, openCredential, sealCredential } from "./connection-credential.js";
import { type EventKind } from "./event-service.js";
import { cursorNow, pollEvents, validateArguments, type EventName, type EventOccurrence } from "./event-types.js";
import { decodeChangeCursor, encodeChangeCursor, toMicroIso } from "./graph-change-service.js";
import { resolveStanding } from "./permission-service.js";
import { createSubscription } from "./subscription-service.js";
import { callbackUrlProblem, sendWebhook, type DeliveryFailure, type WebhookSend } from "./webhook-sender.js";
import { challengeAnswered, deliveryHeaders, messageId, secretBytes, subscriptionId } from "./webhook-signing.js";

/** A subscription lives this long unless its owner says otherwise. */
export const DEFAULT_TTL_MS = 24 * 3_600_000;
/** The shortest life granted: shorter, and refreshing would be most of the traffic. */
export const MIN_TTL_MS = 5 * 60_000;
/** The longest life granted. None is granted without an end, so an abandoned subscription always collects itself. */
export const MAX_TTL_MS = 7 * 24 * 3_600_000;
/** Tries for one event before it is given up. */
export const MAX_ATTEMPTS = 5;
/** The wait after each failed try, in seconds: about a quarter hour in all. */
export const RETRY_DELAYS_S = [10, 60, 240, 600] as const;
/** An address failing this long is suspended until its owner refreshes. */
export const SUSPEND_AFTER_MS = 60 * 60_000;
/** A subscription with nothing marking it is read anyway this often, for what the log does not record. */
export const SWEEP_INTERVAL_MINUTES = 15;
/** Events sent to one address in one tick; the rest go on the next, so one busy scope does not hold up the others. */
const MAX_EVENTS_PER_TICK = 20;
/** After a secret is replaced, deliveries are signed with both for this long. */
const SECRET_GRACE_MS = 10 * 60_000;
/** How long a process may hold a subscription while it sends. */
const LEASE_SECONDS = 120;

export type WebhookErrorCode =
  | "INVALID_PARAMS"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RESOURCE_EXHAUSTED"
  | "UNSUPPORTED"
  | "CALLBACK_ENDPOINT_ERROR";

export interface WebhookError {
  ok: false;
  code: WebhookErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export interface DeliveryStatus {
  /** False when delivery had been suspended; the refresh that reports it has resumed it. */
  active: boolean;
  lastDeliveryAt: string | null;
  lastError: DeliveryFailure | null;
  failedSince?: string;
}

export interface SubscribeResult {
  ok: true;
  id: string;
  /** Refresh before this, or the subscription ends. */
  refreshBefore: string;
  /** The position everything before which has been delivered or given up. */
  cursor: string;
  truncated: boolean;
  deliveryStatus?: DeliveryStatus;
}

export interface WebhookPrincipal {
  userId: string;
  apiKeyId?: string | null;
}

interface WebhookRow {
  id: string;
  subscription_key: string;
  user_id: string;
  api_key_id: string | null;
  event_name: EventName;
  arguments: Record<string, unknown>;
  url: string;
  secret_sealed: string;
  secret_key_id: string;
  previous_secret_sealed: string | null;
  previous_secret_key_id: string | null;
  previous_secret_until: string | null;
  cursor: string;
  expires_at: string;
  expired: boolean;
  verified_at: string | null;
  active: boolean;
  attempt_event_id: string | null;
  attempt_message_id: string | null;
  attempts: number;
  failed_since: string | null;
  failing_ms: number | null;
  last_error: DeliveryFailure | null;
  last_delivery_at: string | null;
  deliveries: number;
  router_subscription_id: string | null;
  created_at: string;
}

const COLUMNS = `id, subscription_key, user_id, api_key_id, event_name, arguments, url, secret_sealed, secret_key_id,
  previous_secret_sealed, previous_secret_key_id, previous_secret_until::text AS previous_secret_until, cursor,
  expires_at::text AS expires_at, (expires_at <= now()) AS expired, verified_at::text AS verified_at, active,
  attempt_event_id, attempt_message_id, attempts, failed_since::text AS failed_since,
  (extract(epoch FROM now() - failed_since) * 1000)::bigint AS failing_ms, last_error,
  last_delivery_at::text AS last_delivery_at, deliveries, router_subscription_id, created_at::text AS created_at`;

const SUBSCRIBE_REASON =
  "A webhook subscription is the account's own record, kept on the owner's connection as an API key is; making one reads the account's standing and its other subscriptions, none of which carries a label.";
const UNSUBSCRIBE_REASON = "Ending a webhook subscription removes the account's own record and its row for the router, found by id.";
const LIST_REASON = "An account's webhook subscriptions are its own records and carry no label.";
const TICK_REASON =
  "The delivery tick finds every due webhook subscription, whoever holds it, and checks each account's standing; what it sends is read at public.";

/** Whether this deployment can keep a caller's signing secret, and so offer webhooks at all. */
export function webhooksAvailable(): boolean {
  return credentialKeys().current !== null;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function binding(row: { subscription_key: string; url: string }) {
  return { connectionId: row.subscription_key, url: row.url, transport: "webhook" };
}

function openSecret(row: WebhookRow): { secret: Buffer; previous: Buffer | null } | null {
  const opened = openCredential({ sealed: row.secret_sealed, keyId: row.secret_key_id }, binding(row));
  if (!opened.ok) return null;
  const secret = secretBytes(opened.credential);
  if (!secret) return null;
  let previous: Buffer | null = null;
  if (row.previous_secret_sealed && row.previous_secret_key_id && row.previous_secret_until) {
    if (new Date(row.previous_secret_until).getTime() > Date.now()) {
      const old = openCredential({ sealed: row.previous_secret_sealed, keyId: row.previous_secret_key_id }, binding(row));
      if (old.ok) previous = secretBytes(old.credential);
    }
  }
  return { secret, previous };
}

/** The kinds on the event log that tell of each kind of change; a kind with none is found by the sweep. */
const LOG_KIND_FOR: Record<string, EventKind> = {
  first_assessment: "assessed",
  status_moved: "assessed",
  credence_moved: "assessed",
  reassessed: "assessed",
  run_finished: "run_settled",
  message_answered: "message_answered",
  petition_decided: "petition_decided",
};

/** The router's filter for a `graph.change` subscription, or null when no kind it asks for is on the log. */
export function routerFilterFor(args: Record<string, unknown>): { kinds: EventKind[]; under?: string[]; tags?: string[] } | null {
  const asked = Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds.map(String) : ["first_assessment"];
  const kinds = [...new Set(asked.map((k) => LOG_KIND_FOR[k]).filter(Boolean))] as EventKind[];
  if (kinds.length === 0) return null;
  return {
    kinds,
    ...(Array.isArray(args.under) && args.under.length > 0 ? { under: args.under.map(String) } : {}),
    ...(Array.isArray(args.tags) && args.tags.length > 0 ? { tags: args.tags.map(String) } : {}),
  };
}

async function endRouterSubscription(id: string | null): Promise<void> {
  if (!id) return;
  await rawQuery(`UPDATE subscriptions SET active = false, ended_at = now() WHERE id = $1 AND subscriber_kind = 'webhook'`, [id]);
}

async function removeRow(row: Pick<WebhookRow, "id" | "router_subscription_id">): Promise<void> {
  await rawQuery(`DELETE FROM event_webhooks WHERE id = $1`, [row.id]);
  await endRouterSubscription(row.router_subscription_id);
}

/** Whether the account may still be sent what `public` reads here. */
async function mayStillReceive(row: Pick<WebhookRow, "user_id" | "api_key_id">): Promise<boolean> {
  if (row.api_key_id) {
    const [key] = await rawQuery<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id = $1`, [
      row.api_key_id,
    ]);
    if (!key || key.revoked) return false;
  }
  // Where reads are for members, `public` means every member and nobody else.
  if (membersOnly()) return (await resolveStanding(row.user_id)).member;
  return true;
}

export interface SubscribeInput {
  name: unknown;
  arguments?: unknown;
  url: unknown;
  secret: unknown;
  cursor?: string | null;
  maxAgeMs?: number | null;
  /** Undefined: the default. Null: as long as is granted. */
  ttlMs?: number | null;
}

function grantedTtlMs(ttlMs: number | null | undefined): number {
  if (ttlMs === null) return MAX_TTL_MS;
  if (ttlMs === undefined) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ttlMs)));
}

/**
 * Make a subscription, or refresh the one the same account already holds
 * for the same address, event type and arguments. A refresh renews its
 * life, takes a new secret if one is given, and resumes delivery that was
 * suspended. Before the first delivery to an address the address must
 * answer a challenge, once for an account.
 */
export async function subscribeWebhook(
  principal: WebhookPrincipal,
  input: SubscribeInput,
  send: WebhookSend = sendWebhook
): Promise<SubscribeResult | WebhookError> {
  const fail = (code: WebhookErrorCode, message: string, data?: Record<string, unknown>): WebhookError => ({
    ok: false,
    code,
    message,
    ...(data ? { data } : {}),
  });
  if (!webhooksAvailable()) {
    return fail(
      "UNSUPPORTED",
      "This deployment does not deliver by webhook: it has no key to keep a signing secret with. Follow the event by polling.",
      { feature: "deliveryMode", value: "webhook" }
    );
  }
  const checked = validateArguments(input.name, input.arguments);
  if (!checked.ok) return fail(checked.code, checked.message, checked.kind ? { kind: checked.kind } : undefined);
  const urlProblem = callbackUrlProblem(input.url);
  if (urlProblem) return fail("INVALID_PARAMS", urlProblem);
  const url = String(input.url);
  if (!secretBytes(input.secret)) {
    return fail(
      "INVALID_PARAMS",
      "delivery.secret must be a Standard Webhooks secret that you generate: whsec_ followed by the base64 of 24 to 64 random bytes."
    );
  }
  const secret = String(input.secret);
  if (input.cursor != null && (typeof input.cursor !== "string" || !decodeChangeCursor(input.cursor))) {
    return fail("INVALID_PARAMS", "cursor must be a cursor exactly as an earlier result or delivery gave it, or null to start from now.");
  }
  if (input.ttlMs != null && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
    return fail("INVALID_PARAMS", "ttlMs must be a number of milliseconds above 0, or null for the longest life granted.");
  }
  if (input.maxAgeMs != null && (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0)) {
    return fail("INVALID_PARAMS", "maxAgeMs must be a number of milliseconds, 0 or more.");
  }

  return withSystemClearance(SUBSCRIBE_REASON, async () => {
    if (!(await mayStillReceive({ user_id: principal.userId, api_key_id: principal.apiKeyId ?? null }))) {
      return fail("FORBIDDEN", "This account may not follow events here.");
    }
    if (checked.name === "correspondent.update") {
      // Deliveries are read at public, so the Correspondent must be one public reads.
      const visible = await runAtLabel(PUBLIC_LABEL, "a webhook subscription", () =>
        rawQuery<{ id: string }>(`SELECT id FROM correspondents WHERE id = $1`, [checked.arguments.correspondent_id])
      );
      if (visible.length === 0) return fail("INVALID_PARAMS", "correspondent_id names no Correspondent that a webhook can follow.");
    }
    const key = subscriptionId(`user:${principal.userId}`, url, checked.name, checked.arguments);
    let [existing] = await rawQuery<WebhookRow>(`SELECT ${COLUMNS} FROM event_webhooks WHERE subscription_key = $1`, [key]);
    if (existing?.expired) {
      // It lapsed and has not been collected yet: this is a new subscription.
      await removeRow(existing);
      existing = undefined;
    }
    if (!existing) {
      const max = loadConfig().eventWebhookMaxPerAccount;
      const [held] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM event_webhooks WHERE user_id = $1 AND expires_at > now()`,
        [principal.userId]
      );
      if (Number(held?.n ?? 0) >= max) {
        return fail(
          "RESOURCE_EXHAUSTED",
          `This account already holds ${max} webhook subscriptions, the most an account may hold at once. Each is matched ` +
            `against every event and nothing prices that, so the number is fixed. Unsubscribe one, or let one expire.`,
          { limit: "subscriptions", max }
        );
      }
    }

    // The address proves it wants this account's deliveries, once.
    let verifiedAt: string | null = existing?.verified_at ?? null;
    if (!verifiedAt) {
      const [other] = await rawQuery<{ verified_at: string }>(
        `SELECT verified_at::text AS verified_at FROM event_webhooks
          WHERE user_id = $1 AND url = $2 AND verified_at IS NOT NULL AND expires_at > now() LIMIT 1`,
        [principal.userId, url]
      );
      verifiedAt = other?.verified_at ?? null;
    }
    if (!verifiedAt) {
      const challenge = randomBytes(24).toString("base64url");
      const body = JSON.stringify({ type: "verification", challenge });
      const answer = await send(
        url,
        deliveryHeaders({ secret: secretBytes(secret)!, messageId: messageId("verification"), subscriptionId: key, body }),
        body
      );
      const reason: DeliveryFailure | null = !answer.ok
        ? answer.failure
        : challengeAnswered(challenge, answer.body)
          ? null
          : "challenge_failed";
      if (reason) {
        return fail(
          "CALLBACK_ENDPOINT_ERROR",
          reason === "challenge_failed"
            ? "The address answered but did not echo the challenge. Before the first delivery it is sent a signed body " +
              '{"type":"verification","challenge":"..."} and must answer 2xx with {"challenge":"<the same value>"}.'
            : "The address could not be reached to verify it. It must be an https address this deployment may reach, and answer within five seconds.",
          { reason }
        );
      }
      verifiedAt = new Date().toISOString();
    }

    const sealed = sealCredential(secret, { connectionId: key, url, transport: "webhook" });
    if (!sealed.ok) return fail("UNSUPPORTED", sealed.message, { feature: "deliveryMode", value: "webhook" });
    const ttlMs = grantedTtlMs(input.ttlMs);

    if (existing) {
      const opened = openCredential({ sealed: existing.secret_sealed, keyId: existing.secret_key_id }, binding(existing));
      const rotated = !opened.ok || opened.credential !== secret;
      await rawQuery(
        `UPDATE event_webhooks
            SET secret_sealed = $2, secret_key_id = $3,
                previous_secret_sealed = CASE WHEN $4 THEN secret_sealed ELSE previous_secret_sealed END,
                previous_secret_key_id = CASE WHEN $4 THEN secret_key_id ELSE previous_secret_key_id END,
                previous_secret_until = CASE WHEN $4 THEN now() + ($5::double precision * interval '1 millisecond') ELSE previous_secret_until END,
                expires_at = now() + ($6::double precision * interval '1 millisecond'),
                verified_at = COALESCE(verified_at, $7::timestamptz),
                active = true,
                failed_since = CASE WHEN active THEN failed_since ELSE NULL END,
                next_attempt_at = CASE WHEN active THEN next_attempt_at ELSE now() END,
                wake_at = COALESCE(wake_at, now())
          WHERE id = $1`,
        [existing.id, sealed.value.sealed, sealed.value.keyId, rotated, SECRET_GRACE_MS, ttlMs, verifiedAt]
      );
      const [row] = await rawQuery<WebhookRow>(`SELECT ${COLUMNS} FROM event_webhooks WHERE id = $1`, [existing.id]);
      return {
        ok: true as const,
        id: key,
        refreshBefore: iso(row!.expires_at),
        cursor: row!.cursor,
        truncated: false,
        deliveryStatus: {
          active: existing.active,
          lastDeliveryAt: existing.last_delivery_at ? iso(existing.last_delivery_at) : null,
          lastError: existing.last_error,
          ...(existing.failed_since ? { failedSince: iso(existing.failed_since) } : {}),
        },
      };
    }

    let cursor = input.cursor ?? cursorNow();
    let truncated = false;
    if (input.cursor != null && input.maxAgeMs != null) {
      const floor = toMicroIso(new Date(Date.now() - input.maxAgeMs).toISOString());
      if (decodeChangeCursor(cursor)!.at < floor) {
        cursor = encodeChangeCursor(floor, "00000000-0000-0000-0000-000000000000");
        truncated = true;
      }
    }
    const [row] = await rawQuery<WebhookRow>(
      `INSERT INTO event_webhooks (subscription_key, user_id, api_key_id, event_name, arguments, url, secret_sealed,
                                   secret_key_id, cursor, expires_at, verified_at, wake_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now() + ($10::double precision * interval '1 millisecond'), $11,
               CASE WHEN $12 THEN now() ELSE NULL END)
       RETURNING ${COLUMNS}`,
      [
        key,
        principal.userId,
        principal.apiKeyId ?? null,
        checked.name,
        JSON.stringify(checked.arguments),
        url,
        sealed.value.sealed,
        sealed.value.keyId,
        cursor,
        ttlMs,
        verifiedAt,
        // Starting from an earlier position: there may be something to send at once.
        input.cursor != null,
      ]
    );
    const filter = checked.name === "graph.change" ? routerFilterFor(checked.arguments) : null;
    if (filter) {
      // The router's row is at public: it is matched as public reads the graph, and only against public events.
      const sub = await runAtLabel(PUBLIC_LABEL, "a webhook subscription", () =>
        createSubscription({
          subscriberKind: "webhook",
          subscriberRef: row!.id,
          filter,
          delivery: "queue",
          reason: `webhook ${key}`,
          createdBy: "account",
        })
      );
      await rawQuery(`UPDATE event_webhooks SET router_subscription_id = $2 WHERE id = $1`, [row!.id, sub.id]);
    }
    return { ok: true as const, id: key, refreshBefore: iso(row!.expires_at), cursor, truncated };
  });
}

/** End a subscription now, by what it is or by its id. Only its own account can. */
export async function unsubscribeWebhook(
  principal: WebhookPrincipal,
  which: { id: string } | { name: unknown; arguments?: unknown; url: unknown }
): Promise<{ ok: true } | WebhookError> {
  let key: string;
  if ("id" in which) key = which.id;
  else {
    const checked = validateArguments(which.name, which.arguments);
    if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
    if (typeof which.url !== "string") return { ok: false, code: "INVALID_PARAMS", message: "delivery.url is required." };
    key = subscriptionId(`user:${principal.userId}`, which.url, checked.name, checked.arguments);
  }
  return withSystemClearance(UNSUBSCRIBE_REASON, async () => {
    const [row] = await rawQuery<WebhookRow>(
      `SELECT ${COLUMNS} FROM event_webhooks WHERE subscription_key = $1 AND user_id = $2`,
      [key, principal.userId]
    );
    if (!row) {
      return { ok: false as const, code: "NOT_FOUND" as const, message: "No such subscription.", data: { kind: "subscription" } };
    }
    await removeRow(row);
    return { ok: true as const };
  });
}

export interface WebhookView {
  id: string;
  name: EventName;
  arguments: Record<string, unknown>;
  url: string;
  cursor: string;
  refreshBefore: string;
  createdAt: string;
  deliveries: number;
  deliveryStatus: DeliveryStatus;
}

/** The subscriptions an account holds. Never a secret. */
export async function listWebhooks(userId: string): Promise<WebhookView[]> {
  const rows = await withSystemClearance(LIST_REASON, () =>
    rawQuery<WebhookRow>(
      `SELECT ${COLUMNS} FROM event_webhooks WHERE user_id = $1 AND expires_at > now() ORDER BY created_at, id`,
      [userId]
    )
  );
  return rows.map((r) => ({
    id: r.subscription_key,
    name: r.event_name,
    arguments: r.arguments,
    url: r.url,
    cursor: r.cursor,
    refreshBefore: iso(r.expires_at),
    createdAt: iso(r.created_at),
    deliveries: Number(r.deliveries),
    deliveryStatus: {
      active: r.active,
      lastDeliveryAt: r.last_delivery_at ? iso(r.last_delivery_at) : null,
      lastError: r.last_error,
      ...(r.failed_since ? { failedSince: iso(r.failed_since) } : {}),
    },
  }));
}

/** The router matched an event to a subscription: it has news. */
export async function wakeWebhook(webhookId: string): Promise<boolean> {
  const rows = await rawQuery(
    `UPDATE event_webhooks SET wake_at = COALESCE(wake_at, now()) WHERE id::text = $1 AND expires_at > now() RETURNING id`,
    [webhookId]
  );
  return rows.length > 0;
}

/** A Correspondent published: its followers have news. Never fails the publishing it follows. */
export async function wakeWebhooksFollowing(correspondentId: string): Promise<void> {
  await rawQuery(
    `UPDATE event_webhooks SET wake_at = COALESCE(wake_at, now())
      WHERE event_name = 'correspondent.update' AND arguments->>'correspondent_id' = $1`,
    [correspondentId]
  ).catch(() => []);
}

/** The body of one event's delivery: the occurrence, with the position after it. */
function eventBody(e: EventOccurrence): string {
  return JSON.stringify({ eventId: e.eventId, name: e.name, timestamp: e.timestamp, data: e.data, cursor: e.cursor });
}

async function sendTerminated(row: WebhookRow, send: WebhookSend, reason: string, code = -32024, message = "Forbidden"): Promise<void> {
  const secrets = openSecret(row);
  if (!secrets) return;
  const body = JSON.stringify({ type: "terminated", error: { code, message, data: { reason } } });
  await send(
    row.url,
    deliveryHeaders({ secret: secrets.secret, previousSecret: secrets.previous, messageId: messageId("terminated"), subscriptionId: row.subscription_key, body }),
    body
  ).catch(() => null);
}

/** Send what waits for one subscription. Returns how many events its address accepted. */
async function deliverFor(row: WebhookRow, send: WebhookSend): Promise<number> {
  if (!(await mayStillReceive(row))) {
    await sendTerminated(row, send, "Access revoked");
    await removeRow(row);
    return 0;
  }
  const secrets = openSecret(row);
  if (!secrets) {
    // The key that sealed its secret is gone: nothing can be signed. It waits for its owner's refresh, which brings a secret.
    await rawQuery(`UPDATE event_webhooks SET active = false, wake_at = NULL, next_attempt_at = NULL WHERE id = $1`, [row.id]);
    return 0;
  }
  const read = await runAtLabel(PUBLIC_LABEL, `webhook ${row.subscription_key}`, () =>
    pollEvents({ name: row.event_name, arguments: row.arguments, cursor: row.cursor, maxEvents: MAX_EVENTS_PER_TICK })
  );
  if (!read.ok) {
    // What it follows is gone, or its arguments no longer mean anything.
    await sendTerminated(row, send, read.message, -32023, "NotFound");
    await removeRow(row);
    return 0;
  }
  let sent = 0;
  let attempts = row.attempts;
  let attemptEventId = row.attempt_event_id;
  let attemptMessageId = row.attempt_message_id;
  for (const event of read.page.events) {
    // A retry keeps the id of the message it retries, so its receiver can drop a repeat.
    const id = attemptEventId === event.eventId && attemptMessageId ? attemptMessageId : messageId();
    const body = eventBody(event);
    const result = await send(
      row.url,
      deliveryHeaders({ secret: secrets.secret, previousSecret: secrets.previous, messageId: id, subscriptionId: row.subscription_key, body }),
      body
    ).catch((): { ok: false; failure: DeliveryFailure; status?: number } => ({ ok: false, failure: "connection_refused" }));
    if (result.ok) {
      await rawQuery(
        `UPDATE event_webhooks
            SET cursor = $2, deliveries = deliveries + 1, last_delivery_at = now(), attempt_event_id = NULL,
                attempt_message_id = NULL, attempts = 0, next_attempt_at = NULL, failed_since = NULL, last_error = NULL
          WHERE id = $1`,
        [row.id, event.cursor]
      );
      sent++;
      attempts = 0;
      attemptEventId = null;
      attemptMessageId = null;
      continue;
    }
    // The receiver has said it does not want this one: no retry, and nothing is wrong with the address.
    const refused = result.status === 410 || result.status === 413;
    const tries = attemptEventId === event.eventId ? attempts + 1 : 1;
    if (refused || tries >= MAX_ATTEMPTS) {
      await rawQuery(
        `UPDATE event_webhooks
            SET cursor = $2, attempt_event_id = NULL, attempt_message_id = NULL, attempts = 0, next_attempt_at = NULL,
                last_error = CASE WHEN $3 THEN last_error ELSE $4 END, wake_at = now()
          WHERE id = $1`,
        [row.id, event.cursor, refused, result.failure]
      );
      if (refused) {
        attempts = 0;
        attemptEventId = null;
        attemptMessageId = null;
        continue;
      }
      // Given up after its tries. The next event waits for the next tick.
      return sent;
    }
    const suspend = row.failing_ms !== null && Number(row.failing_ms) >= SUSPEND_AFTER_MS;
    await rawQuery(
      `UPDATE event_webhooks
          SET attempt_event_id = $2, attempt_message_id = $3, attempts = $4, last_error = $5,
              failed_since = COALESCE(failed_since, now()),
              active = NOT $6,
              next_attempt_at = CASE WHEN $6 THEN NULL ELSE now() + ($7::double precision * interval '1 second') END
        WHERE id = $1`,
      [row.id, event.eventId, id, tries, result.failure, suspend, RETRY_DELAYS_S[tries - 1] ?? RETRY_DELAYS_S.at(-1)]
    );
    return sent;
  }
  // Everything read was sent. The cursor moves past what was read even when
  // nothing was, so a quiet subscription's position does not grow old; a
  // mark made while this was sending is kept for the next tick.
  await rawQuery(
    `UPDATE event_webhooks
        SET cursor = $2, checked_at = now(),
            wake_at = CASE WHEN $3 THEN now()
                           WHEN wake_at > lease_until - ($4::double precision * interval '1 second') THEN wake_at
                           ELSE NULL END
      WHERE id = $1`,
    [row.id, read.page.cursor, read.page.hasMore, LEASE_SECONDS]
  );
  return sent;
}

let ticking: Promise<{ delivered: number; expired: number }> | null = null;

/**
 * Deliver what waits: collect the subscriptions that have lapsed, then send
 * for each one that was marked, is due a retry, or has not been read for a
 * sweep's length. One tick at a time in a process, and a lease on each
 * subscription keeps two processes from sending for it at once.
 */
export async function deliveryTick(send: WebhookSend = sendWebhook, limit = 50): Promise<{ delivered: number; expired: number }> {
  if (ticking) return ticking;
  ticking = withSystemClearance(TICK_REASON, async () => {
    const gone = await rawQuery<{ router_subscription_id: string | null }>(
      `DELETE FROM event_webhooks WHERE expires_at <= now() RETURNING router_subscription_id`
    );
    for (const g of gone) await endRouterSubscription(g.router_subscription_id);
    const due = await rawQuery<WebhookRow>(
      `UPDATE event_webhooks w SET lease_until = now() + ($2::double precision * interval '1 second')
        WHERE w.id IN (
          SELECT id FROM event_webhooks
           WHERE verified_at IS NOT NULL AND active AND expires_at > now()
             AND (lease_until IS NULL OR lease_until < now())
             AND ((next_attempt_at IS NOT NULL AND next_attempt_at <= now())
               OR (next_attempt_at IS NULL
                   AND (wake_at IS NOT NULL OR checked_at < now() - ($3::double precision * interval '1 minute'))))
           ORDER BY COALESCE(next_attempt_at, wake_at, checked_at)
           LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING ${COLUMNS}`,
      [limit, LEASE_SECONDS, SWEEP_INTERVAL_MINUTES]
    );
    let delivered = 0;
    for (const row of due) {
      try {
        delivered += await deliverFor(row, send);
      } catch (err) {
        console.warn(`[events] delivery for ${row.subscription_key} failed:`, err instanceof Error ? err.message : err);
      } finally {
        await rawQuery(`UPDATE event_webhooks SET lease_until = NULL WHERE id = $1`, [row.id]).catch(() => []);
      }
    }
    return { delivered, expired: gone.length };
  }).finally(() => {
    ticking = null;
  });
  return ticking;
}
