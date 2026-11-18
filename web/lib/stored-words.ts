// Old words in a signed package (docs/releasing-a-page.md, "Old names in the
// code").
//
// What was called a showing is a release, and a party's release of a part is
// its consent. The deployment's own records say so now: the codes, and the
// words kept as plain text, were renamed with the tables. A package signed
// before then cannot be: its signature is over its words, so every act,
// reason, held-because and holding it carries keeps the old ones. The claim
// page shows such packages, and says their words here in the new ones. New
// words pass through unchanged.

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

/** The permissions a person held when they acted, as a signed package keeps them: "release for <party>" is consent for it. */
export function holdingWords(holding: readonly string[]): string[] {
  return holding.map((h) => (h.startsWith("release for ") ? `consent for ${h.slice("release for ".length)}` : h === "release" ? "consent" : h));
}
