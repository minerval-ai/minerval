/**
 * Defining labels (src/labels.ts): the administrator's writes to `labels`
 * and `label_reads`.
 *
 * A label is a row and labels are not ranked. Which label reads which is
 * the pairs in label_reads, and adding a pair widens what every holder of
 * a label may read at once, so each change here is logged in the same
 * transaction (administrative_events). A label is never removed: rows
 * carry it. A pair can be, which only narrows.
 *
 * Reading the two tables for work in flight stays in label-service.ts.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { armEnforcement } from "../db/enforcement.js";
import { PUBLIC_LABEL } from "../labels.js";
import { logAdministrativeEvent } from "./permission-service.js";

/**
 * The labels and the pairs that say what each reads are the wall itself. A
 * connection held to a clearance may read them and may not write them
 * (db/clearance.ts): one that reads `public` alone must not be able to add
 * a pair and widen what everyone reads. So their administration is the
 * owner's connection's to do, once the route has checked the actor.
 */
const WALL_REASON =
  "A label and what it reads are the wall itself, so they are written on the owner's connection. The caller has checked that the actor may administer.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(WALL_REASON, fn);

/**
 * A label's name is written in settings and stamped on rows, so it is a
 * short lower-case word: letters, digits, hyphens and underscores,
 * starting with a letter.
 */
export const LABEL_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,62}$";
const LABEL_NAME_RE = new RegExp(LABEL_NAME_PATTERN);
export const LABEL_DESCRIPTION_MAX_CHARS = 500;

export interface LabelView {
  name: string;
  description: string;
  /** The labels a holder of this one may also read, as recorded: one step, not followed further. */
  reads: string[];
  created_at: string;
}

export async function listLabels(): Promise<LabelView[]> {
  const rows = await rawQuery<{ name: string; description: string; created_at: Date; reads: string[] | null }>(
    `SELECT l.name, l.description, l.created_at,
            (SELECT array_agg(lr.reads ORDER BY lr.reads) FROM label_reads lr WHERE lr.label = l.name) AS reads
       FROM labels l
      ORDER BY (l.name = $1) DESC, l.name`,
    [PUBLIC_LABEL]
  );
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    reads: r.reads ?? [],
    created_at: r.created_at.toISOString(),
  }));
}

export type LabelFailure =
  | "INVALID_NAME"
  | "INVALID_DESCRIPTION"
  | "LABEL_EXISTS"
  | "UNKNOWN_LABEL"
  | "PUBLIC_READS_NOTHING"
  | "READS_ITSELF"
  | "ALREADY_READS"
  | "NOT_READ";

type Outcome = { ok: true } | { ok: false; code: LabelFailure; message: string };

const refuse = (code: LabelFailure, message: string): Outcome => ({ ok: false, code, message });

/** Why a pair may not be recorded, or null when it may. */
function pairProblem(label: string, reads: string): Outcome | null {
  if (label === PUBLIC_LABEL) {
    return refuse(
      "PUBLIC_READS_NOTHING",
      `"${PUBLIC_LABEL}" reads no other label: whatever it read would be readable by everyone.`
    );
  }
  if (label === reads) return refuse("READS_ITSELF", "A label always reads itself; that needs no pair.");
  return null;
}

/**
 * Define a label, with the labels its holders may also read. The pairs are
 * recorded as given and nothing is added to them. A person's clearance
 * always includes `public` whatever the pairs say (src/permissions.ts).
 */
export async function defineLabel(input: {
  name: string;
  description: string;
  reads?: readonly string[];
  actorId: string;
}): Promise<Outcome> {
  const name = input.name.trim();
  if (!LABEL_NAME_RE.test(name)) {
    return refuse(
      "INVALID_NAME",
      "A label's name is a short lower-case word: letters, digits, hyphens and underscores, starting with a letter."
    );
  }
  // A connection's clearance is written as an array of names, where the
  // bare word null is no name at all: a label called that could not read
  // its own rows. The table refuses it too.
  if (name === "null") {
    return refuse("INVALID_NAME", 'A label cannot be named "null": the word means "no label" where a clearance is written.');
  }
  const description = input.description.trim();
  if (!description || description.length > LABEL_DESCRIPTION_MAX_CHARS) {
    return refuse(
      "INVALID_DESCRIPTION",
      `A label needs a description of at most ${LABEL_DESCRIPTION_MAX_CHARS} characters: what it is for and who should read it.`
    );
  }
  const reads = [...new Set((input.reads ?? []).map((r) => r.trim()).filter((r) => r.length > 0))];
  for (const read of reads) {
    const problem = pairProblem(name, read);
    if (problem) return problem;
  }
  // The database holds reads to a clearance from the moment a second label
  // exists. Before the first one is defined, that is turned on and every
  // process of the deployment is given time to notice (db/enforcement.ts),
  // so nothing can be written at the new label while any process still
  // reads unfiltered. It returns at once every other time.
  if (name !== PUBLIC_LABEL) await armEnforcement();
  return asOwner(() => withTransaction(async (tx): Promise<Outcome> => {
    const existing = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [name]);
    if (existing.length > 0) return refuse("LABEL_EXISTS", `A label named "${name}" is already defined.`);
    for (const read of reads) {
      const found = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [read]);
      if (found.length === 0) return refuse("UNKNOWN_LABEL", `This deployment defines no label named "${read}".`);
    }
    await tx.query(`INSERT INTO labels (name, description) VALUES ($1, $2)`, [name, description]);
    await logAdministrativeEvent(tx, "label_defined", input.actorId, { label: name });
    for (const read of reads) {
      await tx.query(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [name, read]);
      await logAdministrativeEvent(tx, "label_read_added", input.actorId, { label: name, reads: read });
    }
    return { ok: true };
  }));
}

/** Record that holders of `label` may also read `reads`. */
export async function addLabelRead(input: { label: string; reads: string; actorId: string }): Promise<Outcome> {
  const label = input.label.trim();
  const reads = input.reads.trim();
  const problem = pairProblem(label, reads);
  if (problem) return problem;
  return asOwner(() => withTransaction(async (tx): Promise<Outcome> => {
    for (const name of [label, reads]) {
      const found = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [name]);
      if (found.length === 0) return refuse("UNKNOWN_LABEL", `This deployment defines no label named "${name}".`);
    }
    const inserted = await tx.query(
      `INSERT INTO label_reads (label, reads) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING label`,
      [label, reads]
    );
    if (inserted.length === 0) return refuse("ALREADY_READS", `"${label}" already reads "${reads}".`);
    await logAdministrativeEvent(tx, "label_read_added", input.actorId, { label, reads });
    return { ok: true };
  }));
}

/** Take back a pair: holders of `label` no longer read `reads` through it. */
export async function removeLabelRead(input: { label: string; reads: string; actorId: string }): Promise<Outcome> {
  const label = input.label.trim();
  const reads = input.reads.trim();
  return asOwner(() => withTransaction(async (tx): Promise<Outcome> => {
    const deleted = await tx.query(
      `DELETE FROM label_reads WHERE label = $1 AND reads = $2 RETURNING label`,
      [label, reads]
    );
    if (deleted.length === 0) return refuse("NOT_READ", `"${label}" does not read "${reads}".`);
    await logAdministrativeEvent(tx, "label_read_removed", input.actorId, { label, reads });
    return { ok: true };
  }));
}
