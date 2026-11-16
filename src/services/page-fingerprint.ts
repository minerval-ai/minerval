/**
 * The fingerprint of a shown page (docs/showing-a-page.md, "The fingerprint").
 *
 * When a Redactor finishes, each part of the page as it left it is hashed
 * with a salt of its own, and the hashes form a tree whose root is recorded
 * on the destination side at once, before anyone decides what is released.
 * A released part is then shown with its salt and a held part with its hash
 * and its kind. A reader rebuilds the root from what they were shown and
 * compares it with the root recorded earlier: a match says that every part
 * they read is what was written, with the marked removals inside it, that
 * the parts are in the order recorded, and that nothing was added or
 * dropped. It says nothing about what a held part contains.
 *
 * Nothing here reads a database or a clock, and nothing normalizes text: a
 * part is hashed as the exact characters recorded, encoded as UTF-8.
 * Markup, spacing and line ends are part of what was written.
 *
 * The construction, so that it can be redone with nothing but SHA-256.
 * Every hash is the lowercase hex SHA-256 of a UTF-8 string, and "\n" is
 * the one-character line feed.
 *
 *   commitment of a part  = H("part\n" + salt + "\n" + marks + "\n" + text)
 *     marks is JSON: [[offset, "category"], ...], the place of each
 *     "[redacted: category]" in `text`, in order, as written by
 *     JSON.stringify with no spaces. offset counts UTF-16 code units.
 *   leaf of a part        = H("leaf\n" + position + "\n" + descriptor + "\n" + commitment)
 *     position is the part's place on the page in decimal; the verdict and
 *     everything else that is always shown is position 0, descriptor
 *     "verdict", with no marks.
 *   inner node            = H("node\n" + left + "\n" + right)
 *     over the leaves in order of position, splitting n leaves at the
 *     largest power of two smaller than n, as RFC 6962 does.
 *   root                  = H("root\n" + FORMAT + "\n" + count + "\n" + top)
 *     count is the number of leaves in decimal.
 *
 * The salt keeps a short part (a verdict, a one-line paragraph) from being
 * guessed from its hash while it is held. The position and the descriptor
 * are in the leaf so that the kind and the place of a held part are checked
 * by the root too: "an argument against, held" cannot later be described as
 * something else.
 */
import { createHash, randomBytes } from "node:crypto";

export const FINGERPRINT_FORMAT = "minerval-shown-page/1";

/** The descriptor of the leaf that holds what is always shown. */
export const VERDICT_DESCRIPTOR = "verdict";

/** One removal's mark in a part's text: where it stands and the category it names. */
export interface Mark {
  at: number;
  category: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A new salt for one part: 32 random bytes in hex. */
export function newSalt(): string {
  return randomBytes(32).toString("hex");
}

/** The words that stand where a removal was made. They name the category and nothing else. */
export function markOf(category: string): string {
  return `[redacted: ${category}]`;
}

export function marksJson(marks: readonly Mark[]): string {
  return JSON.stringify(marks.map((m) => [m.at, m.category]));
}

export function partCommitment(salt: string, text: string, marks: readonly Mark[] = []): string {
  return sha256(`part\n${salt}\n${marksJson(marks)}\n${text}`);
}

export function leafHash(position: number, descriptor: string, commitment: string): string {
  return sha256(`leaf\n${position}\n${descriptor}\n${commitment}`);
}

function top(leaves: readonly string[]): string {
  if (leaves.length === 0) return sha256("empty");
  if (leaves.length === 1) return leaves[0]!;
  let split = 1;
  while (split * 2 < leaves.length) split *= 2;
  return sha256(`node\n${top(leaves.slice(0, split))}\n${top(leaves.slice(split))}`);
}

/** One leaf as the record keeps it: enough to rebuild the root without any text. */
export interface LeafRecord {
  position: number;
  descriptor: string;
  commitment: string;
}

/** The root over the leaves, which must be given in order of position starting at 0. */
export function pageRoot(leaves: readonly LeafRecord[]): string {
  const hashes = leaves.map((l) => leafHash(l.position, l.descriptor, l.commitment));
  return sha256(`root\n${FINGERPRINT_FORMAT}\n${leaves.length}\n${top(hashes)}`);
}

/** A part as a reader on the destination side is given it. */
export interface ShownPartForCheck extends LeafRecord {
  /** The text, its marks and its salt when the part was released; absent or null while it is held. */
  text?: string | null;
  marks?: readonly Mark[] | null;
  salt?: string | null;
}

export interface ShownPageForCheck {
  /** The root recorded when the Redactor finished. */
  root: string;
  /** The verdict leaf: position 0. Its text is the header exactly as shown. */
  verdict: ShownPartForCheck;
  /** The parts in the order they were given to the reader. */
  parts: readonly ShownPartForCheck[];
}

export interface Verification {
  ok: boolean;
  /** What did not hold, in words. Empty when `ok`. */
  problems: string[];
  /** How many parts were checked against their own text, and how many were held and taken by their hash. */
  checked: number;
  held: number;
}

/**
 * Check a shown page against the root recorded for it. Every released part
 * must hash to the commitment it is listed with, every mark must stand
 * where the record says, the parts must be in the order recorded with none
 * missing, and the leaves must rebuild the root.
 */
export function verifyShownPage(page: ShownPageForCheck): Verification {
  const problems: string[] = [];
  let checked = 0;
  let held = 0;

  const checkOne = (part: ShownPartForCheck, name: string) => {
    const released = typeof part.text === "string";
    if (!released) {
      held++;
      return;
    }
    if (typeof part.salt !== "string" || part.salt.length === 0) {
      problems.push(`${name} is shown without its salt, so it cannot be checked against its hash.`);
      return;
    }
    const marks = part.marks ?? [];
    for (const mark of marks) {
      if (!part.text!.startsWith(markOf(mark.category), mark.at)) {
        problems.push(`${name} lists a removal marked "${mark.category}" at a place where the text has no such mark.`);
      }
    }
    if (partCommitment(part.salt, part.text!, marks) !== part.commitment) {
      problems.push(`${name} does not match its hash: its text, its marks or its salt is not what was recorded.`);
    }
    checked++;
  };

  if (page.verdict.position !== 0 || page.verdict.descriptor !== VERDICT_DESCRIPTOR) {
    problems.push("The verdict is not in the first place of the page.");
  }
  checkOne(page.verdict, "The verdict");
  page.parts.forEach((part, i) => {
    if (part.position !== i + 1) {
      problems.push(
        `The part given in place ${i + 1} is recorded at place ${part.position}: the parts are out of order, or one is missing.`
      );
    }
    checkOne(part, `Part ${part.position}`);
  });

  const root = pageRoot([page.verdict, ...page.parts]);
  if (root !== page.root) {
    problems.push(
      "The parts do not rebuild the recorded root: a part was changed, moved, added or left out, or its kind is not the one recorded."
    );
  }
  return { ok: problems.length === 0, problems, checked, held };
}
