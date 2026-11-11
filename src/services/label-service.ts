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
 * claim from being written as public. It does not cover restricted work on
 * a public claim (a restricted pass that left the claim pending would be
 * taken up here as public), which needs the claim's pending slot, or one
 * judgment per label, to say what label the work was asked for at.
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
 * runAtClaimLabel for code that is reached both from a sweep and from inside
 * a run (placing a mandate's standing order, for one). Inside a run the work
 * is that run's and keeps its label, as all work a run creates does. Only
 * where nothing has set a label (a sweep, or a request that carries none)
 * does the claim's label stand in.
 */
export async function runAtClaimLabelOutsideAnyRun<T>(claimId: string, fn: () => Promise<T>): Promise<T> {
  if (getUsageContext().label !== undefined) return fn();
  return runAtClaimLabel(claimId, fn);
}
