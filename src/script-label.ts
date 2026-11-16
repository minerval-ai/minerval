/**
 * How a script says what label it works at (src/labels.ts, src/db/clearance.ts).
 *
 * A script is work outside any run. On the public graph that needs nothing
 * said: `public` is the only label, and a row a script inserts without
 * naming one is public. Where a deployment has more than one label, work
 * with nothing in context reads `public` alone, and an insert that names no
 * label is refused, because a row is never public by omission. So a script
 * that writes labelled rows on such a deployment is told its label by
 * whoever runs it:
 *
 *   npm run seed:platform-mandates -- --label internal
 *   MINERVAL_LABEL=internal npx tsx scripts/…
 *
 * and runs its work inside runAtScriptLabel. The script then reads what
 * that label reads, and every row it writes without naming a label carries
 * it, exactly as a run's would. With no label given the work runs as it
 * always did, which is right wherever `public` is the only label.
 *
 * The label is the operator's to give. A deployment's standing mandates,
 * for one, are seeded at whichever of its own labels its ordinary work is
 * at: nothing here knows that name.
 */
import { runAtLabel } from "./llm/usage-context.js";

/** The label a script was given: `--label <name>` on its command line, or MINERVAL_LABEL. Null when neither. */
export function scriptLabel(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env
): string | null {
  const at = argv.indexOf("--label");
  const given = at !== -1 ? argv[at + 1] : env.MINERVAL_LABEL;
  const label = given?.trim();
  return label ? label : null;
}

/** Run a script's work at the label it was given, or as it is when none was. */
export function runAtScriptLabel<T>(script: string, work: () => Promise<T>): Promise<T> {
  const label = scriptLabel();
  return label === null ? work() : runAtLabel(label, `the script ${script}`, work);
}
