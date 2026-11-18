// Old words in a record kept as it was said (docs/releasing-a-page.md, "Old
// names in the code").
//
// What was called a showing is a release, and a party's release of a part is
// its consent. The API now says a release's record in those words, from the
// codes it stores. What it cannot say anew is what was kept as said: a
// package signed before the change (on a published page, every act, reason
// and held-because it carries), the permissions a person held when they
// acted ("release for <party>"), and the words of a gate's setting stamped on
// what it let through. Those keep their old words, and the pages say them
// here in the new ones. New words pass through unchanged.

/** An act's `what` in a package signed before the change, said whole. */
const ACTS: Record<string, string> = {
  "asked for the showing": "asked for the release",
  "ended the showing": "ended the release",
  released: "consented",
  "the Redactor found that the page cannot be shown under the policy": "the Redactor found that the page cannot be released under the policy",
};

/** Fixed phrases that may stand inside a longer sentence. */
const PHRASES: Array<[string, string]> = [
  ["another showing replaces it", "another release replaces it"],
  ["the showing ended", "the release ended"],
  ["under the shown node", "under the released node"],
  ["not to be shown yet", "not to be released yet"],
  [
    "it cannot be shown under this boundary's policy: something that is always shown with a page could not be shown here",
    "it cannot be released under this boundary's policy: something that is always shown with a page could not be released here",
  ],
  ["the people who decide what is released", "the people who consent for its parties"],
  ["the people who hold release for the parties it rests on", "the people who consent for the parties it rests on"],
];

/** An act's `what` as people now read it. */
export function actWords(what: string): string {
  return ACTS[what] ?? what;
}

/** A reason, a held-because or an ending's because, as people now read it. */
export function storedWords(text: string): string;
export function storedWords(text: string | null | undefined): string | null | undefined;
export function storedWords(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  let out = text;
  for (const [stored, words] of PHRASES) out = out.split(stored).join(words);
  return out;
}

/** The permissions a person held when they acted, as the record keeps them: "release for <party>" is consent for it. */
export function holdingWords(holding: readonly string[]): string[] {
  return holding.map((h) => (h.startsWith("release for ") ? `consent for ${h.slice("release for ".length)}` : h === "release" ? "consent" : h));
}
