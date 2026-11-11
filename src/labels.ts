/**
 * Labels: who may read a row.
 *
 * A private deployment of this code is the public graph with redaction: the
 * same tables and the same agents, where a row carries a label and a reader
 * or an agent run reads only the labels it is cleared for. A judgment, a
 * source and an agent run each carry one, in the `sensitivity_label` column.
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
 * A row gets its label from the run or the request that writes it
 * (currentLabel in llm/usage-context.ts), the way an assessment gets its
 * funder and its model. An agent never chooses one.
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
