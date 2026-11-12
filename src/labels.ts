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
 * examination it opens and the stake it records. A write that lands on a
 * row already there (an upsert) leaves that row's label as it was, and so
 * does the text or the facts a fetch writes into a source's own row.
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
 * fallback lane, the Tagger, the reconcile-candidate scan, and a mandate's
 * plan when the scheduler materializes it. That work runs at the claim's
 * label (runAtClaimLabel in services/label-service.ts), so work on a
 * restricted claim is never written as public. So does the letter that
 * tells a node's Steward of a notice against a source the node rests on
 * (services/source-notice-service.ts), whether the retraction poll found
 * the notice or a run's fetch of the document did: the letter is the same
 * whoever found it and is sent once, so it goes at the node's label and
 * not the finder's. All of this is a floor, not the whole rule: a pass
 * asked for at a restricted label on a public claim is not told apart from
 * a public one by the claim's pending slot, and those paths take it up as
 * public. Closing that takes one judgment per label, which is later work.
 *
 * A source is the same kind of carrier. The source backfill finds a
 * document with no facts, no text or no segments and fills them in, and
 * the scheduler, placing a mandate's plan, notes a document someone else
 * ingested. That work runs at the source's label (runAtSourceLabel in
 * services/label-service.ts), and it is the same floor: what a worker
 * writes about a restricted source is never public. A restricted run that
 * reads a public source is not covered by it. Its judgments carry its
 * label and the document's segments and notices carry the document's, but
 * the text it fetches lands in the public row, an instance has one current
 * reading whoever wrote it, and a source is still found by its URL
 * whatever its label. Telling those apart is later work too.
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
 * The public graph has one label, the one named here, and no pairs. Nothing
 * reads a label yet: the rows carry them and the writes stamp them, and
 * holding a reader or a run to its clearance is later work.
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
