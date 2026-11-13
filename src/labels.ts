/**
 * Labels: who may read a row.
 *
 * A private deployment of this code is the public graph with redaction: the
 * same tables and the same agents, where a row carries a label and a reader
 * or an agent run reads only the labels it is cleared for. A judgment, a
 * source, an agent run and each row of the graph's own content (a node, an
 * edge, an argument, a tag, a definition, a formal statement, the record of
 * what a judgment rested on) carry one, in the `sensitivity_label` column.
 * So does everything read from a source or written about one: a passage
 * recorded from it, a reading of that passage, the document's segments, a
 * notice against it, the edges that say what draws on what, an examination
 * and its findings, a recorded stake, a page analysis kept for the next
 * reader, a feed item waiting to be read.
 * And so does what a run writes about itself: each step of its transcript,
 * the usage row of each model call, the parts of its setup, an
 * investigation it launches, a report or a finding it files and each later
 * sighting of one, an audit it asks for.
 * And so do the rows that work is asked for and governed with: a request
 * and the work recorded on it, a message in a node's inbox, a petition, a
 * mandate with its decisions, its events and its policy, the conversations
 * a mandate is drafted in and the ones a user holds with their Assistant, a
 * page kept for a user, a review and a ruling, an audit's findings and the
 * audit trail on a claim, a sweep and its flags, a bounty and a prize
 * claim, a lookout and a correspondent with what each queues, flags and
 * publishes. And so do the rows of a connection to an organization's own
 * system (src/connections.ts): the connection, the tools its server lists,
 * and each call a run makes through it. The connection's label is named by
 * the administrator who adds it and says which runs are offered it. A tool's
 * definition is the system describing itself, the same whoever looks, so it
 * carries the connection's label, and so does what any run finds out about
 * the connection (that its server answered, that a tool changed). A call,
 * and the source kept from one, are the run's: its arguments are the run's
 * own words. A set of files (src/file-sets.ts) is the same: the set's
 * label is named by the person who adds it, its manifest and a file kept
 * from it are the set's own material and carry the set's label whichever
 * run keeps the file, and a command a run runs against it, with the
 * analysis kept from one, is the run's. The tables that carry none are the accounts and their keys,
 * the owl ledger and what is paid from it, the platform's own switches and
 * counters, and the labels themselves.
 * The column is not simply `label` because that name is already a display
 * name on tables that will need a label too (actions.label,
 * source_segments.label), and one name has to be free on every table.
 * Everywhere else the concept keeps its short name: the `labels` table, the
 * run context's `label`, the `label` in a run's logged setup.
 *
 * A label is a row in the `labels` table, not a value in a list here. A
 * deployment defines its own, and may define several restricted ones that
 * have nothing to do with each other, so labels have no order: no code may
 * assume which labels exist or compare two of them by rank. Which labels a
 * holder of one label may also read is data as well, the pairs in
 * `label_reads` (cleared for `label`, may also read `reads`). A label always
 * reads itself, which needs no pair.
 *
 * A row gets its label in one of two ways, and an agent never chooses it.
 *
 * What a run writes carries the run's label: the label of the run or the
 * request that writes the row (currentLabel in llm/usage-context.ts), the
 * way an assessment gets its funder and its model. Nothing is inherited
 * from the row a new row hangs from: an argument written at a restricted
 * label on a public claim is restricted, and so is the edge that joins a
 * restricted subclaim to a public parent. A reading of a source is the
 * reader's in the same way: a passage a restricted run records from a
 * public document is restricted, and so are its reading of it, the
 * examination it opens and the stake it records. A row's label never
 * changes, and a row is changed or deleted only by work at its own label:
 * a write that would land on a row at another label (an upsert, a plain
 * update) writes nothing and says so, because what it wrote would be read
 * by that row's readers as their own label's work (the database's
 * own_label_guard behind every write). What a label has to say about a
 * row at another label is a row of its own.
 *
 * Each layer keeps its own identity. A graph at a label is that label's
 * own rows over the graph of the labels it reads, down to the public
 * graph's rows in the mirror. A key a labelled table has besides its id
 * (an edge's two nodes and relation, a source's address, a tag's slug, a
 * claim's cut, an instance's reading) holds the label, so a row at one
 * label and a row for the same thing at another are two rows. Work at a
 * label is never stopped by a row at a label it does not read, and is
 * told nothing of it. Work at a label that does read a row for the thing
 * goes by that row: it is handed it, or refused where it would revise it,
 * and records no second one. Where the higher label recorded the thing
 * first and the lower one later, both stay, and a read gives the thing
 * once (services/layer-service.ts has the rule, for every table and for
 * the mirror alike). The text and the facts a fetch writes into a source's own row are
 * the same whoever fetches, and are written at the source's label.
 *
 * A judgment at each label. A node may carry one current judgment at each
 * label: a version, in the table its kind keeps, and so may an argument's
 * evaluation. A run writes its own label's version and no other, made
 * without sight of anything its label does not read, and a version is
 * replaced only by work at its own label, so each stays current for the
 * readers and runs that go by it. On a node that carries another label,
 * the Steward at a label records its own version or leaves the one it
 * reads standing for its readers, and that it did so is recorded
 * (services/left-standing-service.ts). Nothing tests what its label has
 * attached to the node: whether that bears is its judgment.
 * A reader, like a run, goes by the versions in force for it: among the
 * current versions it may read, every one that no other was made at a
 * label reading its own. Two labels that do not read each other may each
 * have one in force for a reader who holds both, and nothing is merged.
 * Each version records the versions it was made beside, and when one of
 * those is replaced it is shown as made against an earlier one and its
 * reassessment is opened on the ledger at its own label. The rule is the
 * database's (db/schema.ts, the *_in_force and *_versions views), and
 * services/judgment-version-service.ts is the application's side of it.
 *
 * A step of a run's transcript is the run's in the strictest sense: it
 * carries the label the run was opened at, which the run's handle keeps
 * (AgentTrace.label in services/trace-service.ts), and not the label in the
 * air when it is written. Steps are written from a queue, later than they
 * are claimed, and a step can be recorded from inside work that set another
 * label; it is a step of its run either way. The transcript is the most
 * sensitive thing a run leaves, so its label does not depend on timing.
 *
 * A part of a run's setup (the constitution, a role prompt, a tool's
 * descriptor) is stored once, under the hash of its text, and shared by
 * every run that used the same text. It carries the label of the run that
 * stored it first (storeSetupParts in services/setup-service.ts). It is
 * not derived from any row whose label it could take, and nothing tells
 * the repository's own text, the same whoever asks, from text a deployment
 * wrote for itself. So a text first used by a restricted run stays
 * restricted for the public runs that use it afterwards. Telling those
 * apart takes a key with the label in it, which is later work.
 *
 * What is derived mechanically from a row, with no judgment of the run in
 * it, carries that row's label. A document's segments are computed from
 * its text, and a notice against it (a correction, a retraction) is looked
 * up about it. Both are the same whoever asks, so `source_segments` and
 * `source_events` carry the source's label, whichever run or worker
 * produced them (segmentSource in services/source-segment-service.ts,
 * recordSourceEvent in services/source-facts-service.ts). A document has
 * one segmentation and a notice is recorded once. Stamped with the label
 * of whoever asked first, a restricted run that opened a public document
 * would leave it with restricted segments, and the notice it recorded
 * would keep the same notice from being recorded for everyone else. The
 * test for this rule is that the row would be the same whoever produced
 * it. A row that says what a run concluded, chose or was asked to do is a
 * judgment and takes the first rule: an instance, a reading, a provenance
 * edge, an examination and its findings, a recorded stake, and the record
 * of an extraction, which holds what that run proposed and whose focus it
 * read for.
 *
 * A run works at the label of the work that started it. Most runs are not
 * opened by the code that decided they should happen: a job is enqueued and
 * a worker picks it up, a ledger action is funded and an executor runs it, a
 * paused session is resumed. So the rows that stand for work waiting to be
 * done carry a label too (jobs, actions, assessment_orders, budget_jobs,
 * contributions, appeals, agent_sessions, assistant_held_actions, and the
 * claim pipeline's queue message). Each is stamped from currentLabel when
 * it is created, and whatever picks it up opens its run at the row's label
 * (runAtLabel in llm/usage-context.ts). Work that a run enqueues therefore
 * keeps the run's label, and so does the work that work enqueues, with no
 * code of its own for the hand-over.
 *
 * Some work has no row of its own to wait in. A sweep finds a claim that is
 * pending, stale or untagged and starts work on it there and then: the
 * scheduler's reconcile sweep and its staleness check, the Steward's
 * fallback lane, the Tagger, the reconcile-candidate scan, the monitor's
 * audits. That work runs at the claim's label (runAtClaimLabel in
 * services/label-service.ts), so work on a restricted claim is never
 * written as public. So does the letter that tells a node's Steward of a
 * notice against a source the node rests on
 * (services/source-notice-service.ts), whether the retraction poll found
 * the notice or a run's fetch of the document did: the letter is the same
 * whoever found it and is sent once, so it goes at the node's label and
 * not the finder's. That is the node's own work. Work on a node at another
 * label that reads it (an internal assessment of a public claim) is keyed
 * by that label throughout, so that it neither waits on the node's own
 * work nor shows itself to readers of the node's label: its ledger rows
 * have that label's own key (groupAtLabel in services/ingest-focus-service.ts,
 * for a node's assess, curate and formalize groups, a document's ingest
 * and a partition's sweep), its Steward's slot is a row of its own
 * (steward_slots, services/steward-lease.ts), an order is one for each
 * person, node and label, and a message waits for a pass at the label it
 * was sent at and is read by no other.
 *
 * Other work belongs to a row that carries a label of its own, and runs at
 * that row's label whichever sweep, timer or run happens to start it. A
 * mandate decides for its work: the rows its plan becomes, its planning
 * and review passes, the wake that reopens a review, the events collected
 * for it and the sittings on its inbox are opened at the mandate's label
 * (runAtMandateLabel), not at the label of a claim or a source a plan item
 * names. A lookout and a correspondent decide for theirs: their runs, a
 * lookout's feed poll and what it records, and the inputs a timer queues
 * for either. A request decides for the ledger rows that scope it, take it
 * up and bring it back to its keeper, so the research and the review of a
 * document that a request pays for run at the request's label. A petition
 * decides for its follow-up, and a paused session for the answers it sends
 * on to its node's inbox when it expires.
 *
 * Three places hold work to one label by reading it, because the work
 * would otherwise cross from one label to another by itself. A Steward's
 * pass resumes only a session of the label the pass runs at. An officers'
 * sitting, which runs at its mandate's label, works only the petitions and
 * inbox items of that label, and one raised at another label waits. And a
 * session takes only an answer of its own label: an answer written by work
 * at another goes to the node's inbox as a message at the answer's label,
 * and the session waits on. None of these asks what a label may read.
 * They keep unlike labels apart until something does.
 *
 * A source is the same kind of carrier. The source backfill finds a
 * document with no facts, no text or no segments and fills them in. That
 * work runs at the source's label (runAtSourceLabel in
 * services/label-service.ts), and it is the same floor: what a worker
 * writes about a restricted source is never public. A restricted run that
 * reads a public source is not covered by it. Its judgments carry its
 * label and the document's segments and notices carry the document's. The
 * text it fetches is stored at the document's label, since it is the same
 * whoever fetches it; text a caller hands over with a submission goes
 * into a row only at the caller's own label. An instance has one current
 * reading at each label, and an address has one source at each: work at a
 * label goes by the row a label it reads already holds, and where it
 * recorded its own first it keeps reading that one
 * (services/layer-service.ts).
 *
 * A carrier whose label is missing is not treated as public: the run is
 * refused (MissingLabelError), because writing private work as public is
 * the mistake the labels exist to prevent, and a refusal is seen where a
 * wrong label is not.
 *
 * One carrier could not be given its label by a migration: a claim pipeline
 * message already waiting in the queue when the label field was introduced.
 * A message with no label field is run as public only where `public` is the
 * only label the deployment has (publicIsTheOnlyLabel in
 * services/label-service.ts), and refused everywhere else. The reasons, and
 * when that path can be deleted, are in workers/claim-pipeline.ts. The
 * message is also the one carrier with no foreign key to hold its label to
 * the table, so the worker checks that the label it carries is defined and
 * refuses the message if it is not (UndefinedLabelError).
 *
 * A person's request is the other thing that writes. It has a clearance,
 * the labels its account was granted to read, and no label until it is
 * given one, and it is given one by rule, never by default
 * (server/request-labels.ts): the label of the row it is about (a
 * contribution's node, a message's conversation, the mandate money is put
 * behind), or the label the person names when they start something new. A
 * request made with an API key or an access token, and each call the
 * Assistant makes for its user, works at the one label that credential was
 * made for: it changes only rows that carry it, and may start work at its
 * own label on a node that label reads. A signed-in person who starts work
 * on a node that is already there (an order, funding, a decomposition) may
 * name a label they hold that reads the node's, and the work is then at
 * that label. No agent chooses a label here either, and a request that
 * should have a label and has none is refused.
 *
 * The public graph has one label, the one named here, and no pairs, and
 * there nothing is held: every query runs as it always did. Where a
 * deployment defines a second label, the database holds every read and
 * write to a clearance, the set of labels a run or a reader may read
 * (db/clearance.ts): a run reads its own label and the labels it reads, a
 * request reads what its account was granted (and, once it has a label,
 * only what that label reads as well), and work with nothing in context
 * reads `public` alone. An insert that names no label is given
 * the label of the connection it arrives on, so a forgotten stamp inside
 * a run lands at the run's label.
 *
 * A deployment may also hold the public graph's own rows, through a mirror
 * (docs/mirror.md). They are `public`, and they are the public graph's:
 * no run changes one, and the judgment of a mirrored node at `public` is
 * the mirrored row, so a run at `public` records none of its own there and
 * a run at another label records its version beside it
 * (services/mirrored-node-service.ts). A mirrored row and a row of the
 * deployment's own never collide: where a table has a key besides its id,
 * the key is unique within each graph (db/schema.ts, the origin column).
 * The mirror is the lowest layer, and what holds between a label and a
 * label it reads holds between a deployment's own rows and the mirror's.
 *
 * One thing is held to a run's label already: where its text may be sent.
 * A model provider or an outside service receives text only from runs at
 * the labels it is cleared for (src/provider-labels.ts), and one that
 * nobody has cleared for a label other than this one is sent none of it.
 */

/** The label of everything on the public graph, and of any write made outside a run. */
export const PUBLIC_LABEL = "public";

/**
 * Work was picked up from a row or a message that carries no label. Thrown
 * instead of running the work as public.
 */
export class MissingLabelError extends Error {
  constructor(work: string) {
    super(
      `${work} carries no label, so it was not run: work runs at the label of what started it, ` +
        `and a missing label is never read as public (src/labels.ts)`
    );
    this.name = "MissingLabelError";
  }
}

/**
 * Work was picked up from a queue message whose label names no row in
 * `labels`. Thrown instead of running the work. A row cannot be in this
 * state, because its foreign key holds it to the table; a message has no
 * such key, so the worker that reads it asks (workers/claim-pipeline.ts).
 */
export class UndefinedLabelError extends Error {
  constructor(work: string, label: string) {
    super(
      `${work} carries the label "${label}", which this deployment does not define, so it was not run: ` +
        `work runs only at a label that is a row in labels (src/labels.ts)`
    );
    this.name = "UndefinedLabelError";
  }
}
