# The mirror

A private deployment reads the public graph from a local, read-only copy of it: the mirror. It never queries the live public graph, because the sequence of things it asked about would show what it is working on. It pulls the whole feed instead, which shows only that the deployment exists and when it pulls.

The mirror advances by applying **signed batches of full public rows**. A batch arrives over HTTPS or as a file, and is checked the same way either way.

One codebase serves both sides. A deployment publishes the feed, applies one, does both, or does neither, and it does neither unless configured: with nothing set, no mirror route is mounted, no mirror worker starts, and nothing reads or writes the mirror's tables.

## Where the rows live

Mirrored rows live in the same tables as a deployment's own, because edges and judgments reference `claims.id`. Each replicated table has an `origin` column: `mirror` for a row the applier wrote from the feed, `local` for every other row (which is every row on the public graph).

A mirrored row is the public graph's. Nothing in the deployment edits it. A local view of a public claim is a judgment of the deployment's own, recorded beside the mirrored one, never an edit of it ("Beside a deployment's own rows", below).

## What travels

The one list is `src/services/mirror-manifest.ts`. Twenty-two tables, parents first:

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
| `feed_contributions`, `feed_requests`, `feed_request_targets` | The public record that is not rows of the graph: what each contribution on a node said, of what type, about which published page and where its review stands; and each request with the nodes it bears on. Filled on the publisher before each cut from its `contributions` and `requests`, with no account ([outward-acts.md](outward-acts.md)) |

Every column of these tables travels unless the manifest names it with a reason:

- **Local working state** stays local: a claim's place in the Steward's queue (`steward_*`, `queue_priority`), its tagging lease (`tagged_at`, `tagging_*`), and `updated_at`. The deployment writes these on a mirrored claim; the feed never does.
- **Money** does not travel: `funded_by_job_id` on a judgment names a budget job in the publisher's ledger.
- **What points outside the list** does not travel: `arguments.lean_check_id`.
- `origin` and `sensitivity_label` are handled for every table at once. Only rows at the `public` label are published, and the applier writes `public` on every mirrored row.
- `judgment_inputs.input_label` points to `labels`, which is not mirrored. It is set only on a row that says which version at another label a judgment was made beside, and a graph that publishes has one label and no such row.

Not mirrored at all: run transcripts, accounts and keys, the ledger and mandates, queues and inboxes, the contribution record's reviews and its accounts, the work done on requests, tags, source events, the provenance tables, and the mathematics tables. The manifest's `NOT_MIRRORED` gives the reason for each.

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
3. The mirrored tables had, where it was cut, exactly the shape this deployment's code writes, and its vectors come from this deployment's embedding model.

Each batch is applied in one transaction. The applier writes replicated columns only, and only rows whose origin is `mirror`. A row in a batch with the id of a local row stops the batch: ids are random, so that means the database was loaded with rows copied from the public graph. No other row of the deployment's own stops one ("Beside a deployment's own rows").

### Schema compatibility

A batch states the migration it was cut from and the shape of the mirrored tables there. The shape decides; the migration number is recorded with the applied batch and says which side has to move when the shapes differ. The public graph takes several migrations a day and few of them touch a mirrored table, so a mirror that stopped at every one would be stopped most of the time.

- **Same shape: applied**, whether the batch's migration is older than this deployment's code, the same, or newer. The shape hash covers each mirrored table's columns, types and nullability, and a version raised by hand when a migration changes what a column's values mean (`REPLICATED_MEANING_VERSION`). Equal shapes mean every row fits the tables it is written to.
- **Different shape, batch from a newer migration: refused**, with a message that says to upgrade to a release that includes that migration. The mirror stays where it is until then.
- **Different shape, batch from the same or an older migration: refused.** When the publisher upgrades it cuts a snapshot in the new shape, and the mirror goes on from there.

A migration that rewrites the values of a mirrored column without changing any column must raise `REPLICATED_MEANING_VERSION` in the same change. Nothing else can tell an older deployment that such a batch no longer means what it reads.

### Deletions, retractions and merges

- A **deletion** or **retraction** removes the mirrored row.
- The exception is a row that the deployment's own work hangs off, while local rows point to it: a **claim** (kept as `deprecated`, with the local edges, instances and judgments on it), an **argument** (kept as retired, with a label's evaluation of it), an **instance** (kept as detached, with a label's reading of it) and a **source** (kept as it was last sent, with the local instances from it). A row is also kept while a kept row points to it, so a kept argument keeps its claim. The batch's notes list what was kept (`kept_claims`, `kept_rows`).
- A link row with nothing of its own to say goes with what it links: a local grouping of a mirrored edge that the public graph removes follows the edge, and the notes say what went (`local_rows_followed`).
- A **merge** arrives as the absorbed claim's `state` and `merged_into`. References to it still resolve. Local rows that hang off it are left as they are and listed in the batch's notes.

Nothing of the deployment's own at a private label is deleted or moved by a batch. What follows a merge or a withdrawal for the deployment's own work is under "Beside a deployment's own rows".

Notes are in `mirror_applied_batches.notes`.

### The guard

Three triggers on each replicated table (`mirror_row_guard`) refuse an insert, update or delete of a `mirror` row from any transaction but the applier's. An update is allowed when only the deployment's own columns on a claim differ. The triggers fire only for mirrored rows, so they do nothing where there are none.

The applier identifies itself with a setting that lasts for its transaction. That stops a code path that forgets a row is mirrored. It does not stop someone with SQL access who sets the setting by hand.

### How current the mirror is

`GET /mirror/status` (`get_mirror_status` on MCP), mounted only on a deployment that mirrors: `public_graph_as_of`, the sequence and hash of the newest batch, when it was applied, whether a snapshot is only partly applied, how many mirrored claims a search can find, and the last refusal since. A refusal that names a row this deployment holds (`id_collision`, `row_refused`) is served with a message that says only that a row could not be written, because the row may be at a label the reader does not hold; `npx tsx scripts/mirror.ts status` prints the full reason for the operator.

## Beside a deployment's own rows

A private deployment holds the public graph's rows and its own in the same tables: a version of a judgment at a private label beside the public assessment, a private node with a public premise, a private source at an address the public graph also holds. This section is how the two live together. None of it runs on a deployment that does not mirror (`holdsMirror` in `src/services/mirrored-node-service.ts`): no query is made and no statement changes.

### The applier and the wall

Where a deployment has more than one label, the database holds every connection to a clearance ([architecture.md](architecture.md), "Labels and clearance"). The applier works at system clearance, on the tables' owner's connection (`withSystemClearance`; `tests/unit/db/system-clearance.test.ts` has its reason). It has to see a row at any label that points to a row it removes, and the rows it writes belong to no run. Everything it writes is `public` and `mirror`, and it names both: on such a deployment a row is never public by omission.

It changes one thing of the deployment's own. A judgment recorded here at a mirrored node's own label stands where the public graph's must (one current judgment for a node at a label). Nothing in the application records one, and a row that got there some other way is retired to history, not deleted, before the mirrored current row is written. The batch's notes say so (`local_judgments_retired`).

### Identity is per graph

A deployment's row and a mirrored row can say the same thing: a source at one address, an edge between the same two public claims. Before this, such a pair collided on a unique key and the batch was refused. Now every key a replicated table has besides its id ends with `origin`, after the row's label, so both stand and the mirrored row always applies. On the public graph every row is `local` and each index holds what it held.

| Table | Key | What a read does with a pair |
| --- | --- | --- |
| `sources` | address | A read by address takes one row: the deployment's own where it is at the label of the work in progress (what that label wrote), else the public graph's, else a row of the deployment's own at a label the work reads, the lowest first (`oneSourceForAddressSql`). A read of either says how it stands to the other (`public_graph_source_id`, or `mirrored`). |
| `claim_relationships` | parent, child, relation | A node's read lists the edge once: the public graph's row, with what the deployment wrote for its own beside it (`also_recorded_here`). |
| `claim_links` | the pair and the kind | Both rows are listed. |
| `answer_relations` | question and the pair | Both rows are listed. |
| `argument_subclaims` | argument and edge (the primary key, which ends with the label and `origin`) | One premise where an argument's premises are listed. |
| `quantity_cuts` | the claim (the primary key, which ends with the label and `origin`) | A read takes one cut for a claim by the rule a source's address has (`oneCutForClaimSql`). `record_cut` is refused once the public graph holds a cut for the claim. |
| `quantity_definitions` | the quantity (the primary key, which ends with the label and `origin`) | No pair arises: a mirrored node's kind and definition are the public graph's, and defining it here is refused. |
| `source_segments` | document and position | No pair arises: a mirrored document is not segmented here, and work at a label anchors its instances to the segments that came with the mirror. |
| the four judgment tables | node, and label where there is more than one | No pair: the judgment of a mirrored node at its own label is the mirrored row. |

A pair arises only when the deployment recorded the thing first. A run that records an edge or a link the public graph already holds is given the public graph's. Tags are not mirrored, so there is nothing to collide with.

None of this is special to the mirror. The mirror is the lowest layer of a deployment's graph, and the same holds between a label and a label it reads: each key above also holds `sensitivity_label`, a write goes by the row a layer below already holds, and a read gives one row or lists the thing once by the rule in the table ([architecture.md](architecture.md), "Each layer keeps its own identity"; `src/services/layer-service.ts`). What this section calls "the deployment's own" row is, between labels, the higher label's, and "the public graph's" is the row of the label it reads.

### What a run can and cannot do to a mirrored node

Three rules, each with its reason.

- **Nothing here changes a mirrored row.** The next batch would overwrite the change, and until then readers would take it for the public graph's own. The database refuses it whatever the label (`mirror_row_guard`, and for a run at a private label `minerval_own_label_guard` would refuse too). An agent is told one thing whichever would have fired (`mirroredRowMessage`), with what it can do instead.
- **The judgment of a mirrored node at the node's own label is the mirrored row.** No run records an assessment, an estimate, an answer or an argument's evaluation at `public` on a mirrored node, and no work on the node at `public` is opened, funded or run: no ledger row, no slot, no order, no commission, no note to its Steward, no request to the Curator anchored on it. A second public assessment made here would be the deployment's own, on the same public evidence, shown to readers as the public graph's. A fresh public assessment is funded on the public graph.
- **What a run adds is a row of its own, at its own label.** An argument, an edge, a source, and at a label other than the node's a version of the judgment, or the record that the public one was examined at that label and left standing ([architecture.md](architecture.md), "A judgment at each label").

The Steward's tools against a mirrored node, for a run at a private label that reads `public`. `tests/db/private-on-mirror.test.ts` drives each of them but four: `add_decomposition_edge` and `add_parent_claim`, which call the Matcher and so a model, and `update_question_assessment` and `set_argument_shows`, which go through the same seams as the tools beside them.

| Tool | On a mirrored node |
| --- | --- |
| `update_claim_assessment`, `update_quantity_estimate`, `update_question_assessment`, `evaluate_argument` | Records the run's own version at its label. At the node's own label: refused, with the reason. |
| `leave_judgment_standing` | Records that the run's label examined the node and left the public judgment standing for its readers. At the node's own label: refused, with the reason. |
| `record_claim_instance`, `record_argument_instance`, `add_argument`, `add_relationship_edge`, `add_related_claim`, `add_decomposition_edge`, `add_parent_claim` | Adds a row at the run's label. An edge or a link the public graph already holds is not recorded again. |
| `log_stewardship_decision`, `escalate_to_curator`, `notify_steward`, `file_request` | Works at the run's label. A note to a mirrored node's Steward at the node's own label is refused: nobody here runs that pass. |
| `update_canonical_form`, `set_claim_importance`, `set_claim_domains`, `set_quantity_definition` | Refused with the one message. |
| `record_cut` | Records the run's cut at its label, beside any the public graph later records for the claim. Refused with the one message once the public graph holds the claim's cut. |
| `write_argument`, `revise_argument`, `retire_argument`, `update_claim_instance`, `detach_claim_instance`, `set_instance_order`, `remove_subclaim_edge`, `set_edge_relation`, `ungroup_subclaim`, on a row the public graph recorded | Refused with the one message. On a row the run's own label recorded, they work as anywhere. |

The tools are offered as on any node. A tool is refused when it is used on what the public graph holds, and the run's brief says so beforehand.

A member who orders, funds or asks for a decomposition of a mirrored node without naming a label is refused (409, `PUBLIC_GRAPH_NODE`) and told why and what to do: fund the public assessment on the public graph, at the address the feed gives, or name a label that reads `public` to have the node assessed on the deployment's own material. A contribution to a mirrored node is filed at the node's own label, so it is refused the same way (`POST /contributions` and `submit_contribution`, before anything is counted against the contributor): its review, and what the node's Steward would do with it, are work at `public` on a node the public graph judges. The member is told to contribute on the public graph, and that the deployment's own material is weighed by an assessment at a label that reads `public`.

### Kept current

After a sync the applier's worker, and `scripts/mirror.ts`, call `afterMirrorApplied` (`src/services/mirror-upkeep.ts`) with what the batches returned (`ApplyResult.nodes`). It looks at those nodes and no others, and everything it does opens work on the ledger or raises a request. Nothing runs that is not funded.

- **A node's public judgment was replaced.** Each version at another label records the versions it was made beside. Its read now shows it as made against an earlier one, from the record, and its reassessment is opened at its own label and nowhere else (`version-upkeep.ts`, for the nodes the batch names). Where a label had examined the node and left the public judgment standing, the read and the page now say the question is open again at that label, and a reassessment is opened there the same way.
- **A node was reworded, or an argument on it was added, rewritten, retired or removed.** The mirror overwrites these in place, so the applier writes what it replaced to `mirror_node_changes` in the batch's own transaction. The Steward's note of what has changed since its version reads it at its next pass, for the node itself and for the mirrored nodes under it (`src/llm/agents/mirror-changes-note.ts`). Edges, sources and judgments under a node are compared as before, from the record a judgment keeps of its inputs.
- **A node was merged into another.** What the deployment recorded on the merged node stays there. Whether a judgment of one wording holds for another is a judgment, and a merge with a denial reverses every stance, so nothing is moved mechanically: a batch says that a node was merged and not whether it was merged with its denial. (A merge made by this deployment's own Curator knows which, and moves every label's rows; [architecture.md](architecture.md), "A merge under more than one label".) A pass is opened, at each label that had something of its own on the merged node, on the node it was merged into, with a message that says what was recorded and where. The Steward of each node that had the merged node under it by an edge of the deployment's own is told the same way.
- **A node was withdrawn**: deleted upstream, or no longer active there. It is kept here, not active, with what the deployment recorded on it, and a read of it says so (`mirrored.withdrawn_as_of`). No work is opened on a node that is not active, on this graph as on the public one, so a version on it stands as it is and reads as made beside a judgment that is gone. The Steward of each node that has it as a premise by an edge of the deployment's own is told, and a pass opened.

### Convergence

The Matcher's searches read the mirror and the deployment's own nodes together, at the run's clearance, so a private question about a public claim links to the public node. When the public graph later mints a claim that a node of the deployment's own already states, the batch that brings it pairs each of the deployment's nodes with the nearest node that arrived, and asks the Curator about a pair above the reconcile scan's similarity floor, at the deployment's node's label (`scanArrivedPublicNodes`, which raises it through `raiseConvergence`, the one act for a node and a node a layer below it; between two labels the reconcile-candidate scan raises the same request at the label that reads both). If the Curator judges them one, its ordinary `merge_claims` with the public node as the survivor folds the deployment's node into it: its sources, arguments and edges move to the public node, each row at the label it has, the mirrored rows are untouched, and the label's Steward then records its version on the public node. A mirrored node is never the one merged away: `merge_claims` refuses and says to merge the other way.

### What a run and a reader are told

A run is told in its brief, and nowhere else (`src/llm/label-note.ts`): which of what it reads is the public graph's and as of when, that no run changes it and why, that the judgment of a mirrored node at its own label is the public graph's, and that a mirrored node it thinks is wrong is a request, which stays in the deployment. These are sentences inside the note about the run's label, beside the sentences they qualify. A deployment that mirrors and has one label gets them as a short passage of their own.

A read of a node says that it is mirrored and as of when (`mirrored.public_graph_as_of`, with the node's address on the public graph where the feed gives one), beside its `label` and the `versions` of its judgment.

### What this does not do

- A link or an answer relation the deployment recorded and the public graph then recorded too is listed twice where links and answer relations are listed. The Steward at that label can remove its own.
- `mirror_node_changes` is not pruned.
- A deployment that stops mirroring by unsetting its feed keeps its mirrored rows and the database's guard on them, but the application then asks nothing about them: it no longer says what is mirrored.
- A request the deployment's own agents record about a mirrored node goes no further than the deployment until someone raises it on the public graph. The public graph's own requests do come in with the feed, and can be adopted ([outward-acts.md](outward-acts.md)).

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

- A price for the feed.
- Recomputing mirrored vectors for a deployment with its own embedding model.
- Tags, provenance, mathematics, the reasoning of contribution reviews and the work done on requests in the feed.
