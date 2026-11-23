# Events for outside clients

A client outside Minerval that wants to know when something changes should
not have to re-read the graph to find out. It can follow an **event type**
two ways: by **poll**, keeping a cursor and asking what came after it, or by
**webhook**, giving an address that each event is POSTed to as it happens
(#1213, which superseded #567).

Both are windows on reads the graph already serves. Nothing here is a
second source of truth: a webhook carries exactly what a poll from the same
position returns, and a poll of `graph.change` returns exactly what
`list_graph_changes` does.

The shapes follow the Model Context Protocol's Events extension
(`io.modelcontextprotocol/events`, SEP-3415), so a client that speaks it
needs nothing written for Minerval. A client that does not uses the tools
or the REST routes, which are the same service.

## Event types

Defined once, in `src/services/event-types.ts`.

| Name | What it is | Arguments | Each event carries |
|---|---|---|---|
| `graph.change` | One entry of the change stream ([allocation.md](allocation.md), "The change stream") | The stream's own filters: `under`, `tags`, `kinds`, `min_credence_delta`, `material_only` | The stream's entry: ids, kind, sizes, a line of text, `page_url` |
| `correspondent.update` | A Correspondent published an update | `correspondent_id` | The update's id, title, item count, and where to read it |

An event is ids and a summary, never a whole node or an update's body. The
reader opens what matters with the reads it already has (`get_claim`,
`list_correspondent_updates`). That keeps deliveries small and keeps
anything a reader may not see out of them.

An event is one object wherever it appears, in a poll's answer, over MCP
and in a webhook's body:

```json
{
  "eventId": "82ab9ba5-8016-487e-b2f8-415dd849215e",
  "name": "graph.change",
  "timestamp": "2026-11-10T18:34:36.346581Z",
  "data": { "claim_id": "9e630ed1-…", "kind": "status_moved", "status": "doubtful", "prev_status": "supported", "…": "…" },
  "cursor": "MjAyNi0xMS0xMFQxODozNDozNi4zNDY1ODFa…"
}
```

`eventId` is the row that made the event (an assessment, an update), so the
same event has the same id however it arrives and a reader can drop a
repeat. `cursor` is the position after it. The cursor of `graph.change` is
the change stream's cursor: a position from `GET /changes` works here and
the other way round.

Arguments a type does not take are refused, not ignored, and equal
arguments are written one way (lists sorted, defaults left out), because a
webhook subscription is named by them.

## Poll

`POST /events/poll` (`poll_events`; `events/poll`) takes a name, its
arguments and a cursor, and answers with the events after it, oldest first:

```json
{ "events": [], "cursor": "…", "truncated": false, "has_more": false, "next_poll_ms": 60000 }
```

- With no cursor it returns no events and the position **now**. Following
  starts when it is asked for; what happened before is read with the
  ordinary reads (`list_graph_changes` with `since`).
- `has_more` true: call again at once. Otherwise wait `next_poll_ms`.
- `max_age_ms` bounds how far back an old cursor reads; `truncated` says
  when that skipped something.
- Nothing is held for the caller. It is a read at the caller's own
  clearance, like `GET /changes`, and free.

## Webhook

`POST /events/subscriptions` (`subscribe_events`; `events/subscribe`) takes
a name, its arguments, an `https` address and a signing secret, and answers
with the subscription's id, when it ends unless refreshed, and its cursor.
`src/services/event-webhook-service.ts`.

**A subscription is who asked, where it delivers, the event type and its
arguments.** Subscribing again with the same four refreshes it: its life is
renewed, a new secret replaces the old (deliveries are signed with both for
ten minutes), and delivery that was suspended resumes. Its id
(`sub_…`) is derived from the four. It tells a receiver which secret a
delivery was signed with and authorizes nothing.

**It always ends unless refreshed.** 24 hours by default, 5 minutes at
least, 7 days at most (`ttl_ms`; `refresh_before` says what was granted).
None is granted without an end, so an abandoned one collects itself.

**The secret is the caller's.** `whsec_` followed by the base64 of 24 to 64
random bytes, made by the caller and kept by it. It is stored sealed under
`CREDENTIAL_ENCRYPTION_KEY`, as a connection's credential is
([connections.md](connections.md), "A credential given here"). A deployment
without that key offers poll only, and its event types say so.

**Each delivery is one event**, POSTed as JSON with the Standard Webhooks
headers and one more:

| Header | |
|---|---|
| `webhook-id` | The message's id. A retry keeps it, so a receiver can drop a repeat. |
| `webhook-timestamp` | When this attempt was sent, in seconds. A receiver should refuse one more than five minutes old. |
| `webhook-signature` | `v1,` and the base64 of HMAC-SHA256 over `id.timestamp.body` under the secret's bytes. Several, separated by spaces, while a secret is being replaced. |
| `X-MCP-Subscription-Id` | The subscription's id. |

Any Standard Webhooks verifier checks it. The signature is over the body's
bytes as received.

**Before the first delivery the address proves it wants them.** It is sent
`{"type":"verification","challenge":"…"}`, signed like any delivery, and
must answer `2xx` with `{"challenge":"<the same value>"}`. Otherwise an
account could aim deliveries at an address that never asked. One proof
covers an account's subscriptions to that address.

**Where a webhook may send** (`src/services/webhook-sender.ts`): `https`
only; the host is resolved at the moment of sending and every address it
resolves to must be public; the connection is made to the address that was
checked, so a name cannot change its answer in between; no redirect is
followed; the receiver has five seconds. `EVENT_WEBHOOK_ALLOWED_HOSTS`
names hosts a deployment may reach although they are not public, which is
how a deployment on a team's own network delivers to a receiver beside it.

**Delivery is in order, one event at a time for each subscription**, so the
cursor in each body is safe to keep: everything before it was accepted or
given up. A `2xx` accepts an event. Anything else is tried again after 10
seconds, 1 minute, 4 minutes and 10 minutes, then given up: the cursor
moves on and the stream continues. `410` and `413` end the attempt for that
event at once, without counting against the address. An address that has
failed for an hour is suspended until its owner refreshes, and the refresh
says so (`delivery_status`: `active`, `last_delivery_at`, `last_error`,
`failed_since`). `last_error` is one of `connection_refused`, `timeout`,
`tls_error`, `http_4xx`, `http_5xx`, `challenge_failed`, and never the
receiver's own words, so it cannot be used to read what an address answers.

**How a subscription is woken.** It is a subscriber on the router that
serves the graph's own agents ([allocation.md](allocation.md), "Events and
subscriptions"), of kind `webhook`. An event on the log that matches marks
it; a Correspondent publishing marks its followers directly. The delivery
tick, on the engine's tick, then reads the event type from the
subscription's cursor and sends what it finds. The log is only the signal:
the content is the same read a poll makes. A sweep every quarter hour reads
for each subscription whether or not anything marked it, because the log
does not record every kind of change `graph.change` can carry (a node's
state changing, a contribution accepted). Those kinds arrive within a
quarter hour; verdicts arrive within a tick.

**Endings.** `DELETE /events/subscriptions/:id` (`unsubscribe_events`;
`events/unsubscribe`, by what the subscription is) ends one at once. One
whose key was revoked, whose account lost its membership of a members-only
deployment, or whose Correspondent is gone is ended at its next delivery,
and the address is sent a signed `{"type":"terminated","error":{…}}`.

### What a webhook carries

A delivery is read at the label `public`, whatever the account may read. A
callback address is outside the deployment, and what leaves a label for
outside goes through that label's gate ([the-gate.md](the-gate.md)), not
through a subscription. A judgment at a private label does not wake a
subscription, is not sent, and nothing is said of it
(`tests/db/event-webhooks-labels.test.ts`). A subscriber at a private label
polls, which is a read at its own clearance. This is the rule the router
already keeps for inboxes and lookouts.

In a members-only deployment `public` means every member and nobody else,
so the account's standing is checked at each delivery.

### What it costs

Nothing: reads are free, and a delivery is one small POST. An account holds
at most 20 subscriptions at once (`EVENT_WEBHOOK_MAX_PER_ACCOUNT`). That is
a count and not a price because nothing meters what it bounds: every live
subscription is matched against every event on the log and swept every
quarter hour, whoever holds it. The tool that makes one states the number,
and a refusal names it.

## The three doors

| REST | MCP tool | Events extension |
|---|---|---|
| `GET /events` | `list_event_types` | `events/list` |
| `POST /events/poll` | `poll_events` | `events/poll` |
| `POST /events/subscriptions` | `subscribe_events` | `events/subscribe` |
| `GET /events/subscriptions` | `list_event_subscriptions` | (the client keeps its own list) |
| `DELETE /events/subscriptions/:id` | `unsubscribe_events` | `events/unsubscribe` |

The extension's methods (`src/mcp/events.ts`) dispatch into the routes, as
a route tool does, so the route's guards and validation are the only ones.
They differ in wire shape alone: the extension's field names
(`maxEvents`, `refreshBefore`, `deliveryStatus`), `resultType:
"complete"`, and its error codes.

| Refusal | REST | Extension |
|---|---|---|
| `INVALID_PARAMS` | 400 | -32602 |
| `NOT_FOUND` (an event type, or a subscription) | 404 | -32023 |
| `FORBIDDEN` | 403 | -32024 |
| `RESOURCE_EXHAUSTED` (the 20) | 429 | -32025 |
| `UNSUPPORTED` (no webhook delivery here) | 501 | -32026 |
| `CALLBACK_ENDPOINT_ERROR` | 422 | -32027 |

**Where the extension is not yet met.** It is written for protocol
revision 2026-07-28 and the endpoint serves 2025-11-25
([mcp.md](mcp.md), "Endpoint"). The methods are served and the extension is
advertised in the server's capabilities, but `server/discover` and the
`Mcp-Name` routing header belong to the newer revision and are not here.
`events/stream`, a held connection, is not offered and no event type lists
`push`: the endpoint is stateless behind a load balancer, and a held stream
would need a bus across tasks and be cut by every deploy. It has not been
run against a hosted client. The tools and the routes are the surface every
client can use today.

**The Assistant** has these tools as it has the account's others
([accounts.md](accounts.md), "The Assistant"). `poll_events` is a read.
`subscribe_events` always waits for the user's press, whatever they have
allowed: it names an address outside Minerval and the secret deliveries are
signed with, and text the Assistant read must not choose either.
`unsubscribe_events` is held as a cancellation.

**Acting as an organization** ([organizations.md](organizations.md)):
polling is any member's; where the organization's deliveries go is an
administrator's.

## Settings

- `CREDENTIAL_ENCRYPTION_KEY`: without it, no webhook delivery.
- `EVENT_WEBHOOK_MAX_PER_ACCOUNT` (20): subscriptions an account may hold.
- `EVENT_WEBHOOK_ALLOWED_HOSTS` (empty): hosts a webhook may reach although
  their addresses are not public, separated by commas or spaces.

## Tests

- `tests/unit/services/webhook-signing.test.ts`: the signature against the
  scheme's published example; what a secret must be; a subscription's id.
- `tests/unit/services/webhook-sender.test.ts`: which addresses are refused.
- `tests/unit/services/event-types.test.ts`: arguments, and payloads that
  carry no body.
- `tests/db/event-webhooks.test.ts`: subscribing, the challenge, delivery
  through the router, retries, giving up, suspension, rotation, expiry, a
  revoked key, a Correspondent's update.
- `tests/db/event-webhooks-labels.test.ts`: nothing above `public` is sent.
- `tests/db/events-over-mcp.test.ts`: the extension's methods and the tools
  against the real app.
