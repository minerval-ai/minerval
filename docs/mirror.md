# The mirror

A private deployment reads the public graph from a local, read-only copy of it: the mirror. It never queries the live public graph, because the sequence of things it asked about would show what it is working on. It pulls the whole feed instead, which shows only that the deployment exists and when it pulls.

The mirror advances by applying **signed batches of full public rows**. A batch arrives over HTTPS or as a file, and is checked the same way either way.

One codebase serves both sides. A deployment publishes the feed, applies one, does both, or does neither, and it does neither unless configured: with nothing set, no mirror route is mounted, no mirror worker starts, and nothing reads or writes the mirror's tables.

## Where the rows live

Mirrored rows live in the same tables as a deployment's own, because edges and judgments reference `claims.id`. Each replicated table has an `origin` column: `mirror` for a row the applier wrote from the feed, `local` for every other row (which is every row on the public graph).

A mirrored row is the public graph's. Nothing in the deployment edits it. A local view of a public claim is a judgment of the deployment's own, recorded beside the mirrored one, never an edit of it.

## What travels

The one list is `src/services/mirror-manifest.ts`. Nineteen tables, parents first:

| Table | What it is |
| --- | --- |
| `claims`, `quantity_definitions`, `quantity_cuts` | Nodes: claims, quantities and questions |
| `claim_relationships`, `claim_links`, `answer_relations` | Decomposition edges, lateral links, how answers bear on each other |
| `sources`, `source_segments` | Documents, with their text and structure |
| `arguments`, `argument_subclaims` | Arguments and the edges each groups |
| `claim_instances`, `argument_instances`, `quantity_readings` | Where sources state claims, make arguments, report readings |
| `assessments`, `quantity_estimates`, `question_assessments`, `argument_evaluations` | Judgments, current and past |
| `source_interests` | A source's recorded stake |
| `judgment_inputs` | What each judgment was made against |

Every column of these tables travels unless the manifest names it with a reason:

- **Local working state** stays local: a claim's place in the Steward's queue (`steward_*`, `queue_priority`), its tagging lease (`tagged_at`, `tagging_*`), and `updated_at`. The deployment writes these on a mirrored claim; the feed never does.
- **Money** does not travel: `funded_by_job_id` on a judgment names a budget job in the publisher's ledger.
- **What points outside the list** does not travel: `arguments.lean_check_id`.
- `origin` and `sensitivity_label` are handled for every table at once. Only rows at the `public` label are published, and a mirrored row is `public`.

Not mirrored at all: run transcripts, accounts and keys, the ledger and mandates, queues and inboxes, the contribution record, tags, source events, the provenance tables, requests, and the mathematics tables. The manifest's `NOT_MIRRORED` gives the reason for each.

**A mirrored judgment's run.** `run_id` on a mirrored assessment is the id of a run on the public graph. It has no foreign key and resolves to nothing locally. The transcript is read on the public graph; each batch states the public graph's web address (`publisher.web_base_url`), and `GET /mirror/status` passes it on.

**A mirrored claim and the queues.** A claim inserted with the table's defaults would be pending for the Steward and untagged, and both drains would spend the deployment's budget redoing public work. So a mirrored claim arrives `deferred` (embedded and matchable, out of the drain) with tagging marked done. It is taken up the way any deferred claim is: when an action on it is funded.

## Embeddings

Vectors travel in the feed. Every vector in a graph is compared with every other, so mirrored and local claims must be embedded by one model. Shipping the vectors means the mirrored half is right by construction and costs nothing to compute. Each batch states its embedding model and dimensions, and an applier refuses a batch whose model is not its own (`src/services/embedding-model.ts`). A deployment that embeds its own text with a different model would have to recompute the mirrored vectors with that model instead; that path is not built.

## The publisher

### How it knows what changed

Writes to the graph are spread over about a thousand statements with no outbox. A cut does not listen to them. It reads the replicated tables in one snapshot, hashes each row's replicated columns in the database, and compares with the hashes of the rows as last published (`mirror_feed_rows`). A row whose hash is new or different is sent whole. A published row that is gone is sent as a deletion; one that exists but is no longer public, as a retraction.

Compared with triggers that record each write:

- Nothing is missed, whoever wrote it: a tool, a migration, a repair by hand. A merge needs no handling of its own, because a merge is rows changing.
- A cut reads one snapshot (`REPEATABLE READ`), so a batch cut in the middle of a write holds all of that write or none of it.
- A mistake corrects itself at the next cut.
- No write path changes, and nothing runs on a deployment that does not publish.
- It costs a pass over the replicated tables on every cut, whatever changed. That is small today. As the graph grows the pass can be narrowed (compare `xmin` before hashing, hash a document by its stored content hash) without changing the feed.
- A row that changes twice between cuts is sent once. The mirror follows state, not every step.

### Only public rows

A row is published when it is at the `public` label, wherever its table carries one, and every replicated row it points to is published. So nothing reaches a batch by hanging off a public row.

A deployment that defines any label besides `public` does not publish at all. What leaves a private graph leaves through redaction and release, not through this feed.

### A batch

One JSON document:

| Field | |
| --- | --- |
| `format` | `1` |
| `feed_id` | The feed, minted with its first batch |
| `sequence` | 1, 2, 3, ... with no repeat and no gap |
| `kind` | `snapshot` (every published row) or `changes` |
| `part` | `{ first, last }`. A cut too large for one batch is split into consecutive batches; `first` is where the cut began, `last` whether this batch ends it |
| `cut_at` | When the publisher read its tables: the mirror shows the public graph as of this time |
| `migration` | `{ number, tag }`: the schema the batch was cut from |
| `shape` | A hash of the mirrored tables' columns and types |
| `embedding` | `{ model, dimensions }` |
| `publisher` | `{ web_base_url }` |
| `previous_hash` | The hash of the batch before it; for the first, the feed's genesis |
| `rows` | `[{ table, rows }]`: full rows, replicated columns only, tables parents first |
| `deletions`, `retractions` | `[{ table, keys }]` |
| `key_id`, `public_key` | The signing key, for a reader. An applier checks against the key it was configured with |
| `hash` | sha256 over `"minerval-mirror-feed/1\n"` and the canonical JSON of everything above |
| `signature` | Ed25519 over the hash's bytes, base64 |

Canonical JSON is the run log's (`src/services/run-log.ts`): keys sorted, no whitespace. Batches chain as a run's steps do.

The first cut of a feed is a snapshot. So is the first cut after the mirrored tables change shape, and any cut an operator asks to be one. A new mirror starts from the latest snapshot.

### Routes

Mounted only on a deployment that publishes.

- `GET /mirror/feed/key`: the public key.
- `GET /mirror/feed?after=N`: batches without their rows, and where the latest snapshot begins.
- `GET /mirror/feed/:sequence`: one batch as signed. Needs an account's key.

The feed is meant to have a price. Nothing charges yet; when something does, the check goes in the batch route's `preHandler`, where the account is known.

## The applier

A batch is applied only when all of this holds. Otherwise nothing of it is written and the refusal is recorded in `mirror_refusals`.

1. Its hash is the hash of its contents, and its signature verifies under a key in `MIRROR_FEED_PUBLIC_KEYS`. The key a batch carries is never trusted.
2. It is the next batch of the feed this mirror follows, naming the last applied batch's hash. A batch already applied is recognized by its hash and changes nothing. The one way past a batch is the first batch of a later snapshot.
3. It was cut from a schema no newer than this deployment's code, with the mirrored tables in exactly this code's shape, and with this deployment's embedding model.

Each batch is applied in one transaction. The applier writes replicated columns only, and only rows whose origin is `mirror`. A row in a batch with the id of a local row stops the batch.

### Schema compatibility

- **Newer than this deployment's code: refused**, with a message that says to upgrade. The mirror stays where it is until then.
- **Same or older, same shape: applied.** The shape hash covers each mirrored table's columns, types and nullability, and a version raised by hand when a migration changes what a column's values mean. Equal shapes mean every row fits the tables it is written to.
- **Older, different shape: refused.** When the publisher upgrades it cuts a snapshot in the new shape, and the mirror goes on from there.

### Deletions, retractions and merges

- A **deletion** or **retraction** removes the mirrored row. Local rows that pointed to it follow their foreign keys, as they would on the public graph, and the batch's notes say what went.
- The exception is a **claim** that local rows point to. It is kept, as `deprecated`, so that local edges, instances and judgments are not swept away with it.
- A **merge** arrives as the absorbed claim's `state` and `merged_into`. References to it still resolve. Local rows that hang off it are left as they are and listed in the batch's notes.

Notes are in `mirror_applied_batches.notes`.

### The guard

Three triggers on each replicated table (`mirror_row_guard`) refuse an insert, update or delete of a `mirror` row from any transaction but the applier's. An update is allowed when only the deployment's own columns on a claim differ. The triggers fire only for mirrored rows, so they do nothing where there are none.

The applier identifies itself with a setting that lasts for its transaction. That stops a code path that forgets a row is mirrored. It does not stop someone with SQL access who sets the setting by hand.

### How current the mirror is

`GET /mirror/status` (`get_mirror_status` on MCP), mounted only on a deployment that mirrors: `public_graph_as_of`, the sequence and hash of the newest batch, when it was applied, whether a snapshot is only partly applied, how many mirrored claims a search can find, and the last refusal since.

## Configuration

| Variable | |
| --- | --- |
| `MIRROR_PUBLISH` | `true` makes the deployment a publisher |
| `MIRROR_SIGNING_KEY` | Ed25519 private key, PEM. A secret |
| `MIRROR_PUBLISH_INTERVAL_SECONDS` | How often a cut is made. Default 900 |
| `MIRROR_BATCH_MAX_BYTES` | Most bytes of rows in one batch. Default 24,000,000 |
| `MIRROR_FEED_URL` | The publisher's API address. Makes the deployment an applier |
| `MIRROR_FEED_DIR` | A directory of batch files, in place of an address |
| `MIRROR_FEED_API_KEY` | The key presented when fetching a batch |
| `MIRROR_FEED_PUBLIC_KEYS` | The feed's public key or keys, comma-separated |
| `MIRROR_APPLY_INTERVAL_SECONDS` | How often the feed is checked. Default 300 |

A publisher without a usable signing key, or an applier without a public key, does not start.

## By hand

```sh
npx tsx scripts/mirror.ts keygen               # a new signing key
npx tsx scripts/mirror.ts cut [--snapshot]     # cut now
npx tsx scripts/mirror.ts list                 # the feed's batches
npx tsx scripts/mirror.ts export <dir>         # batches as files
npx tsx scripts/mirror.ts sync                 # bring the mirror up to its feed
npx tsx scripts/mirror.ts apply <file-or-dir>  # apply files
npx tsx scripts/mirror.ts status               # how current the mirror is
```

## Not built yet

- Private judgments of mirrored claims, and marking them stale when the mirror moves.
- A price for the feed.
- Recomputing mirrored vectors for a deployment with its own embedding model.
- Tags, requests, provenance and mathematics in the feed.
- A source that a deployment recorded itself and the public graph later holds at the same address. `sources.url` is unique across the table, so the batch that carries the public row is refused until the local row is dealt with. Giving sources an identity per graph removes the collision.
