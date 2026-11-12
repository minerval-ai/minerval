import { enforcementLastKnown } from "../db/clearance.js";
import { currentReadClearance, rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { getUsageContext, runAtLabel } from "../llm/usage-context.js";

/**
 * Whether `public` is the only label this deployment has: no row in `labels`
 * names any other. True on the public graph, false as soon as a deployment
 * defines a label of its own.
 *
 * Where it is true, every piece of work the deployment holds is public,
 * whatever it says about itself, because there is no other label it could
 * have been created at. That is the one case in which work that carries no
 * label can be run as public without guessing (the claim pipeline's
 * messages from before the label field, workers/claim-pipeline.ts).
 *
 * It reads the table each time and remembers nothing: a deployment may
 * define its second label at any moment, and an answer kept from before
 * would let unlabeled work through as public afterwards. The read is one
 * row at most, and it is asked only for work that arrives without a label.
 */
export async function publicIsTheOnlyLabel(): Promise<boolean> {
  const others = await rawQuery(`SELECT 1 FROM labels WHERE name <> $1 LIMIT 1`, [PUBLIC_LABEL]);
  return others.length === 0;
}

/**
 * Every label this deployment has, `public` first: for a sweep that works
 * label by label. A sweep that looks for something to say about a node
 * (a candidate for audit, a partition due a consistency sweep, how many
 * reports are waiting) and then writes it down has to find it with the
 * clearance of the label it writes at, or the words it writes are made of
 * rows that label's readers may not read. So it does not look once with
 * every label in sight: it looks once for each label, inside that label
 * (runAtLabel), and writes there what it found there.
 *
 * Where this process knows of no label but `public` nothing is asked.
 */
export async function everyLabel(): Promise<string[]> {
  if (enforcementLastKnown() !== true) return [PUBLIC_LABEL];
  const rows = await rawQuery<{ name: string }>(`SELECT name FROM labels`);
  const names = rows.map((r) => r.name).filter((name) => name !== PUBLIC_LABEL);
  return [PUBLIC_LABEL, ...names.sort()];
}

/**
 * A key that says which piece of work something is, at a label: the plain
 * key at `public`, and the key with the label after it elsewhere, as a
 * ledger group has (groupAtLabel in ingest-focus-service.ts). For a key
 * that is unique across a table whatever the labels (an audit's dedupe
 * key), so that one label's work neither stands in for another's nor
 * collides with it.
 */
export function keyAtLabel(key: string, label: string): string {
  return label === PUBLIC_LABEL ? key : `${key} @${label}`;
}

/**
 * Whether a label is defined: a row in `labels` has this name. The rows
 * that carry a label never need to ask, because their foreign key answers
 * it when they are written. A queue message has no foreign key, so what
 * picks one up asks before it runs anything at the message's label.
 */
export async function labelIsDefined(name: string): Promise<boolean> {
  const rows = await rawQuery(`SELECT 1 FROM labels WHERE name = $1`, [name]);
  return rows.length > 0;
}

/**
 * Run `fn` at a claim's label: for work that starts from the claim itself.
 *
 * Most work waits in a row of its own (a job, a ledger action, an order) and
 * runs at that row's label. Some has no such row: a sweep finds a claim that
 * is pending, stale or untagged and starts work on it there and then. That
 * work used to run with no label and so wrote as public, whatever the claim
 * was. The claim is the only thing that says what the work is about, so its
 * label is the one the work runs at, whatever context the sweep itself is in.
 *
 * This is the label of the node's own work. Work asked for at another
 * label that reads the node (an internal pass on a public claim) does not
 * come this way: it waits in its own slot and its own ledger row, each at
 * its label (services/steward-lease.ts), and runs at that row's label.
 *
 * A claim that does not exist has nothing to run at: `fn` runs as it would
 * have and finds that out for itself.
 */
export async function runAtClaimLabel<T>(claimId: string, fn: () => Promise<T>): Promise<T> {
  const [claim] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!claim) return fn();
  return runAtLabel(claim.sensitivity_label, `claim ${claimId}`, fn);
}

/**
 * Run `fn` at a source's label: for work that starts from the source itself.
 *
 * The same floor as runAtClaimLabel, for documents. A worker finds a source
 * with no facts, no stored text or no segments and fills them in. That does
 * not wait in a row of its own, so it used to run with no label, and
 * whatever it wrote about a restricted document was public. The source is
 * the only thing that says what the work is about, so its label is the one
 * the work runs at, whatever context the worker itself is in.
 *
 * What the work writes into the source's own row (the fetched text, the
 * facts) lands on a row already there and leaves its label alone. The label
 * is read here and never written. The document's segments and the notices
 * against it do not depend on this at all: they carry the source's label
 * by their own rule, whoever produces them (src/labels.ts).
 *
 * It is a floor and not the whole rule. It keeps a worker's writes about a
 * restricted source from being public. It does not cover a restricted run
 * reading a public source: that run's judgments are stamped with its label
 * like any other, but the text it fetches lands in the public row, and an
 * instance has one current reading whoever wrote it. Telling those apart
 * takes more than one copy or one reading per document, which is later
 * work.
 *
 * A source that does not exist has nothing to run at: `fn` runs as it would
 * have and finds that out for itself.
 */
export async function runAtSourceLabel<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const [source] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (!source) return fn();
  return runAtLabel(source.sensitivity_label, `source ${sourceId}`, fn);
}

/**
 * Run `fn` at a mandate's label: for the mandate's own work.
 *
 * A mandate decides for its work. Its plan becomes ledger rows, its review
 * and planning passes are opened, its inbox is worked and its events are
 * collected by sweeps that run outside any run, and that work used to be
 * written as public, or at the label of whichever claim a plan item named.
 * The mandate carries a label of its own now (grants.sensitivity_label, the
 * label of the request or run that created it), and the mandate is what
 * says whose work this is, so its label is the one the work runs at.
 *
 * A mandate that does not exist has nothing to run at: `fn` runs as it
 * would have and finds that out for itself.
 */
export async function runAtMandateLabel<T>(grantId: string, fn: () => Promise<T>): Promise<T> {
  const [grant] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM grants WHERE id = $1`,
    [grantId]
  );
  if (!grant) return fn();
  return runAtLabel(grant.sensitivity_label, `mandate ${grantId}`, fn);
}

/**
 * runAtMandateLabel for code that is reached both from a sweep and from
 * inside a run (materializing a plan, placing a standing order: the
 * scheduler does both, and so does a Grantmaker's tool). Inside a run the
 * work is that run's and keeps its label, and a Grantmaker's run was itself
 * opened at its mandate's label. Only where nothing has set a label does
 * the mandate's stand in.
 */
export async function runAtMandateLabelOutsideAnyRun<T>(grantId: string, fn: () => Promise<T>): Promise<T> {
  if (getUsageContext().label !== undefined) return fn();
  return runAtMandateLabel(grantId, fn);
}

/**
 * Run `fn` at a lookout's label: for the feed poll, which a timer runs for
 * the lookout outside any run, and which a run that reads the lookout may
 * also start. What the poll records (the items it sees, the wake it
 * queues, the ingests an auto_ingest feed raises, the feed's own
 * bookkeeping) is the lookout's work and is the same whoever started it,
 * so it is written at the lookout's label. A lookout the work in progress
 * may not read has nothing to run at: `fn` runs as it would have.
 */
export async function runAtLookoutLabel<T>(lookoutId: string, fn: () => Promise<T>): Promise<T> {
  const [lookout] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM lookouts WHERE id = $1`,
    [lookoutId]
  );
  if (!lookout) return fn();
  return runAtLabel(lookout.sensitivity_label, `lookout ${lookoutId}`, fn);
}

/** One label as the place where a label is chosen shows it. */
export interface ChoosableLabel {
  name: string;
  description: string;
  /** The other labels whose material a reader of this one also reads. */
  reads: string[];
  /** Every member of the deployment reads it. True of `public` alone. */
  read_by_everyone: boolean;
  /**
   * The other labels whose readers also read this one, as far as the asker
   * may know them: only labels the asker reads are named.
   */
  also_read_from: string[];
  /** How many more labels read this one that the asker may not read, and so are not named. */
  also_read_from_others: number;
  /** The same, as a sentence or two a person can be shown. */
  who_reads: string;
}

const quotedList = (labels: readonly string[]): string => {
  const names = labels.map((l) => `"${l}"`);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
};

/** Who reads material filed at a label, in words (the `who_reads` of a ChoosableLabel). */
export function whoReads(label: Pick<ChoosableLabel, "name" | "also_read_from" | "also_read_from_others">): string {
  if (label.name === PUBLIC_LABEL) {
    return "Every member of this deployment can read it and can open its sources.";
  }
  const also: string[] = [];
  if (label.also_read_from.length > 0) also.push(`at ${quotedList(label.also_read_from)}`);
  if (label.also_read_from_others > 0) {
    const n = label.also_read_from_others;
    also.push(`at ${n} ${also.length > 0 ? "more " : ""}label${n === 1 ? "" : "s"} you are not cleared to read`);
  }
  return (
    `People granted the permission to read at "${label.name}" can read it` +
    (also.length > 0 ? `, and so can people granted it ${also.join(" and ")}, which read${label.also_read_from.length + label.also_read_from_others === 1 ? "s" : ""} "${label.name}"` : "") +
    `. A source filed here can be opened in full only by people who also hold the permission to ` +
    `open raw sources at "${label.name}". The others read what the agents wrote from it.`
  );
}

/**
 * The labels the work in progress may file new material at, with what a
 * page or an agent needs to say what each one means: its description, what
 * it reads, and who reads it. They are the labels the request reads: a
 * person's clearance, or for a key, a token or the Assistant, what that
 * credential's one label reads within it.
 *
 * Which labels read a label is worked out for every label the deployment
 * has, and then only the ones the asker reads are named: the name of a
 * label a person may not read is not theirs to learn (as in the
 * administrators' log), and the count says that there are some.
 */
export async function choosableLabels(): Promise<ChoosableLabel[]> {
  const readable = (await currentReadClearance()) ?? [PUBLIC_LABEL];
  const rows = await rawQuery<{ name: string; description: string; reads: string[] }>(
    `SELECT l.name, l.description, minerval_labels_readable_from(ARRAY[l.name]) AS reads FROM labels l`
  );
  const mine = new Set(readable);
  const byName = new Map(rows.map((r) => [r.name, r]));
  return readable
    .filter((name) => byName.has(name))
    .sort((a, b) => (a === PUBLIC_LABEL ? -1 : b === PUBLIC_LABEL ? 1 : a < b ? -1 : 1))
    .map((name) => {
      const row = byName.get(name)!;
      const readers = rows.filter((r) => r.name !== name && r.reads.includes(name)).map((r) => r.name);
      const facts = {
        name,
        also_read_from: name === PUBLIC_LABEL ? [] : readers.filter((r) => mine.has(r)).sort(),
        also_read_from_others: name === PUBLIC_LABEL ? 0 : readers.filter((r) => !mine.has(r)).length,
      };
      return {
        ...facts,
        description: row.description,
        reads: row.reads.filter((r) => r !== name).sort(),
        read_by_everyone: name === PUBLIC_LABEL,
        who_reads: whoReads(facts),
      };
    });
}

/**
 * The names among `names` that are not defined: no row in `labels` has
 * them. For a setting that names labels (PROVIDER_LABELS,
 * src/provider-labels.ts), which has no foreign key either.
 */
export async function undefinedLabels(names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await rawQuery<{ name: string }>(`SELECT name FROM labels WHERE name = ANY($1::text[])`, [
    [...names],
  ]);
  const defined = new Set(rows.map((r) => r.name));
  return names.filter((name) => !defined.has(name));
}
