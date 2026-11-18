/**
 * The fingerprint of a shown page (docs/releasing-a-page.md, "The fingerprint").
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
 *   commitment of a part  = H("part\n" + salt + "\n" + marks + "\n" + refs + "\n" + text)
 *     marks is JSON: [[offset, "category"], ...], the place of each
 *     "[redacted: category]" in `text`, in order, as written by
 *     JSON.stringify with no spaces. offset counts UTF-16 code units.
 *     refs is JSON: ["<id>", ...], the public graph's ids of the nodes the
 *     part cites that the public graph holds (a subclaim's child, an
 *     argument's premises), in order, as written by JSON.stringify; "[]"
 *     where there are none, and for what is always shown. Inside the
 *     commitment, a held part says nothing of what it cites, and a released
 *     one cannot be made to cite another node. Under the two constructions
 *     before "minerval-released-page/3" there is no refs line.
 *   leaf of a part        = H("leaf\n" + position + "\n" + descriptor + "\n" + commitment)
 *     position is the part's place on the page in decimal; the verdict and
 *     everything else that is always shown is position 0, descriptor
 *     "verdict", with no marks.
 *   inner node            = H("node\n" + left + "\n" + right)
 *     over the leaves in order of position, splitting n leaves at the
 *     largest power of two smaller than n, as RFC 6962 does.
 *   root                  = H("root\n" + FORMAT + "\n" + count + "\n" + top)
 *     count is the number of leaves in decimal, and FORMAT is the
 *     construction's name, which the page's record keeps beside its root
 *     (`fingerprint_format`): "minerval-released-page/3" for a page recorded
 *     now; "minerval-released-page/2" for one recorded before parts carried
 *     refs, which has no refs line; "minerval-shown-page/1" for one recorded
 *     before the name changed, which differs from /2 in its name alone. A
 *     root is rebuilt under the name its record gives, never under each in
 *     turn.
 *
 * The salt keeps a short part (a verdict, a one-line paragraph) from being
 * guessed from its hash while it is held. The position and the descriptor
 * are in the leaf so that the kind and the place of a held part are checked
 * by the root too: "an argument against, held" cannot later be described as
 * something else.
 */
import { createHash, randomBytes } from "node:crypto";

/** The construction a page recorded now is fingerprinted under: a part's commitment covers the public ids it cites. */
export const FINGERPRINT_FORMAT = "minerval-released-page/3";
/** The construction before parts carried refs, for the pages recorded under it. */
export const FINGERPRINT_FORMAT_2 = "minerval-released-page/2";
/** The construction before the name changed (docs/releasing-a-page.md, "Old names in the code"). */
export const FINGERPRINT_FORMAT_1 = "minerval-shown-page/1";
export const FINGERPRINT_FORMATS: readonly string[] = [FINGERPRINT_FORMAT, FINGERPRINT_FORMAT_2, FINGERPRINT_FORMAT_1];
export type FingerprintFormat = typeof FINGERPRINT_FORMAT | typeof FINGERPRINT_FORMAT_2 | typeof FINGERPRINT_FORMAT_1;
export const isFingerprintFormat = (f: unknown): f is FingerprintFormat => typeof f === "string" && FINGERPRINT_FORMATS.includes(f);

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

export function refsJson(refs: readonly string[]): string {
  return JSON.stringify([...refs]);
}

/**
 * A part's commitment under the construction its page is recorded under.
 * Under "minerval-released-page/3" it covers the public ids the part cites;
 * under the constructions before it there is no refs line, and `refs` must
 * be empty, since nothing recorded then carried any.
 */
export function partCommitment(
  salt: string,
  text: string,
  marks: readonly Mark[] = [],
  refs: readonly string[] = [],
  format: FingerprintFormat = FINGERPRINT_FORMAT
): string {
  if (format === FINGERPRINT_FORMAT) return sha256(`part\n${salt}\n${marksJson(marks)}\n${refsJson(refs)}\n${text}`);
  if (refs.length > 0) throw new Error(`A part recorded under "${format}" carries no refs.`);
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

/** The root over the leaves, which must be given in order of position starting at 0, under the construction the page's record names. */
export function pageRoot(leaves: readonly LeafRecord[], format: FingerprintFormat): string {
  if (!isFingerprintFormat(format)) throw new Error(`No fingerprint is made under "${String(format)}".`);
  const hashes = leaves.map((l) => leafHash(l.position, l.descriptor, l.commitment));
  return sha256(`root\n${format}\n${leaves.length}\n${top(hashes)}`);
}

/** A part as a reader on the destination side is given it. */
export interface ReleasedPartForCheck extends LeafRecord {
  /** The text, its marks and its salt when the part was released; absent or null while it is held. */
  text?: string | null;
  marks?: readonly Mark[] | null;
  salt?: string | null;
  /** The public ids the part cites, released with its text (FINGERPRINT_FORMAT only). */
  refs?: readonly string[] | null;
}

export interface ReleasedPageForCheck {
  /** The root recorded when the Redactor finished. */
  root: string;
  /** The construction the root was recorded under, as the page's record names it. */
  format: string;
  /** The verdict leaf: position 0. Its text is the header exactly as shown. */
  verdict: ReleasedPartForCheck;
  /** The parts in the order they were given to the reader. */
  parts: readonly ReleasedPartForCheck[];
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
export function verifyReleasedPage(page: ReleasedPageForCheck): Verification {
  const problems: string[] = [];
  let checked = 0;
  let held = 0;

  const checkOne = (part: ReleasedPartForCheck, name: string) => {
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
    const refs = part.refs ?? [];
    if (format !== FINGERPRINT_FORMAT && refs.length > 0) {
      problems.push(`${name} cites nodes, which a page recorded under "${format}" cannot.`);
    } else if (partCommitment(part.salt, part.text!, marks, refs, format) !== part.commitment) {
      problems.push(`${name} does not match its hash: its text, its marks, the nodes it cites or its salt is not what was recorded.`);
    }
    checked++;
  };

  if (!isFingerprintFormat(page.format)) {
    problems.push(`The page's fingerprint is recorded under "${page.format}", a construction this check does not know.`);
    return { ok: false, problems, checked, held };
  }
  const format: FingerprintFormat = page.format;

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

  const root = pageRoot([page.verdict, ...page.parts], format);
  if (root !== page.root) {
    problems.push(
      "The parts do not rebuild the recorded root: a part was changed, moved, added or left out, or its kind is not the one recorded."
    );
  }
  return { ok: problems.length === 0, problems, checked, held };
}
