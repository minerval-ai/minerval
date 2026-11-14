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
  | "NOT_READ"
  | "INVALID_FACE"
  | "FACE_NOT_BELOW"
  | "NO_FACE";

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

/** The longest a face's name and its line may be. */
export const FACE_NAME_MAX_CHARS = 80;
export const FACE_LINE_MAX_CHARS = 500;

export interface LabelFaceView {
  id: string;
  /** The label whose work can be asked for. */
  label: string;
  /** The label the face is shown at: it, and every label that reads it, may ask. */
  shown_at: string;
  name: string;
  can_be_asked: string;
  withdrawn: boolean;
}

/** Every face, for the administrators' page. */
export async function listLabelFaces(): Promise<LabelFaceView[]> {
  return asOwner(() =>
    rawQuery<LabelFaceView>(
      `SELECT id, for_label AS label, sensitivity_label AS shown_at, name, can_be_asked, (withdrawn_at IS NOT NULL) AS withdrawn
         FROM label_faces ORDER BY for_label, sensitivity_label`
    )
  );
}

/**
 * Give a label a public face at a label it reads: a name and a line saying
 * what can be asked of it. From then on, work can be asked of it from that
 * label and from every label that reads that label, by people and runs who
 * do not read it (services/ask-above-service.ts). That the label can be
 * asked is itself something shown below, which is why it is an
 * administrator's act and off until one makes it. Showing a face again
 * replaces its words.
 */
export async function showLabelFace(input: {
  label: string;
  at: string;
  name: string;
  canBeAsked: string;
  actorId: string;
}): Promise<Outcome | { ok: true; id: string }> {
  const label = input.label.trim();
  const at = input.at.trim();
  const name = input.name.trim();
  const line = input.canBeAsked.trim();
  if (!name || name.length > FACE_NAME_MAX_CHARS || !line || line.length > FACE_LINE_MAX_CHARS) {
    return refuse(
      "INVALID_FACE",
      `A face is a name of at most ${FACE_NAME_MAX_CHARS} characters and a line of at most ${FACE_LINE_MAX_CHARS} saying what can be asked.`
    );
  }
  return asOwner(() => withTransaction(async (tx): Promise<Outcome | { ok: true; id: string }> => {
    for (const l of [label, at]) {
      const found = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [l]);
      if (found.length === 0) return refuse("UNKNOWN_LABEL", `This deployment defines no label named "${l}".`);
    }
    // Shown below, never across or above: the label asked reads the label
    // it is shown at, so everything an asker there can say is readable to
    // the work it asks for.
    const [below] = await tx.query<{ ok: boolean }>(`SELECT minerval_layer_below($1, 'local', $2, 'local') AS ok`, [at, label]);
    if (label === at || !below?.ok) {
      return refuse("FACE_NOT_BELOW", `"${label}" does not read "${at}", so it cannot be asked from there: work asked for is done with what its asker's label holds.`);
    }
    // One face for each label at each label it is shown at; showing it
    // again replaces its words, by whoever administers now.
    const [existing] = await tx.query<{ id: string }>(
      `UPDATE label_faces SET name = $3, can_be_asked = $4, written_by = $5, withdrawn_at = NULL, updated_at = now()
        WHERE for_label = $1 AND sensitivity_label = $2 RETURNING id`,
      [label, at, name, line, input.actorId]
    );
    const row =
      existing ??
      (
        await tx.query<{ id: string }>(
          `INSERT INTO label_faces (for_label, name, can_be_asked, written_by, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [label, name, line, input.actorId, at]
        )
      )[0];
    await logAdministrativeEvent(tx, "label_face_shown", input.actorId, { label, at });
    return { ok: true, id: row!.id };
  }));
}

/** Withdraw a label's face at a label: nothing new can be asked of it from there. What was asked stays as it is. */
export async function withdrawLabelFace(input: { label: string; at: string; actorId: string }): Promise<Outcome> {
  return asOwner(() => withTransaction(async (tx): Promise<Outcome> => {
    const gone = await tx.query(
      `UPDATE label_faces SET withdrawn_at = now(), updated_at = now()
        WHERE for_label = $1 AND sensitivity_label = $2 AND withdrawn_at IS NULL RETURNING id`,
      [input.label.trim(), input.at.trim()]
    );
    if (gone.length === 0) return refuse("NO_FACE", `"${input.label}" has no face shown at "${input.at}".`);
    await logAdministrativeEvent(tx, "label_face_withdrawn", input.actorId, { label: input.label.trim(), at: input.at.trim() });
    return { ok: true };
  }));
}
