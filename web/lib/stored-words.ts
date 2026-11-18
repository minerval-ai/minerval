// Words the API serves from a stored record or a signed package, in the
// words people now read (docs/releasing-a-page.md, "Old names in the code").
//
// What was called a showing is a release, and a party's release of a part is
// its consent. The fixed words a release's record is kept in (an act's
// `what`, a reason for a hold, an ending or a leaving, why a version is held)
// go into each package sent outside, so they change with the stored names,
// once, and not before: changing them sooner would build a new package for
// every node under every release outside. Until then the pages say them here,
// at the point of display.

/** An act's `what`, said whole. */
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

/** A fixed list of reasons (`hold_reasons`, `end_reasons`), each said as people now read it. */
export function storedList(reasons: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(reasons).map(([key, words]) => [key, storedWords(words)]));
}
