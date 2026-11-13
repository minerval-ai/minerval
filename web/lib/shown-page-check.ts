// The check of a page shown inside a deployment, redone in the reader's own
// browser (docs/showing-a-page.md, "The fingerprint"). It is the
// construction src/services/page-fingerprint.ts documents, written again
// with Web Crypto so that it runs where the reader is: every hash is the
// lowercase hex SHA-256 of a UTF-8 string.
//
//   commitment of a part = H("part\n" + salt + "\n" + marks + "\n" + text)
//   leaf of a part       = H("leaf\n" + position + "\n" + descriptor + "\n" + commitment)
//   inner node           = H("node\n" + left + "\n" + right), splitting n
//                          leaves at the largest power of two smaller than n
//   root                 = H("root\n" + FORMAT + "\n" + count + "\n" + top)
//
// A released part is checked against its own text; a held part is taken by
// the hash recorded for it, so its place and kind are checked and its
// content is not.

const FORMAT = "minerval-shown-page/1";

export interface PartToCheck {
  part: number;
  descriptor: string;
  hash: string;
  text?: string;
  removals_marked?: Array<{ at: number; category: string }>;
  salt?: string;
}

export interface PageToCheck {
  fingerprint: string | null;
  always_shown_as_hashed?: { text: string; salt: string; hash: string };
  parts?: PartToCheck[];
}

export interface ShownPageCheck {
  ok: boolean;
  released: number;
  held: number;
  problems: string[];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function top(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return sha256("empty");
  if (leaves.length === 1) return leaves[0]!;
  let split = 1;
  while (split * 2 < leaves.length) split *= 2;
  return sha256(`node\n${await top(leaves.slice(0, split))}\n${await top(leaves.slice(split))}`);
}

export async function checkShownPage(page: PageToCheck): Promise<ShownPageCheck> {
  const problems: string[] = [];
  let released = 0;
  let held = 0;
  const header = page.always_shown_as_hashed;
  if (!page.fingerprint || !header) {
    return { ok: false, released, held, problems: ["This page has not been shown, so there is nothing to check yet."] };
  }
  if ((await sha256(`part\n${header.salt}\n[]\n${header.text}`)) !== header.hash) {
    problems.push("What is always shown with the page (the verdict, coverage and the rest) does not match its hash.");
  }
  const leaves = [await sha256(`leaf\n0\nverdict\n${header.hash}`)];
  const parts = page.parts ?? [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.part !== i + 1) problems.push(`The part given in place ${i + 1} is recorded at place ${p.part}: the parts are out of order, or one is missing.`);
    if (typeof p.text === "string") {
      const marks = p.removals_marked ?? [];
      for (const m of marks) {
        if (!p.text.startsWith(`[redacted: ${m.category}]`, m.at)) {
          problems.push(`Part ${p.part} lists a removal marked "${m.category}" at a place where the text has no such mark.`);
        }
      }
      const commitment = await sha256(`part\n${p.salt ?? ""}\n${JSON.stringify(marks.map((m) => [m.at, m.category]))}\n${p.text}`);
      if (commitment !== p.hash) problems.push(`Part ${p.part} does not match its hash: its text, its marks or its salt is not what was recorded.`);
      released++;
    } else {
      held++;
    }
    leaves.push(await sha256(`leaf\n${p.part}\n${p.descriptor}\n${p.hash}`));
  }
  const root = await sha256(`root\n${FORMAT}\n${leaves.length}\n${await top(leaves)}`);
  if (root !== page.fingerprint) {
    problems.push("The parts do not rebuild the recorded fingerprint: a part was changed, moved, added or left out, or its kind is not the one recorded.");
  }
  return { ok: problems.length === 0, released, held, problems };
}
