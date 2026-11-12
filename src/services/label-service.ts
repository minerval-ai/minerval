import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";

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
