/**
 * The money on the ledger is read whole.
 *
 * An allocation (`action_allocations`) is money placed on a ledger row, and
 * a regrant (`regrants`) is money moved from one mandate to another. Both
 * tables carry a label, because both hold text an agent wrote: a
 * commission's brief and reason, a regrant's note. Where a deployment has
 * more than one label the database shows a connection only the rows at
 * labels it reads (db/clearance.ts).
 *
 * The money on those rows cannot be read that way. One ledger row is paid
 * for by whoever placed money on it, at whatever label: work at one label
 * joins a row another label opened. What a run costs is split across every
 * allocation that covers it, a mandate's room is its budget less everything
 * it has placed, and a refund is what was placed and not spent. Each of
 * those sums is wrong if it is taken over the allocations one label reads,
 * and wrong in the direction that spends the same money twice.
 *
 * So there are two ways to read each table, and a statement says which it
 * means by the name it uses:
 *
 *   minerval_whole.allocation_money   every allocation, without brief and
 *   minerval_whole.regrant_money      reason; every regrant, without note.
 *                                     For sums, coverage, settlement, and
 *                                     the updates that release and spend.
 *
 *   action_allocations, regrants      the tables, under the label policies.
 *                                     For adding a row, which is held to
 *                                     its writer's label, for reading the
 *                                     text, and for a listing or a feed
 *                                     shown to a reader, who is shown the
 *                                     rows at the labels they read.
 *
 * The views are not read-only, because settling money changes rows at every
 * label. A connection held to a clearance may update through them exactly
 * the columns settlement writes (an allocation's amount, what of it is
 * spent and when it was released; a regrant's amount and what came back),
 * and may delete a regrant that is returned in full. It may change no other
 * column through them (not the ledger key, not who commissioned), add no
 * row, and delete no allocation. The database grants it that and no more.
 *
 * The views exist on every deployment (the migration that labelled the
 * tables made them) and are planned as the tables they are over, so on the
 * public graph a statement through one is the statement it always was.
 *
 * A statement on a bare table is listed in tests/unit/db/ledger-money.test.ts
 * with what it is there for. That test fails on one that is not: the usual
 * mistake would be a sum over the table, which is right on the public graph
 * and short on a deployment with a second label.
 */
export const ALLOCATION_MONEY = "minerval_whole.allocation_money";
export const REGRANT_MONEY = "minerval_whole.regrant_money";
