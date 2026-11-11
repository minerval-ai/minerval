/**
 * Labels: who may read a row.
 *
 * A private deployment of this code is the public graph with redaction: the
 * same tables and the same agents, where a row carries a label and a reader
 * or an agent run reads only the labels it is cleared for. A judgment, a
 * source and an agent run each carry one (the `label` column).
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
 * The public graph has one label, the one named here, and no pairs. Nothing
 * reads a label yet: the rows carry them and the writes stamp them, and
 * holding a reader or a run to its clearance is later work.
 */

/** The label of everything on the public graph, and of any write made outside a run. */
export const PUBLIC_LABEL = "public";
