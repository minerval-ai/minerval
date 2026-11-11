import { rawQuery } from "../db/client.js";
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
 * This is a floor and not the whole rule. It keeps work on a restricted
 * claim from being written as public. It does not by itself cover
 * restricted work on a public claim. Where that work left messages waiting
 * on the claim, their label is used (pendingPassLabel below); where it did
 * not, the claim's pending slot cannot say what label the work was asked
 * for at, which takes a slot, or a judgment, per label.
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
 * Run `fn` at a lookout's label, where nothing has set one: for the feed
 * poll, which a timer runs for the lookout outside any run. What the poll
 * records (the items it sees, the wake it queues, the ingests an
 * auto_ingest feed raises) is the lookout's work. Inside a run (a
 * Grantmaker adding a feed, the lookout reading one) the run's label stays.
 */
export async function runAtLookoutLabelOutsideAnyRun<T>(lookoutId: string, fn: () => Promise<T>): Promise<T> {
  if (getUsageContext().label !== undefined) return fn();
  const [lookout] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM lookouts WHERE id = $1`,
    [lookoutId]
  );
  if (!lookout) return fn();
  return runAtLabel(lookout.sensitivity_label, `lookout ${lookoutId}`, fn);
}

/**
 * The label a pending claim's next pass is opened at, when no ledger row
 * says: for the sweeps that find a claim pending and start its pass there
 * and then (the reconcile sweep, the Steward's fallback lane).
 *
 * A claim is usually pending because messages wait in its inbox, and a
 * message carries the label of whoever sent it. When every unread message
 * on the claim carries the same label, the pass is theirs and is opened at
 * that label: a pass asked for at a restricted label on a public claim is
 * no longer taken up as public once its row has closed. When there is no
 * unread message, or the unread messages carry more than one label, the
 * claim's own label is used, as before (runAtClaimLabel): the claim has one
 * pending slot, not one per label, and it cannot say which of two labels
 * the next pass is for. That pass reads every unread message, whatever its
 * label, and marks them all read. Telling them apart takes a slot, or a
 * judgment, per label, which is later work.
 */
export async function pendingPassLabel(claimId: string, claimLabel: string): Promise<string> {
  const waiting = await rawQuery<{ sensitivity_label: string }>(
    `SELECT DISTINCT sensitivity_label FROM node_messages
      WHERE node_id = $1 AND read_at IS NULL
      LIMIT 2`,
    [claimId]
  );
  return waiting.length === 1 ? waiting[0]!.sensitivity_label : claimLabel;
}
